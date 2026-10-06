// End-to-end tests through the HTTP API against a real (in-process) Ganache chain.
const fs = require('fs')
const path = require('path')
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { startStack, JPEG } = require('./helpers')
const { createServices } = require('../../server/app')
const { tokenKey } = require('../../server/auth')
const { seed } = require('../../server/seed')

const ORDER_A = 'ORD-MSD-DSM-2026-10-0412' // Chanika, normal delivery
const ORDER_B = 'ORD-MSD-DSM-2026-10-0413' // Chanika, tampered delivery
const ORDER_MZ = 'ORD-MSD-DSM-2026-10-0419' // Mzinga
const ORDER_NEW = 'ORD-MSD-DSM-2026-10-0427' // Chanika, CREATED, 2 packages
const PENDING_ELMIS = '6a0f5c1e-3b47-4f0e-9d2a-1c8e7b5a9005'

let stack, tokens

const state = async (id) => (await stack.api('GET', `/api/shipments/${id}`, { token: tokens.auditor })).data.state

async function photo (token, id, tag) {
  const r = await stack.api('POST', `/api/shipments/${id}/evidence`, { token, raw: JPEG(tag) })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  return r.data
}

before(async () => {
  stack = await startStack()
  tokens = {
    dispatcher: await stack.login('msd.dispatch', '1111'),
    chanika: await stack.login('chanika.clinic', '2222'),
    mzinga: await stack.login('mzinga.clinic', '3333'),
    auditor: await stack.login('district.auditor', '4444')
  }
})
after(() => stack.stop())

test('login rejects a wrong PIN and unauthenticated calls', async () => {
  assert.equal((await stack.api('POST', '/api/login', { body: { username: 'chanika.clinic', pin: '9999' } })).status, 401)
  assert.equal((await stack.api('GET', '/api/shipments')).status, 401)
  const me = await stack.api('GET', '/api/me', { token: tokens.chanika })
  assert.equal(me.data.facility.name, 'Chanika Health Centre')
  assert.equal(me.data.address, undefined, 'wallet address must not be exposed to clinic users')
})

test('clinic only sees shipments for its own facility', async () => {
  const list = (await stack.api('GET', '/api/shipments', { token: tokens.chanika })).data
  assert.ok(list.length >= 3)
  assert.ok(list.every(s => s.destination.code === 'HFR-105611'))
  const mz = stack.shipmentByOrder(ORDER_MZ)
  assert.equal((await stack.api('GET', `/api/shipments/${mz.id}`, { token: tokens.chanika })).status, 403)
})

test('wrong QR: garbage, forged signature and unknown shipment are refused', async () => {
  const a = stack.shipmentByOrder(ORDER_A)
  let r = await stack.api('POST', '/api/scan', { token: tokens.chanika, body: { code: 'https://example.com/not-a-label' } })
  assert.equal(r.status, 422)
  assert.equal(r.data.code, 'INVALID_CODE')

  const forged = a.packages[0].code.slice(0, -1) + (a.packages[0].code.endsWith('A') ? 'B' : 'A')
  r = await stack.api('POST', '/api/scan', { token: tokens.chanika, body: { code: forged } })
  assert.equal(r.status, 422)
  assert.equal(r.data.code, 'LABEL_TAMPERED')

  r = await stack.api('POST', '/api/scan', { token: tokens.chanika, body: { code: 'MT1:SHP-2026-09999:1:0123456789' } })
  assert.equal(r.status, 404)
  assert.equal(r.data.code, 'UNKNOWN_SHIPMENT')

  assert.equal(await state(a.id), 'IN_TRANSIT', 'failed scans must not change state')
})

test('wrong facility cannot scan in or receive another facility\'s shipment', async () => {
  const mz = stack.shipmentByOrder(ORDER_MZ)
  const r = await stack.api('POST', '/api/scan', { token: tokens.chanika, body: { code: mz.packages[0].code } })
  assert.equal(r.status, 403)
  assert.equal(r.data.code, 'WRONG_FACILITY')
  assert.match(r.data.error, /Mzinga Dispensary/)
  const rc = await stack.api('POST', `/api/shipments/${mz.id}/receipt`, { token: tokens.chanika, body: {} })
  assert.equal(rc.status, 403)
  assert.equal(await state(mz.id), 'IN_TRANSIT')
  const scans = (await stack.api('GET', `/api/shipments/${mz.id}`, { token: tokens.auditor })).data.scans
  assert.ok(scans.some(s => s.result === 'WRONG_FACILITY'), 'wrong-facility attempt is logged for audit')
})

