const { test } = require('node:test')
const assert = require('node:assert/strict')
const { assertTransition, TRANSITIONS } = require('../../server/custody/stateMachine')

const STATES = ['CREATED', 'DISPATCHED', 'IN_TRANSIT', 'RECEIPT_PENDING', 'RECEIVED', 'DISPUTED', 'INVESTIGATED', 'ACCEPTED', 'REJECTED']
const USERS = {
  dispatcher: { role: 'dispatcher', facilityCode: 'MSD-DSM-ZONE' },
  clinic: { role: 'clinic', facilityCode: 'HFR-1' },
  otherClinic: { role: 'clinic', facilityCode: 'HFR-2' },
  auditor: { role: 'auditor', facilityCode: null }
}

// The complete allowed set: [action, from-state, user]. Everything else must be refused.
const ALLOWED = new Set([
  'DISPATCH CREATED dispatcher',
  'DEPART DISPATCHED dispatcher',
  'ARRIVE IN_TRANSIT clinic',
  'RECEIVE RECEIPT_PENDING clinic',
  'DISPUTE IN_TRANSIT clinic',
  'DISPUTE RECEIPT_PENDING clinic',
  'DISPUTE IN_TRANSIT auditor',
  'DISPUTE RECEIPT_PENDING auditor',
  'INVESTIGATE DISPUTED auditor',
  'ACCEPT INVESTIGATED auditor',
  'REJECT INVESTIGATED auditor'
])

test('every action x state x role combination matches the allowed set', () => {
  let checked = 0
  for (const action of Object.keys(TRANSITIONS)) {
    for (const state of STATES) {
      for (const [name, user] of Object.entries(USERS)) {
        const shipment = { state, destinationFacilityCode: 'HFR-1' }
        const key = `${action} ${state} ${name}`
        let ok = true
        try { assertTransition(action, shipment, user) } catch (e) { ok = false }
        assert.equal(ok, ALLOWED.has(key), key)
        checked++
      }
    }
  }
  assert.equal(checked, 8 * 9 * 4)
})

test('final states accept no further actions', () => {
  for (const state of ['RECEIVED', 'ACCEPTED', 'REJECTED']) {
    for (const action of Object.keys(TRANSITIONS)) {
      for (const user of Object.values(USERS)) {
        assert.throws(() => assertTransition(action, { state, destinationFacilityCode: 'HFR-1' }, user))
      }
    }
  }
})
