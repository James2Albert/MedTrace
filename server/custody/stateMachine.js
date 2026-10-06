/**
 * Custody state machine. Mirrors contracts/MedTraceCustody.sol so invalid transitions are
 * refused before anything is sent to the ledger; the contract enforces the same rules.
 *
 *   CREATED -> DISPATCHED -> IN_TRANSIT -> RECEIPT_PENDING -> RECEIVED
 *   IN_TRANSIT | RECEIPT_PENDING -> DISPUTED -> INVESTIGATED -> ACCEPTED | REJECTED
 *
 * RECEIVE is the only action whose target depends on evidence: an intact seal with a
 * matching identity and acceptable condition becomes RECEIVED, anything else DISPUTED.
 */
const TRANSITIONS = {
  DISPATCH: { from: ['CREATED'], to: 'DISPATCHED', roles: ['dispatcher'] },
  DEPART: { from: ['DISPATCHED'], to: 'IN_TRANSIT', roles: ['dispatcher'] },
  ARRIVE: { from: ['IN_TRANSIT'], to: 'RECEIPT_PENDING', roles: ['clinic'], destinationOnly: true },
  RECEIVE: { from: ['RECEIPT_PENDING'], to: ['RECEIVED', 'DISPUTED'], roles: ['clinic'], destinationOnly: true },
  DISPUTE: { from: ['IN_TRANSIT', 'RECEIPT_PENDING'], to: 'DISPUTED', roles: ['clinic', 'auditor'], destinationOnly: true },
  INVESTIGATE: { from: ['DISPUTED'], to: 'INVESTIGATED', roles: ['auditor'] },
  ACCEPT: { from: ['INVESTIGATED'], to: 'ACCEPTED', roles: ['auditor'] },
  REJECT: { from: ['INVESTIGATED'], to: 'REJECTED', roles: ['auditor'] }
}

const STATE_LABELS = {
  CREATED: 'Created',
  DISPATCHED: 'Dispatched',
  IN_TRANSIT: 'In transit',
  RECEIPT_PENDING: 'Awaiting receipt',
  RECEIVED: 'Received',
  DISPUTED: 'Disputed',
  INVESTIGATED: 'Under investigation',
  ACCEPTED: 'Accepted after investigation',
  REJECTED: 'Rejected after investigation'
}

const FINAL_STATES = ['RECEIVED', 'ACCEPTED', 'REJECTED']

class TransitionError extends Error {
  constructor (message, status = 409, code = 'INVALID_TRANSITION') {
    super(message)
    this.status = status
    this.code = code
  }
}

function assertTransition (action, shipment, user) {
  const rule = TRANSITIONS[action]
  if (!rule) throw new TransitionError(`Unknown action ${action}`, 400)
  if (!rule.roles.includes(user.role)) {
    throw new TransitionError(`A ${user.role} cannot perform ${action.toLowerCase()}`, 403, 'FORBIDDEN')
  }
  if (rule.destinationOnly && user.role === 'clinic' && user.facilityCode !== shipment.destinationFacilityCode) {
    throw new TransitionError('This shipment is addressed to a different facility', 403, 'WRONG_FACILITY')
  }
  if (!rule.from.includes(shipment.state)) {
    throw new TransitionError(
      `Cannot ${action.toLowerCase()} a shipment that is ${STATE_LABELS[shipment.state].toLowerCase()}`
    )
  }
  return rule
}

function allowedActions (shipment, user) {
  return Object.keys(TRANSITIONS).filter(action => {
    try {
      assertTransition(action, shipment, user)
      return true
    } catch (e) {
      return false
    }
  })
}

/** Plain-language final verification status for the audit view. */
function verificationStatus (shipment) {
  switch (shipment.state) {
    case 'RECEIVED': return { code: 'VERIFIED', label: 'Received: all mandatory checks passed' }
    case 'DISPUTED': return { code: 'DISPUTED', label: 'Disputed: awaiting investigation' }
    case 'INVESTIGATED': return { code: 'UNDER_INVESTIGATION', label: 'Under investigation' }
    case 'ACCEPTED': return { code: 'ACCEPTED', label: 'Accepted after investigation' }
    case 'REJECTED': return { code: 'REJECTED', label: 'Rejected after investigation' }
    default: return { code: 'PENDING', label: 'Not yet received' }
  }
}

module.exports = { TRANSITIONS, STATE_LABELS, FINAL_STATES, TransitionError, assertTransition, allowedActions, verificationStatus }