test('a shipment that was never dispatched cannot be scanned in', async () => {
  const n = stack.shipmentByOrder(ORDER_NEW)
  const r = await stack.api('POST', '/api/scan', { token: tokens.chanika, body: { code: n.packages[0].code } })
  assert.equal(r.status, 409)
  assert.equal(r.data.code, 'NOT_IN_TRANSIT')
})

test('scenario A: normal delivery becomes VERIFIED / RECEIVED', async () => {
  const a = stack.shipmentByOrder(ORDER_A)
  const scan = await stack.api('POST', '/api/scan', { token: tokens.chanika, body: { code: a.packages[0].code.toLowerCase() + '  ' } })
  assert.equal(scan.status, 200, JSON.stringify(scan.data))
  assert.equal(scan.data.shipment.state, 'RECEIPT_PENDING')
  assert.equal(scan.data.shipment.packages[0].sealNumber, 'recorded', 'seal number is hidden from the clinic before receipt')

  // Refresh / reconnect: the draft is kept server-side.
  const refreshed = (await stack.api('GET', `/api/shipments/${a.id}`, { token: tokens.chanika })).data
  assert.deepEqual(refreshed.receiptDraft.scannedPackages, [1])

  // Re-scanning while pending is harmless.
  assert.equal((await stack.api('POST', '/api/scan', { token: tokens.chanika, body: { code: a.packages[0].code } })).status, 200)

  const receiptBody = (cid) => ({
    packages: [{ packageNo: 1, seal: 'INTACT', sealNumber: '240117' }],
    batchMatches: true, condition: 'GOOD', quantityReceived: a.quantity, evidenceCid: cid
  })
  const noPhoto = await stack.api('POST', `/api/shipments/${a.id}/receipt`, { token: tokens.chanika, body: receiptBody('bafkreinotuploaded') })
  assert.equal(noPhoto.status, 400)

  const ev = await photo(tokens.chanika, a.id, 'A')
  assert.match(ev.cid, /^bafkrei[a-z2-7]{52}$/)
  const afterUpload = (await stack.api('GET', `/api/shipments/${a.id}`, { token: tokens.chanika })).data
  assert.equal(afterUpload.receiptDraft.evidence.cid, ev.cid, 'evidence CID survives a page refresh')

  const done = await stack.api('POST', `/api/shipments/${a.id}/receipt`, { token: tokens.chanika, body: receiptBody(ev.cid) })
  assert.equal(done.status, 200, JSON.stringify(done.data))
  assert.equal(done.data.state, 'RECEIVED')
  assert.equal(done.data.verification.code, 'VERIFIED')
  assert.equal(done.data.receipt.evidence.cid, ev.cid)
  assert.match(done.data.receipt.txHash, /^0x[0-9a-f]{64}$/)
  assert.deepEqual(done.data.events.map(e => e.toState), ['CREATED', 'DISPATCHED', 'IN_TRANSIT', 'RECEIPT_PENDING', 'RECEIVED'])

  const ledger = await stack.api('GET', `/api/shipments/${a.id}/ledger`, { token: tokens.auditor })
  assert.equal(ledger.data.consistent, true, JSON.stringify(ledger.data.checks.filter(c => !c.ok)))
  assert.equal(ledger.data.ledger.receipt.evidenceCid, ev.cid)
})

test('duplicate receipt is prevented', async () => {
  const a = stack.shipmentByOrder(ORDER_A)
  const again = await stack.api('POST', `/api/shipments/${a.id}/receipt`, {
    token: tokens.chanika,
    body: { packages: [{ packageNo: 1, seal: 'INTACT', sealNumber: '240117' }], batchMatches: true, condition: 'GOOD', quantityReceived: a.quantity, evidenceCid: 'x' }
  })
  assert.equal(again.status, 409)
  const rescan = await stack.api('POST', '/api/scan', { token: tokens.chanika, body: { code: a.packages[0].code } })
  assert.equal(rescan.status, 409)
  assert.equal(rescan.data.code, 'ALREADY_PROCESSED')
  assert.equal(await state(a.id), 'RECEIVED')
})

