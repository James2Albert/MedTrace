const fs = require('fs')
const os = require('os')
const net = require('net')
const path = require('path')
const ganache = require('ganache')
const { load } = require('../../server/config')
const { createServices, createApp } = require('../../server/app')
const { seed } = require('../../server/seed')

// Smallest valid JPEG header + payload; content is irrelevant, only the magic bytes are checked.
const JPEG = (tag = 'photo') => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`medtrace-test-${tag}-${Math.random()}`)])

function freePort () {
  return new Promise(resolve => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

async function startStack (overrides = {}) {
  const chainPort = await freePort()
  const node = ganache.server({ logging: { quiet: true }, wallet: { deterministic: true }, chain: { chainId: 1337, networkId: 5777 } })
  await new Promise((resolve, reject) => node.listen(chainPort, '127.0.0.1', e => e ? reject(e) : resolve()))
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medtrace-test-'))
  const config = load({ rpcUrl: `http://127.0.0.1:${chainPort}`, dataDir, ipfsApiUrl: '', demoMode: true, ...overrides })
  const services = createServices(config)
  await seed(services, { writeArtifacts: false, log: () => {} })
  const server = await listen(createApp(services))

  const stack = {
    node,
    config,
    services,
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    async api (method, url, { token, body, raw, type, headers: extra } = {}) {
      const headers = { ...(extra || {}) }
      if (token) headers.Authorization = `Bearer ${token}`
      let payload
      if (raw) {
        payload = raw
        headers['Content-Type'] = type || 'image/jpeg'
      } else if (body !== undefined) {
        payload = JSON.stringify(body)
        headers['Content-Type'] = 'application/json'
      }
      const res = await fetch(stack.base + url, { method, headers, body: payload })
      const ct = res.headers.get('content-type') || ''
      const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer())
      return { status: res.status, data, headers: res.headers }
    },
    async login (username, pin) {
      const r = await stack.api('POST', '/api/login', { body: { username, pin } })
      if (r.status !== 200) throw new Error(`login failed for ${username}`)
      return r.data.token
    },
    /** Full clinic receipt through the API: scan every package, upload a photo, confirm. */
    async receive (token, id, answers = {}) {
      const s = services.store.shipment(id)
      for (const p of s.packages) {
        const r = await stack.api('POST', '/api/scan', { token, body: { code: p.code, expectShipmentId: id } })
        if (r.status !== 200) throw new Error(`scan failed: ${JSON.stringify(r.data)}`)
      }
      const ev = await stack.api('POST', `/api/shipments/${id}/evidence`, { token, raw: JPEG(id) })
      if (ev.status !== 200) throw new Error(`photo failed: ${JSON.stringify(ev.data)}`)
      const body = {
        packages: s.packages.map(p => ({ packageNo: p.packageNo, seal: 'INTACT', sealNumber: p.sealNumber })),
        batchMatches: true,
        condition: 'GOOD',
        quantityReceived: s.quantity,
        evidenceCid: ev.data.cid,
        ...answers
      }
      const preview = await stack.api('POST', `/api/shipments/${id}/receipt/preview`, { token, body })
      const done = await stack.api('POST', `/api/shipments/${id}/receipt`, { token, body })
      return { preview, done, evidence: ev.data }
    },
    shipmentByKey (key) {
      const d = (services.store.data.meta.demo || []).find(x => x.key === key)
      return d && services.store.shipment(d.shipmentId)
    },
    shipmentByOrder (orderCode, lineNo = 1) {
      return services.store.data.shipments.find(s => s.externalRef.orderCode === orderCode && s.externalRef.lineNo === lineNo)
    },
    async stop () {
      await new Promise(resolve => server.close(resolve))
      await node.close()
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  }
  return stack
}

function listen (app) {
  return new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
}

module.exports = { startStack, freePort, listen, JPEG }
