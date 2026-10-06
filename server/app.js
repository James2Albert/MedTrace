const path = require('path')
const express = require('express')
const { Store } = require('./store')
const { Chain } = require('./chain')
const { Wallets } = require('./wallets')
const { EvidenceStore } = require('./evidence')
const { CustodyService } = require('./custody/service')
const { buildExceptions } = require('./custody/exceptions')
const { createAuth } = require('./auth')
const { createEvidenceLinks } = require('./evidenceLinks')
const { MockElmisSource } = require('./integrations/elmis/mockSource')
const { createElmisIntegration } = require('./integrations/elmis')
const { simulateReadings } = require('./coldchain')
const qr = require('./qr')
const { seed, DEMO_USERS } = require('./seed')

/** Wires the services together. Used by the HTTP server, the seed script and tests. */
function createServices (config) {
  const store = new Store(config.dataDir)
  const chain = new Chain(config)
  if (store.data.meta.chain && store.data.meta.chain.custodyAddress) chain.attach(store.data.meta.chain.custodyAddress)
  const wallets = new Wallets(config.walletMnemonic)
  const evidence = new EvidenceStore(config)
  const links = createEvidenceLinks(config)
  const custody = new CustodyService({ store, chain, wallets, evidence, config, links })
  const elmisSource = new MockElmisSource(store)
  const elmis = createElmisIntegration({ source: elmisSource, custody, store })
  const auth = createAuth(store, config)
  return { config, store, chain, wallets, evidence, links, custody, elmis, elmisSource, auth }
}