test('concurrent receipt submissions record exactly one receipt', async () => {
  const mz = stack.shipmentByOrder(ORDER_MZ)
  assert.equal((await stack.api('POST', '/api/scan', { token: tokens.mzinga, body: { code: mz.packages[0].code } })).status, 200)
  const ev = await photo(tokens.mzinga, mz.id, 'MZ')
  const body = { packages: [{ packageNo: 1, seal: 'INTACT', sealNumber: 'MSD-S999999' }], batchMatches: true, condition: 'GOOD', quantityReceived: mz.quantity, evidenceCid: ev.cid }
  const results = await Promise.all([1, 2, 3].map(() => stack.api('POST', `/api/shipments/${mz.id}/receipt`, { token: tokens.mzinga, body })))
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409, 409])
  const detail = (await stack.api('GET', `/api/shipments/${mz.id}`, { token: tokens.auditor })).data
  assert.equal(detail.events.filter(e => e.action === 'RECEIVE').length, 1)
  // Seal present but wrong number => mismatch => DISPUTED, never silently RECEIVED.
  assert.equal(detail.state, 'DISPUTED')
  assert.deepEqual(detail.receipt.verification.reasons, ['SEAL_NUMBER_MISMATCH'])
})

test('scenario B: damaged seal becomes DISPUTED, then investigated and rejected', async () => {
  const b = stack.shipmentByOrder(ORDER_B)
  assert.equal((await stack.api('POST', '/api/scan', { token: tokens.chanika, body: { code: b.packages[0].code } })).status, 200)
  const ev = await photo(tokens.chanika, b.id, 'B')
  const r = await stack.api('POST', `/api/shipments/${b.id}/receipt`, {
    token: tokens.chanika,
    body: { packages: [{ packageNo: 1, seal: 'DAMAGED', sealNumber: '240118' }], batchMatches: true, condition: 'DAMAGED', quantityReceived: 480, evidenceCid: ev.cid, notes: 'Seal tape cut, 20 ampoules missing' }
  })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(r.data.state, 'DISPUTED')
  assert.equal(r.data.verification.code, 'DISPUTED')
  assert.deepEqual(r.data.receipt.verification.reasons, ['SEAL_DAMAGED', 'CONDITION_DAMAGED', 'QUANTITY_MISMATCH'])
  assert.equal(r.data.receipt.seal, 'DAMAGED')

  // Invalid transitions through the API.
  assert.equal((await stack.api('POST', `/api/shipments/${b.id}/resolve`, { token: tokens.auditor, body: { decision: 'ACCEPT' } })).status, 409)
  assert.equal((await stack.api('POST', `/api/shipments/${b.id}/investigate`, { token: tokens.chanika, body: { findings: 'x' } })).status, 403)
  assert.equal((await stack.api('POST', `/api/shipments/${b.id}/dispatch`, { token: tokens.dispatcher, body: {} })).status, 409)

  const inv = await stack.api('POST', `/api/shipments/${b.id}/investigate`, { token: tokens.auditor, body: { findings: 'Driver statement taken; seal tape replaced en route.' } })
  assert.equal(inv.data.state, 'INVESTIGATED')
  const rej = await stack.api('POST', `/api/shipments/${b.id}/resolve`, { token: tokens.auditor, body: { decision: 'REJECT', notes: 'Return to MSD for quarantine.' } })
  assert.equal(rej.data.state, 'REJECTED')
  assert.equal(rej.data.verification.code, 'REJECTED')
  assert.equal((await stack.api('POST', `/api/shipments/${b.id}/resolve`, { token: tokens.auditor, body: { decision: 'ACCEPT' } })).status, 409)

  const ledger = await stack.api('GET', `/api/shipments/${b.id}/ledger`, { token: tokens.auditor })
  assert.equal(ledger.data.consistent, true, JSON.stringify(ledger.data.checks.filter(c => !c.ok)))

  // Outcome is pushed back to eLMIS as a proof of delivery.
  const pod = await stack.api('GET', `/api/integrations/elmis/shipments/${b.externalRef.shipmentId}/pod`, { token: tokens.auditor })
  assert.equal(pod.data.consignments[0].lineItem.quantityAccepted, 0)
  assert.equal(pod.data.consignments[0].medtrace.custodyState, 'REJECTED')
})

