// Unit tests for the receiving decision rules (no chain needed).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { evaluateReceipt } = require('../../server/custody/verification')

const shipment = (extra = {}) => ({
  id: 'SHP-T-1',
  destinationFacilityCode: 'HFR-1',
  batch: 'LOT-1',
  expiry: '2030-01-01',
  quantity: 100,
  coldChain: null,
  packages: [{ packageNo: 1, sealNumber: 'MSD-S123456' }],
  ...extra
})
const events = ['CREATE', 'DISPATCH', 'DEPART', 'ARRIVE'].map((action, i) => ({ action, seq: i + 1 }))
const good = { packages: [{ packageNo: 1, seal: 'INTACT', sealNumber: 'MSD-S123456' }], batchMatches: true, condition: 'GOOD', quantityReceived: 100 }
const ctx = (extra = {}) => ({
  events,
  scannedPackages: { 1: {} },
  evidence: { present: true, intact: true },
  coldChain: null,
  user: { facilityCode: 'HFR-1' },
  revealSeal: true,
  now: new Date('2026-10-06'),
  ...extra
})
const check = (r, id) => r.checks.find(c => c.id === id)

test('all mandatory checks pass: clean receipt, and the ledger facts agree', () => {
  const r = evaluateReceipt(shipment(), good, ctx())
  assert.equal(r.decision, 'CLEAN')
  assert.deepEqual(r.contract, { seal: 'INTACT', identityOk: true, conditionOk: true })
  assert.deepEqual(r.reasons, [])
  assert.ok(r.checks.every(c => ['PASS', 'NOT_CHECKED', 'WARNING'].includes(c.result)))
  assert.match(r.limits, /does not prove the contents are genuine/)
})

test('a valid QR does not override a wrong seal number', () => {
  const r = evaluateReceipt(shipment(), { ...good, packages: [{ packageNo: 1, seal: 'INTACT', sealNumber: 'MSD-S654321' }] }, ctx())
  assert.equal(check(r, 'labels').result, 'PASS')
  assert.equal(check(r, 'seal-number-1').result, 'FAIL')
  assert.equal(r.decision, 'DISPUTE')
  assert.equal(r.contract.identityOk, false, 'the contract will record DISPUTED, not RECEIVED')
  assert.deepEqual(r.reasons, ['SEAL_NUMBER_MISMATCH'])
})

test('missing or tampered evidence is a failure, never a pass', () => {
  const none = evaluateReceipt(shipment(), good, ctx({ evidence: { present: false } }))
  assert.equal(check(none, 'evidence').result, 'FAIL')
  assert.equal(none.decision, 'DISPUTE')
  const bad = evaluateReceipt(shipment(), good, ctx({ evidence: { present: true, intact: false, detail: 'content does not match CID' } }))
  assert.equal(check(bad, 'evidence').result, 'FAIL')
  assert.deepEqual(bad.reasons, ['EVIDENCE_INVALID'])
})

test('the preview never reveals whether a seal number is right', () => {
  const right = evaluateReceipt(shipment(), good, ctx({ revealSeal: false }))
  const wrong = evaluateReceipt(shipment(), { ...good, packages: [{ packageNo: 1, seal: 'INTACT', sealNumber: '999' }] }, ctx({ revealSeal: false }))
  for (const r of [right, wrong]) {
    assert.equal(r.decision, 'CLEAN_IF_SEALS_MATCH')
    assert.equal(check(r, 'seal-number-1').result, 'NOT_CHECKED')
  }
  assert.equal(check(right, 'seal-number-1').reason, check(wrong, 'seal-number-1').reason)
})

test('damaged seal, short quantity and a missing custody step each block a clean receipt', () => {
  const damaged = evaluateReceipt(shipment(), { ...good, packages: [{ packageNo: 1, seal: 'DAMAGED' }] }, ctx())
  assert.equal(damaged.contract.seal, 'DAMAGED')
  assert.equal(check(damaged, 'seal-number-1').result, 'NOT_CHECKED', 'not entered for a damaged seal, and not mandatory')
  assert.deepEqual(damaged.reasons, ['SEAL_DAMAGED'])

  const short = evaluateReceipt(shipment(), { ...good, quantityReceived: 90 }, ctx())
  assert.equal(short.decision, 'DISPUTE')
  assert.match(check(short, 'quantity').reason, /10 short/)

  const gap = evaluateReceipt(shipment(), good, ctx({ events: events.filter(e => e.action !== 'DEPART').map((e, i) => ({ ...e, seq: i + 1 })) }))
  assert.equal(check(gap, 'custody').result, 'FAIL')
  assert.deepEqual(gap.reasons, ['CUSTODY_INCOMPLETE'])
})

test('cold chain: missing data is a warning, an excursion is a failure; short expiry warns', () => {
  const cold = shipment({ coldChain: { minC: 2, maxC: 8 } })
  const noData = evaluateReceipt(cold, good, ctx({ coldChain: { status: 'NO_DATA' } }))
  assert.equal(check(noData, 'cold-chain').result, 'WARNING')
  assert.equal(noData.decision, 'CLEAN', 'missing data is reported, not treated as a confirmed failure')

  const exc = evaluateReceipt(cold, good, ctx({ coldChain: { status: 'EXCURSION', range: { minC: 2, maxC: 8 }, totalExcursionMinutes: 90, peakC: 11.2, simulated: true } }))
  assert.equal(check(exc, 'cold-chain').result, 'FAIL')
  assert.match(check(exc, 'cold-chain').reason, /simulated logger.*does not mean the stock is unusable/)
  assert.deepEqual(exc.reasons, ['TEMPERATURE_EXCURSION'])

  const soon = evaluateReceipt(shipment({ expiry: '2026-12-01' }), good, ctx())
  assert.equal(check(soon, 'expiry').result, 'WARNING')
  assert.equal(soon.decision, 'CLEAN')
  const expired = evaluateReceipt(shipment({ expiry: '2026-01-01' }), good, ctx())
  assert.deepEqual(expired.reasons, ['EXPIRED'])
})
