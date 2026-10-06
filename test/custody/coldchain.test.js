// Cold-chain excursion detection and the receiving / audit workflow around it.
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { startStack } = require('./helpers')
const { analyse, normaliseLog, simulateReadings } = require('../../server/coldchain')

const range = { minC: 2, maxC: 8 }
const end = new Date('2026-10-06T12:00:00Z')

test('normal simulated profile stays in range; excursion profile is detected with its duration', () => {
  const ok = analyse({ source: 'SIMULATED', readings: simulateReadings({ profile: 'normal', range, end }) }, range, 15)
  assert.equal(ok.status, 'IN_RANGE')
  assert.equal(ok.count, 49)
  assert.ok(ok.minC >= 2 && ok.maxC <= 8)

  const bad = analyse({ source: 'SIMULATED', readings: simulateReadings({ profile: 'excursion', range, end }) }, range, 15)
  assert.equal(bad.status, 'EXCURSION')
  assert.equal(bad.excursions.length, 1)
  assert.equal(bad.excursions[0].direction, 'HIGH')
  assert.equal(bad.totalExcursionMinutes, 90)
  assert.ok(bad.peakC > 8)
  assert.equal(bad.simulated, true)
})

test('the permitted range and tolerance are configuration, not constants', () => {
  const readings = simulateReadings({ profile: 'excursion', range, end })
  assert.equal(analyse({ readings }, range, 120).status, 'IN_RANGE', 'a 90 min run is within a 120 min tolerance')
  assert.equal(analyse({ readings }, { minC: 15, maxC: 25 }, 0).excursions[0].direction, 'LOW')
  const blip = [{ at: '2026-10-06T10:00:00Z', c: 5 }, { at: '2026-10-06T10:05:00Z', c: 9 }, { at: '2026-10-06T10:10:00Z', c: 5 }]
  assert.equal(analyse({ readings: blip }, range, 15).status, 'IN_RANGE')
  assert.equal(analyse({ readings: blip }, range, 5).status, 'EXCURSION')
  assert.equal(analyse(null, range).status, 'NO_DATA')
})

test('uploaded logs are validated', () => {
  const r = [{ at: '2026-10-06T10:00:00Z', c: 5 }, { at: '2026-10-06T10:10:00Z', c: 6 }]
  assert.throws(() => normaliseLog({ source: 'WHATEVER', readings: r }), /source/)
  assert.throws(() => normaliseLog({ source: 'LOGGER', readings: [r[1], r[0]] }), /time order/)
  assert.throws(() => normaliseLog({ source: 'LOGGER', readings: [r[0], { at: 'x', c: 1 }] }), /valid time/)
  assert.throws(() => normaliseLog({ source: 'LOGGER', readings: [r[0], { at: r[1].at, c: 'hot' }] }), /temperature/)
  assert.equal(normaliseLog({ source: 'LOGGER', readings: r }).readings.length, 2)
})

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

test('excursion is flagged for the auditor before receipt and routes the receipt to review', async () => {
  const s = stack.shipmentByKey('COLD_EXCURSION')
  const ex = (await stack.api('GET', '/api/exceptions', { token: tokens.auditor })).data
  const item = ex.exceptions.find(e => e.shipmentId === s.id && e.type === 'TEMPERATURE_EXCURSION')
  assert.ok(item, 'visible before the clinic receives it')
  assert.match(item.title, /simulated data/)
  assert.ok(ex.shipments[s.id].factors.some(f => f.rule === 'TEMPERATURE_EXCURSION'))
  assert.match(ex.method, /not a validated fraud prediction/)

  const detail = (await stack.api('GET', `/api/shipments/${s.id}`, { token: tokens.chanika })).data
  assert.equal(detail.coldChain.status, 'EXCURSION')
  assert.equal(detail.coldChain.log.source, 'SIMULATED')
  assert.equal(detail.incidents[0].type, 'TEMPERATURE_EXCURSION')
  assert.equal((await stack.api('GET', detail.coldChain.log.url)).status, 200, 'log is stored as integrity-checked evidence')

  const { preview, done } = await stack.receive(tokens.chanika, s.id)
  assert.equal(preview.data.decision, 'DISPUTE', 'the clinic sees the problem before confirming')
  assert.equal(done.status, 200, JSON.stringify(done.data))
  assert.equal(done.data.state, 'DISPUTED')
  assert.deepEqual(done.data.receipt.verification.reasons, ['TEMPERATURE_EXCURSION'])
  assert.equal(done.data.receipt.verification.checks.find(c => c.id === 'seal-number-1').result, 'PASS')
  assert.equal(done.data.receipt.temperature.simulated, true)
})

test('in-range log: clean receipt with the temperature check passed', async () => {
  const s = stack.shipmentByKey('COLD_OK')
  const { done } = await stack.receive(tokens.chanika, s.id)
  assert.equal(done.data.state, 'RECEIVED')
  assert.equal(done.data.receipt.verification.checks.find(c => c.id === 'cold-chain').result, 'PASS')
})

test('a temperature log cannot be replaced, forged as simulated, or attached to a non-cold-chain item', async () => {
  const cold = stack.shipmentByKey('COLD_EXCURSION')
  const readings = [{ at: '2026-10-06T10:00:00Z', c: 5 }, { at: '2026-10-06T10:10:00Z', c: 5 }]
  const replace = await stack.api('POST', `/api/shipments/${cold.id}/temperature`, { token: tokens.dispatcher, body: { source: 'LOGGER', readings } })
  assert.equal(replace.status, 409, 'a clean log cannot hide a recorded excursion (shipment is also past receipt)')
  const fake = await stack.api('POST', `/api/shipments/${stack.shipmentByKey('A').id}/temperature`, { token: tokens.dispatcher, body: { source: 'SIMULATED', readings } })
  assert.equal(fake.status, 400)
  const notCold = await stack.api('POST', `/api/shipments/${stack.shipmentByKey('A').id}/temperature`, { token: tokens.dispatcher, body: { source: 'LOGGER', readings } })
  assert.equal(notCold.status, 400)
  assert.equal((await stack.api('POST', `/api/shipments/${cold.id}/temperature/simulate`, { token: tokens.chanika, body: { profile: 'normal' } })).status, 403)
})