test('dispatch flow, then missing seal and unscanned package => DISPUTED', async () => {
  const n = stack.shipmentByOrder(ORDER_NEW)
  assert.equal((await stack.api('POST', `/api/shipments/${n.id}/depart`, { token: tokens.dispatcher, body: { vehicle: 'T 100 ABC' } })).status, 409, 'cannot depart before dispatch')
  assert.equal((await stack.api('POST', `/api/shipments/${n.id}/dispatch`, { token: tokens.chanika, body: {} })).status, 403)
  const d = await stack.api('POST', `/api/shipments/${n.id}/dispatch`, { token: tokens.dispatcher, body: {} })
  assert.equal(d.data.state, 'DISPATCHED')
  assert.ok(d.data.packages.every(p => /^MSD-S\d{6}$/.test(p.sealNumber)))
  assert.equal((await stack.api('POST', `/api/shipments/${n.id}/depart`, { token: tokens.dispatcher, body: {} })).status, 400, 'vehicle required')
  assert.equal((await stack.api('POST', `/api/shipments/${n.id}/depart`, { token: tokens.dispatcher, body: { vehicle: 't 100 abc' } })).data.state, 'IN_TRANSIT')

  // Only package 1 is scanned; package 2's seal is reported missing.
  assert.equal((await stack.api('POST', '/api/scan', { token: tokens.chanika, body: { code: n.packages[0].code, expectShipmentId: n.id } })).status, 200)
  const other = stack.shipmentByOrder(ORDER_A)
  const mixed = await stack.api('POST', '/api/scan', { token: tokens.chanika, body: { code: other.packages[0].code, expectShipmentId: n.id } })
  assert.equal(mixed.data.code, 'DIFFERENT_SHIPMENT')
  const ev = await photo(tokens.chanika, n.id, 'N')
  const seal1 = d.data.packages[0].sealNumber
  const r = await stack.api('POST', `/api/shipments/${n.id}/receipt`, {
    token: tokens.chanika,
    body: { packages: [{ packageNo: 1, seal: 'INTACT', sealNumber: seal1 }, { packageNo: 2, seal: 'MISSING' }], batchMatches: true, condition: 'GOOD', quantityReceived: n.quantity, evidenceCid: ev.cid }
  })
  assert.equal(r.data.state, 'DISPUTED')
  assert.deepEqual(r.data.receipt.verification.reasons, ['PACKAGE_NOT_SCANNED', 'SEAL_MISSING'])
  assert.equal(r.data.receipt.seal, 'MISSING')
})

test('IPFS evidence: retrieval is integrity-checked; bad uploads refused', async () => {
  const a = stack.shipmentByOrder(ORDER_A)
  const cid = a.receipt.evidence.cid
  const got = await stack.api('GET', `/api/evidence/${cid}`, { token: tokens.auditor })
  assert.equal(got.status, 200)
  assert.equal(got.headers.get('x-evidence-verified'), 'sha256-matches-cid')
  assert.equal(got.headers.get('content-type'), 'image/jpeg')
  assert.equal((await stack.api('GET', `/ipfs/${cid}`)).status, 404, 'no public evidence route')

  const n = stack.shipmentByOrder(ORDER_NEW)
  // Upload refused once the shipment is no longer receipt-pending.
  assert.equal((await stack.api('POST', `/api/shipments/${n.id}/evidence`, { token: tokens.chanika, raw: JPEG() })).status, 409)
  assert.equal((await stack.api('GET', `/api/evidence/b${'a'.repeat(58)}`, { token: tokens.auditor })).status, 403, 'unknown CID is not served')

  // Tamper with the stored block: retrieval and the ledger check must both detect it.
  const file = path.join(stack.services.evidence.dir, cid)
  const original = fs.readFileSync(file)
  fs.writeFileSync(file, Buffer.concat([original, Buffer.from('x')]))
  assert.equal((await stack.api('GET', `/api/evidence/${cid}`, { token: tokens.auditor })).status, 500)
  const ledger = (await stack.api('GET', `/api/shipments/${a.id}/ledger`, { token: tokens.auditor })).data
  assert.equal(ledger.consistent, false)
  fs.writeFileSync(file, original)
})