function createApp (services) {
  const { config, store, chain, evidence, links, custody, elmis, auth } = services
  const app = express()
  app.disable('x-powered-by')

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      // Evidence links carry a signature in the query string: never leak them via Referer.
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin'
    })
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store')
    next()
  })

  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch(err => {
    const status = err.status || 500
    if (status >= 500 && status !== 503) console.error(err)
    if (err.extra && err.extra.retryAfter) res.set('Retry-After', String(err.extra.retryAfter))
    res.status(status).json({ error: status === 500 ? 'Unexpected server error' : err.message, code: err.code || 'ERROR', ...(err.extra || {}) })
  })
  const json = express.json({ limit: '64kb' })
  const signedIn = auth.middleware
  const role = auth.requireRole
  const idem = (req) => req.get('Idempotency-Key') || null
  const demoOnly = (req, res, next) => config.demoMode ? next() : res.status(404).json({ error: 'Available in demo mode only', code: 'NOT_FOUND' })

  // ------------------------------------------------------------ public

  app.get('/api/health', wrap(async (req, res) => {
    const [ledger, ipfs] = await Promise.all([chain.status(), evidence.status()])
    res.json({
      ok: ledger.connected && ledger.contractDeployed,
      ledger: { connected: ledger.connected, contractDeployed: Boolean(ledger.contractDeployed), blockNumber: ledger.blockNumber },
      ipfs: { mode: ipfs.mode, reachable: ipfs.reachable },
      demoMode: config.demoMode
    })
  }))

  app.post('/api/login', json, wrap(async (req, res) => {
    res.json(auth.login(req.body.username, req.body.pin, req.ip))
  }))

  // ------------------------------------------------------------ evidence (photos, temperature logs)

  const canViewEvidence = (user, cid) => store.data.evidence
    .filter(e => e.cid === cid)
    .some(e => {
      const s = store.shipment(e.shipmentId)
      return s && (user.role !== 'clinic' || s.destinationFacilityCode === user.facilityCode)
    })

  // Accepts a bearer token or a short-lived signed link. Integrity is re-checked on every read.
  app.get('/api/evidence/:cid', wrap(async (req, res) => {
    const cid = req.params.cid
    let user = null
    if (req.headers.authorization) {
      user = auth.userForToken(req.headers.authorization.replace(/^Bearer\s+/i, ''))
    } else {
      const uid = links.verify(cid, req.query)
      user = uid && store.user(uid)
    }
    if (!user) return res.status(401).json({ error: 'This evidence link has expired or is not valid. Reopen the shipment to get a new one.', code: 'EVIDENCE_LINK_INVALID' })
    if (!canViewEvidence(user, cid)) return res.status(403).json({ error: 'You are not authorised to view this evidence.', code: 'FORBIDDEN' })
    const { buffer, source } = await evidence.get(cid)
    const entry = store.data.evidence.find(e => e.cid === cid)
    res.set({
      'Content-Type': entry.mimeType,
      'Cache-Control': 'private, no-store',
      'Content-Disposition': 'inline',
      'X-Evidence-Verified': 'sha256-matches-cid',
      'X-Evidence-Source': source
    })
    res.send(buffer)
  }))

  // ------------------------------------------------------------ session

  app.post('/api/logout', signedIn, wrap(async (req, res) => {
    auth.logout(req.token)
    res.json({ ok: true })
  }))

  app.get('/api/me', signedIn, wrap(async (req, res) => res.json(auth.publicUser(req.user))))

  app.get('/api/facilities', signedIn, wrap(async (req, res) => res.json(store.data.facilities)))

  // ------------------------------------------------------------ shipments

  app.get('/api/shipments', signedIn, wrap(async (req, res) => {
    let list = store.data.shipments
    if (req.user.role === 'clinic') list = list.filter(s => s.destinationFacilityCode === req.user.facilityCode)
    res.json(list.slice().reverse().map(s => custody.summary(s, req.user)))
  }))

  // Clinics only ever see shipments addressed to their own facility.
  const visibleShipment = (req) => {
    const shipment = custody.get(req.params.id)
    if (req.user.role === 'clinic' && shipment.destinationFacilityCode !== req.user.facilityCode) {
      const err = new Error('This shipment is addressed to a different facility.')
      err.status = 403
      err.code = 'WRONG_FACILITY'
      throw err
    }
    return shipment
  }

  app.get('/api/shipments/:id', signedIn, wrap(async (req, res) => {
    res.json(custody.detail(visibleShipment(req), req.user))
  }))

  app.get('/api/shipments/:id/ledger', signedIn, role('dispatcher', 'auditor'), wrap(async (req, res) => {
    visibleShipment(req)
    res.json(await custody.ledgerCheck(req.params.id))
  }))

  app.post('/api/shipments/:id/reconcile', signedIn, role('dispatcher', 'auditor'), wrap(async (req, res) => {
    visibleShipment(req)
    const report = await custody.reconcileShipment(req.params.id)
    res.json({ report, shipment: custody.detail(custody.get(req.params.id), req.user) })
  }))

  app.post('/api/reconcile', signedIn, role('auditor'), wrap(async (req, res) => {
    res.json(await custody.reconcileAll())
  }))

  app.get('/api/shipments/:id/packages/:no/qr.svg', signedIn, role('dispatcher', 'auditor'), wrap(async (req, res) => {
    const pkg = custody.get(req.params.id).packages.find(p => p.packageNo === Number(req.params.no))
    if (!pkg) return res.status(404).json({ error: 'Package not found' })
    res.type('image/svg+xml').send(qr.svg(pkg.code))
  }))

  app.post('/api/shipments/:id/dispatch', signedIn, json, wrap(async (req, res) => {
    const s = await custody.dispatch(req.user, req.params.id, req.body, idem(req))
    res.json(custody.detail(s, req.user))
  }))

  app.post('/api/shipments/:id/depart', signedIn, json, wrap(async (req, res) => {
    const s = await custody.depart(req.user, req.params.id, req.body, idem(req))
    res.json(custody.detail(s, req.user))
  }))

  app.post('/api/scan', signedIn, json, wrap(async (req, res) => {
    const out = await custody.scan(req.user, req.body.code, { expectShipmentId: req.body.expectShipmentId })
    res.json({ result: out.result, packageNo: out.packageNo, shipment: custody.detail(out.shipment, req.user) })
  }))

  app.post('/api/shipments/:id/evidence', signedIn,
    express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '1mb' }),
    wrap(async (req, res) => {
      if (!Buffer.isBuffer(req.body)) return res.status(415).json({ error: 'Send the photo as image/jpeg, image/png or image/webp', code: 'EVIDENCE_INVALID' })
      const entry = await custody.addEvidence(req.user, req.params.id, req.body, req.headers['content-type'].split(';')[0])
      res.json({ cid: entry.cid, sha256: entry.sha256, size: entry.size, storage: entry.storage, pinned: entry.pinned, url: links.sign(entry.cid, req.user.id) })
    }))

  app.post('/api/shipments/:id/receipt/preview', signedIn, json, wrap(async (req, res) => {
    res.json(await custody.previewReceipt(req.user, req.params.id, req.body))
  }))

  app.post('/api/shipments/:id/receipt', signedIn, json, wrap(async (req, res) => {
    const s = await custody.confirmReceipt(req.user, req.params.id, req.body, idem(req))
    res.json(custody.detail(s, req.user))
  }))

  app.post('/api/shipments/:id/dispute', signedIn, json, wrap(async (req, res) => {
    const s = await custody.dispute(req.user, req.params.id, req.body, idem(req))
    res.json(custody.detail(s, req.user))
  }))

  app.post('/api/shipments/:id/investigate', signedIn, json, wrap(async (req, res) => {
    const s = await custody.investigate(req.user, req.params.id, req.body, idem(req))
    res.json(custody.detail(s, req.user))
  }))

  app.post('/api/shipments/:id/resolve', signedIn, json, wrap(async (req, res) => {
    const s = await custody.resolve(req.user, req.params.id, req.body, idem(req))
    res.json(custody.detail(s, req.user))
  }))

  // ------------------------------------------------------------ cold chain

  // A data-logger upload: { source: 'LOGGER', deviceId, readings: [{ at, c }] }.
  app.post('/api/shipments/:id/temperature', signedIn, express.json({ limit: '256kb' }), wrap(async (req, res) => {
    visibleShipment(req)
    if (req.body.source === 'SIMULATED') return res.status(400).json({ error: 'Simulated readings are only created by the demo simulator', code: 'BAD_REQUEST' })
    const s = await custody.attachTemperatureLog(req.user, req.params.id, req.body)
    res.json(custody.detail(s, req.user))
  }))

  // DEMO ONLY: generates a clearly labelled SIMULATED logger record (profile: normal | excursion).
  app.post('/api/shipments/:id/temperature/simulate', signedIn, role('dispatcher'), demoOnly, json, wrap(async (req, res) => {
    const shipment = custody.get(req.params.id)
    if (!shipment.coldChain) return res.status(400).json({ error: 'This item has no temperature requirement', code: 'BAD_REQUEST' })
    const readings = simulateReadings({ profile: req.body.profile, range: shipment.coldChain })
    const s = await custody.attachTemperatureLog(req.user, req.params.id, { source: 'SIMULATED', deviceId: `SIM-${req.body.profile}`, readings })
    res.json(custody.detail(s, req.user))
  }))

  // ------------------------------------------------------------ audit

  app.get('/api/exceptions', signedIn, role('auditor', 'dispatcher'), wrap(async (req, res) => {
    res.json(await buildExceptions({ store, custody, evidence, config }))
  }))

  // Printable labels for the judged demo scenarios, plus a deliberately forged label.
  app.get('/api/demo-kit', signedIn, role('dispatcher', 'auditor'), demoOnly, wrap(async (req, res) => {
    const scenarios = (store.data.meta.demo || []).map(d => {
      const shipment = store.shipment(d.shipmentId)
      return shipment ? { ...d, shipment: custody.detail(shipment, req.user) } : null
    }).filter(Boolean)
    const a = scenarios.find(s => s.key === 'A')
    let forged = null
    if (a) {
      const real = a.shipment.packages[0].code
      const code = real.slice(0, -1) + (real.endsWith('0') ? '1' : '0')
      forged = { code, qr: qr.svg(code), basedOn: a.shipment.id }
    }
    res.json({
      scenarios: scenarios.map(s => ({ ...s, qr: s.shipment.packages.map(p => qr.svg(p.code)) })),
      forged
    })
  }))

  // ------------------------------------------------------------ demo mode only (synthetic data)

  // Guided scenarios for the demo hub: the printed label and what the physical seal reads.
  app.get('/api/demo/scenarios', demoOnly, wrap(async (req, res) => {
    res.json((store.data.meta.demo || []).map(d => {
      const s = store.shipment(d.shipmentId)
      if (!s) return null
      return {
        key: d.key,
        scenario: d.scenario,
        guide: d.guide,
        instructions: d.instructions,
        shipment: { id: s.id, state: s.state, stateLabel: custody.summary(s).stateLabel, commodity: s.commodity.name, quantity: s.quantity, unit: s.unit, batch: s.batch, destination: (store.facility(s.destinationFacilityCode) || {}).name },
        packages: s.packages.map((p, i) => ({
          packageNo: p.packageNo,
          code: p.code,
          qr: qr.svg(p.code),
          // The seal physically on the package (B: replaced in transit). Before dispatch, the seal the guide asks dispatch to apply.
          seal: (d.physicalSeals && d.physicalSeals[i]) || p.sealNumber || null,
          plannedSeal: (d.plannedSeals && d.plannedSeals[i]) || null
        }))
      }
    }).filter(Boolean))
  }))

  // Enter a role without a PIN. Demo mode only: synthetic accounts on a local test chain.
  const DEMO_ROLE_USERS = { dispatcher: 'msd.dispatch', clinic: 'chanika.clinic', clinic2: 'mzinga.clinic', auditor: 'district.auditor' }
  app.post('/api/demo/session', demoOnly, json, wrap(async (req, res) => {
    const username = DEMO_ROLE_USERS[req.body.role]
    const user = username && DEMO_USERS.some(u => u.username === username) && store.data.users.find(u => u.username === username)
    if (!user) return res.status(400).json({ error: 'Unknown demo role', code: 'BAD_REQUEST' })
    res.json(auth.issue(user, 4))
  }))

  // Restores the demo to its starting point: redeploys contracts and reseeds. Demo mode only.
  let resetting = null
  app.post('/api/demo/reset', demoOnly, wrap(async (req, res) => {
    if (!resetting) {
      resetting = seed(services, { log: () => {} }).finally(() => { resetting = null })
    }
    await resetting
    res.json({ ok: true, scenarios: (store.data.meta.demo || []).length })
  }))

  // ------------------------------------------------------------ MSD / eLMIS adapter

  app.get('/api/integrations/elmis/pending', signedIn, role('dispatcher'), wrap(async (req, res) => {
    res.json(await elmis.listPending())
  }))

  app.post('/api/integrations/elmis/import', signedIn, role('dispatcher'), json, wrap(async (req, res) => {
    const created = await elmis.importById(req.body.externalId, req.user)
    res.json(created.map(s => custody.summary(s, req.user)))
  }))

  // Push model: an eLMIS/MSD system posts a shipment payload directly.
  app.post('/api/integrations/elmis/shipments', signedIn, role('dispatcher'), express.json({ limit: '256kb' }), wrap(async (req, res) => {
    const created = await elmis.ingest(req.body, req.user)
    res.status(201).json(created.map(s => custody.summary(s, req.user)))
  }))

  app.get('/api/integrations/elmis/shipments/:externalId/pod', signedIn, role('dispatcher', 'auditor'), wrap(async (req, res) => {
    const status = elmis.statusFor(req.params.externalId)
    if (!status) return res.status(404).json({ error: 'No MedTrace consignments for this eLMIS shipment', code: 'NOT_FOUND' })
    res.json(status)
  }))

  // ------------------------------------------------------------ static

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' }))
  app.use('/contracts', express.static(config.buildDir))
  app.use('/legacy', express.static(path.join(config.root, 'src')))
  app.use(express.static(path.join(config.root, 'web')))

  return app
}

module.exports = { createServices, createApp }
