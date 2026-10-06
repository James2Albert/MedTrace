// The guided judge journey on the demo hub, driven through the real API and contract.
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { startStack } = require('./helpers')

let stack

before(async () => { stack = await startStack() })
after(() => stack.stop())

const enter = async (role) => {
  const r = await stack.api('POST', '/api/demo/session', { body: { role } })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  return r.data.token
}

test('demo hub lists the two guided stories with their labels, without exposing PINs', async () => {
  const r = await stack.api('GET', '/api/demo/scenarios')
  assert.equal(r.status, 200)
  const a = r.data.find(x => x.key === 'GUIDED_A')
  const b = r.data.find(x => x.key === 'B')
  assert.match(a.guide.title, /legitimate/)
  assert.match(b.guide.title, /suspicious/)
  assert.equal(a.shipment.state, 'CREATED')
  assert.equal(a.packages[0].plannedSeal, 'MSD-S250007')
  assert.equal(b.packages[0].seal, 'MSD-S240181', 'what the swapped physical seal reads')
  assert.match(b.packages[0].qr, /^<svg/)
  assert.equal(/pin|pinHash/i.test(JSON.stringify(r.data)), false)
  assert.equal((await stack.api('POST', '/api/demo/session', { body: { role: 'root' } })).status, 400)
})

test('guided scenario A: dispatch, hand over, independent clinic check, clean receipt', async () => {
  const a = stack.shipmentByKey('GUIDED_A')
  const dispatcher = await enter('dispatcher')
  const d = await stack.api('POST', `/api/shipments/${a.id}/dispatch`, { token: dispatcher, body: { sealNumbers: ['MSD-S250007'] } })
  assert.equal(d.data.state, 'DISPATCHED')
  const t = await stack.api('POST', `/api/shipments/${a.id}/depart`, { token: dispatcher, body: { vehicle: 'T 123 ABC' } })
  assert.equal(t.data.state, 'IN_TRANSIT')
  const clinic = await enter('clinic')
  const { preview, done } = await stack.receive(clinic, a.id)
  assert.equal(preview.data.decision, 'CLEAN_IF_SEALS_MATCH')
  assert.equal(done.data.state, 'RECEIVED')
  assert.deepEqual(done.data.events.map(e => e.action), ['CREATE', 'DISPATCH', 'DEPART', 'ARRIVE', 'RECEIVE'])
  const after = (await stack.api('GET', '/api/demo/scenarios')).data.find(x => x.key === 'GUIDED_A')
  assert.equal(after.packages[0].seal, 'MSD-S250007', 'hub shows the seal applied at dispatch')
})

test('demo roles keep their normal permissions', async () => {
  const clinic = await enter('clinic')
  const b = stack.shipmentByKey('B')
  assert.equal((await stack.api('POST', `/api/shipments/${b.id}/investigate`, { token: clinic, body: { findings: 'x' } })).status, 403)
  assert.equal((await stack.api('GET', '/api/exceptions', { token: clinic })).status, 403)
})

test('reset restores the starting point and signs everyone out', async () => {
  const auditor = await enter('auditor')
  const r = await stack.api('POST', '/api/demo/reset')
  assert.equal(r.status, 200)
  assert.equal((await stack.api('GET', '/api/me', { token: auditor })).status, 401)
  const hub = (await stack.api('GET', '/api/demo/scenarios')).data
  assert.equal(hub.find(x => x.key === 'GUIDED_A').shipment.state, 'CREATED')
  assert.equal(hub.find(x => x.key === 'B').shipment.state, 'IN_TRANSIT')
  assert.equal((await stack.api('GET', '/api/health')).data.ok, true)
})