test('evidence upload validation', async () => {
  const s = await importAndMoveToPending()
  assert.equal((await stack.api('POST', `/api/shipments/${s.id}/evidence`, { token: tokens.mzinga, raw: Buffer.from('not an image'), type: 'image/jpeg' })).status, 400)
  assert.equal((await stack.api('POST', `/api/shipments/${s.id}/evidence`, { token: tokens.mzinga, raw: Buffer.from('x'), type: 'text/plain' })).status, 415)
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(300 * 1024)])
  assert.equal((await stack.api('POST', `/api/shipments/${s.id}/evidence`, { token: tokens.mzinga, raw: big })).status, 413)
  assert.equal((await stack.api('POST', `/api/shipments/${s.id}/evidence`, { token: tokens.chanika, raw: JPEG() })).status, 403)
})

async function importAndMoveToPending () {
  const pending = (await stack.api('GET', '/api/integrations/elmis/pending', { token: tokens.dispatcher })).data
  assert.ok(pending.some(p => p.externalId === PENDING_ELMIS))
  const imported = await stack.api('POST', '/api/integrations/elmis/import', { token: tokens.dispatcher, body: { externalId: PENDING_ELMIS } })
  assert.equal(imported.status, 200)
  assert.equal(imported.data.length, 2, 'two eLMIS line items become two sealed consignments')
  const again = await stack.api('POST', '/api/integrations/elmis/import', { token: tokens.dispatcher, body: { externalId: PENDING_ELMIS } })
  assert.equal(again.data.length, 0, 're-import creates nothing')
  const id = imported.data[0].id
  await stack.api('POST', `/api/shipments/${id}/dispatch`, { token: tokens.dispatcher, body: {} })
  await stack.api('POST', `/api/shipments/${id}/depart`, { token: tokens.dispatcher, body: { vehicle: 'T 1 AAA' } })
  const s = stack.services.store.shipment(id)
  assert.equal((await stack.api('POST', '/api/scan', { token: tokens.mzinga, body: { code: s.packages[0].code } })).status, 200)
  return s
}

test('eLMIS push payload is validated and mapped', async () => {
  const bad = await stack.api('POST', '/api/integrations/elmis/shipments', { token: tokens.dispatcher, body: { id: 'x', order: { orderCode: 'O' } } })
  assert.equal(bad.status, 422)
  assert.equal(bad.data.code, 'ELMIS_PAYLOAD_INVALID')
  const payload = {
    id: 'push-0001',
    order: {
      orderCode: 'ORD-PUSH-1',
      supplyingFacility: { code: 'MSD-DSM-ZONE', name: 'MSD Dar es Salaam Zonal Store' },
      receivingFacility: { code: 'HFR-105611', name: 'Chanika Health Centre' }
    },
    lineItems: [{ orderable: { productCode: '1', fullProductName: 'Paracetamol 500mg tablets' }, lot: { lotCode: 'P1' }, quantityShipped: 10 }]
  }
  const ok = await stack.api('POST', '/api/integrations/elmis/shipments', { token: tokens.dispatcher, body: payload })
  assert.equal(ok.status, 201)
  assert.equal(ok.data[0].state, 'CREATED')
  assert.equal((await stack.api('POST', '/api/integrations/elmis/shipments', { token: tokens.chanika, body: payload })).status, 403)
  const pod = (await stack.api('GET', `/api/integrations/elmis/shipments/${stack.shipmentByOrder(ORDER_A).externalRef.shipmentId}/pod`, { token: tokens.dispatcher })).data
  assert.equal(pod.consignments[0].status, 'CONFIRMED')
  assert.equal(pod.consignments[0].lineItem.quantityAccepted, stack.shipmentByOrder(ORDER_A).quantity)
})

