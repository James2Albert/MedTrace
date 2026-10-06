// Crash recovery, reconciliation with the ledger and idempotent retries.
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { ethers } = require('ethers')
const { startStack } = require('./helpers')
const { createServices } = require('../../server/app')
const { buildExceptions } = require('../../server/custody/exceptions')

let stack, tokens

before(async () => {
  stack = await startStack()
  tokens = {
    dispatcher: await stack.login('msd.dispatch', '1111'),
    chanika: await stack.login('chanika.clinic', '2222'),
    auditor: await stack.login('district.auditor', '4444')
  }
})
after(() => stack.stop())

const userNamed = (services, username) => services.store.data.users.find(u => u.username === username)

test('a retried request with the same Idempotency-Key is applied once', async () => {
  const id = stack.shipmentByKey('DISPATCH').id
  const send = () => stack.api('POST', `/api/shipments/${id}/dispatch`, { token: tokens.dispatcher, body: {}, headers: { 'Idempotency-Key': 'dispatch-once' } })
  const [first, second] = [await send(), await send()]
  assert.equal(first.status, 200)
  assert.equal(second.status, 200, 'the retry returns the original result instead of an error')
  assert.deepEqual(second.data.packages.map(p => p.sealNumber), first.data.packages.map(p => p.sealNumber))
  assert.equal(second.data.events.filter(e => e.action === 'DISPATCH').length, 1)
  // Without the key, a repeat is an invalid transition, not a second event.
  assert.equal((await stack.api('POST', `/api/shipments/${id}/dispatch`, { token: tokens.dispatcher, body: {} })).status, 409)
})

test('crash after broadcast: never reported as success, completed exactly once after restart', async () => {
  const id = stack.shipmentByKey('DISPATCH').id
  const { chain } = stack.services
  const real = chain.transition
  // The transaction is mined, but the server "dies" before it hears back.
  chain.transition = async (...args) => { await real.apply(chain, args); throw new Error('simulated crash') }
  let r
  try {
    r = await stack.api('POST', `/api/shipments/${id}/depart`, { token: tokens.dispatcher, body: { vehicle: 'T 9 XYZ' } })
  } finally {
    chain.transition = real
  }
  assert.equal(r.status, 503)
  assert.equal(r.data.code, 'LEDGER_UNCONFIRMED')
  const local = stack.services.store.shipment(id)
  assert.equal(local.state, 'DISPATCHED', 'nothing is shown as done')
  const op = stack.services.store.data.operations.slice(-1)[0]
  assert.equal(op.status, 'UNKNOWN')
  assert.match(op.txHash, /^0x[0-9a-f]{64}$/, 'transaction hash was journaled before broadcast')

  const check = await stack.api('GET', `/api/shipments/${id}/ledger`, { token: tokens.auditor })
  assert.equal(check.data.status, 'PENDING', 'an in-flight write is not reported as an inconsistency')
  assert.equal(check.data.consistent, null)
  const summary = (await stack.api('GET', `/api/shipments/${id}`, { token: tokens.auditor })).data
  assert.equal(summary.reconciliation.status, 'PENDING')

  // Restart from what is on disk, as after a real crash.
  const restarted = createServices(stack.config)
  const reports = await restarted.custody.reconcileAll()
  assert.deepEqual(reports.find(x => x.shipmentId === id).applied, ['DEPART'])
  const s = restarted.store.shipment(id)
  assert.equal(s.state, 'IN_TRANSIT')
  const departs = restarted.store.eventsFor(id).filter(e => e.action === 'DEPART')
  assert.equal(departs.length, 1)
  assert.equal(departs[0].details.vehicle, 'T 9 XYZ', 'off-chain details are restored from the journal')
  assert.equal(restarted.store.data.operations.find(o => o.id === op.id).status, 'RECONCILED')

  await restarted.custody.reconcileAll()
  assert.equal(restarted.store.eventsFor(id).filter(e => e.action === 'DEPART').length, 1, 'reconciliation is idempotent')
  const after = await restarted.custody.ledgerCheck(id)
  assert.equal(after.status, 'CONSISTENT', JSON.stringify(after.checks.filter(c => !c.ok)))
})

test('a journaled write that never reached the ledger is marked failed and can be retried', async () => {
  const services = createServices(stack.config)
  const b = services.store.data.shipments.find(s => s.id === stack.shipmentByKey('B').id)
  const auditor = userNamed(services, 'district.auditor')
  services.store.data.operations.push({
    id: 'op-lost', requestId: null, userId: auditor.id, actor: services.custody.actorOf(auditor), shipmentId: b.id,
    action: 'DISPUTE', ref: ethers.utils.id('lost'), details: { reason: 'lost' }, effects: {},
    status: 'SUBMITTED', createdAt: new Date().toISOString(), txHash: ethers.utils.id('never-broadcast')
  })
  const report = await services.custody.reconcileShipment(b.id)
  assert.deepEqual(report.failed, ['DISPUTE'])
  assert.equal(services.store.shipment(b.id).state, 'IN_TRANSIT')
  assert.equal(services.custody.unresolvedOps(b.id).length, 0)
  const disputed = await services.custody.dispute(auditor, b.id, { reason: 'Retried after a lost write' })
  assert.equal(disputed.state, 'DISPUTED')
})

test('ledger events with no journal entry are recovered and flagged for review', async () => {
  const services = createServices(stack.config)
  const s = services.store.shipment(stack.shipmentByKey('COLD_OK').id)
  const clinic = userNamed(services, 'chanika.clinic')
  // Written straight to the ledger (e.g. the database was restored from an older backup).
  await services.chain.transition(services.wallets.forUser(clinic), s.id, 'ARRIVE', ethers.utils.id('out-of-band'))
  assert.equal((await services.custody.ledgerCheck(s.id)).status, 'INCONSISTENT')

  const report = await services.custody.reconcileShipment(s.id)
  assert.deepEqual(report.recovered, ['ARRIVE'])
  const fixed = services.store.shipment(s.id)
  assert.equal(fixed.state, 'RECEIPT_PENDING')
  assert.equal(fixed.reconciliation.status, 'PARTIAL')
  assert.equal(services.store.eventsFor(s.id).slice(-1)[0].details.recoveredFromLedger, true)
  assert.equal((await services.custody.ledgerCheck(s.id)).status, 'CONSISTENT')

  const ex = await buildExceptions({ store: services.store, custody: services.custody, evidence: services.evidence, config: services.config })
  assert.ok(ex.exceptions.some(e => e.shipmentId === s.id && e.type === 'RECONCILIATION'))
  assert.ok(ex.shipments[s.id].factors.some(f => f.rule === 'RECOVERED_FROM_LEDGER'))
})