test('blockchain failure: a reverted transaction changes nothing', async () => {
  const s = (await stack.api('POST', '/api/integrations/elmis/shipments', {
    token: tokens.dispatcher,
    body: {
      id: 'push-0002',
      order: { orderCode: 'ORD-PUSH-2', supplyingFacility: { code: 'MSD-DSM-ZONE' }, receivingFacility: { code: 'HFR-105611' } },
      lineItems: [{ orderable: { productCode: '2', fullProductName: 'Gauze' }, lot: { lotCode: 'G1' }, quantityShipped: 5 }]
    }
  })).data[0]
  const { chain } = stack.services
  await chain.setRelayer(chain.relayer.address, false)
  try {
    const r = await stack.api('POST', `/api/shipments/${s.id}/dispatch`, { token: tokens.dispatcher, body: {} })
    assert.equal(r.status, 409)
    assert.equal(r.data.code, 'LEDGER_REJECTED')
    assert.match(r.data.error, /Relayer not approved/)
    assert.equal(await state(s.id), 'CREATED')
    assert.equal(stack.services.store.eventsFor(s.id).length, 1)
  } finally {
    await chain.setRelayer(chain.relayer.address, true)
  }
  assert.equal((await stack.api('POST', `/api/shipments/${s.id}/dispatch`, { token: tokens.dispatcher, body: {} })).data.state, 'DISPATCHED', 'retry succeeds')
})

test('blockchain failure: node unreachable returns 503, nothing changes, recovers on reconnect', async () => {
  const s = stack.services.store.data.shipments.find(x => x.externalRef.orderCode === 'ORD-PUSH-2')
  const { chain } = stack.services
  const url = chain.rpcUrl
  chain.connect('http://127.0.0.1:9')
  try {
    const health = await stack.api('GET', '/api/health')
    assert.equal(health.data.ok, false)
    assert.equal(health.data.ledger.connected, false)
    const r = await stack.api('POST', `/api/shipments/${s.id}/depart`, { token: tokens.dispatcher, body: { vehicle: 'T 2 BBB' } })
    assert.equal(r.status, 503)
    assert.equal(r.data.code, 'LEDGER_UNAVAILABLE')
    assert.equal(await state(s.id), 'DISPATCHED')
  } finally {
    chain.connect(url)
  }
  assert.equal((await stack.api('GET', '/api/health')).data.ok, true)
  assert.equal((await stack.api('POST', `/api/shipments/${s.id}/depart`, { token: tokens.dispatcher, body: { vehicle: 'T 2 BBB' } })).data.state, 'IN_TRANSIT')
})

test('server restart keeps state and sessions', async () => {
  const restarted = createServices(stack.config)
  const a = restarted.store.data.shipments.find(s => s.externalRef.orderCode === ORDER_A)
  assert.equal(a.state, 'RECEIVED')
  assert.ok(restarted.store.data.sessions[tokenKey(tokens.chanika)])
  assert.equal(restarted.store.data.sessions[tokens.chanika], undefined, 'raw session tokens are never stored')
  const check = await restarted.custody.ledgerCheck(a.id)
  assert.equal(check.consistent, true)
})

test('demo can be repeated from a clean database', async () => {
  for (let round = 0; round < 2; round++) {
    const services = createServices(stack.config)
    await seed(services, { writeArtifacts: false, log: () => {} })
    const fresh = createServices(stack.config) // what a restarted server would load
    assert.deepEqual(fresh.store.data.shipments.map(s => s.state), ['IN_TRANSIT', 'IN_TRANSIT', 'IN_TRANSIT', 'CREATED', 'IN_TRANSIT', 'IN_TRANSIT', 'CREATED'])
    assert.equal(fresh.store.data.events.length, 5 * 3 + 2)
    assert.ok(fresh.store.data.operations.every(o => o.status === 'CONFIRMED'), 'every seeded ledger write is journaled and confirmed')
    assert.equal(fresh.store.data.scans.length, 0)
    const clinic = fresh.store.data.users.find(u => u.username === 'chanika.clinic')
    const a = fresh.store.data.shipments[0]
    await fresh.custody.scan(clinic, a.packages[0].code)
    const ev = await fresh.custody.addEvidence(clinic, a.id, JPEG('round' + round), 'image/jpeg')
    const done = await fresh.custody.confirmReceipt(clinic, a.id, {
      packages: [{ packageNo: 1, seal: 'INTACT', sealNumber: 'MSD-S240117' }], batchMatches: true, condition: 'GOOD', quantityReceived: a.quantity, evidenceCid: ev.cid
    })
    assert.equal(done.state, 'RECEIVED')
    assert.equal((await fresh.custody.ledgerCheck(a.id)).consistent, true)
  }
})
