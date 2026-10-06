/**
 * Receiving decision. Every check returns PASS, WARNING, FAIL or NOT_CHECKED with a plain
 * reason. The rule is explicit: a clean receipt needs every *mandatory* check to PASS.
 * A valid QR never outweighs a failed seal, and missing evidence is never treated as verified.
 *
 * The result is reduced to the three facts the contract judges on (seal, identityOk,
 * conditionOk); the contract then independently decides RECEIVED vs DISPUTED.
 */

const PASS = 'PASS'
const WARNING = 'WARNING'
const FAIL = 'FAIL'
const NOT_CHECKED = 'NOT_CHECKED'

const CONDITION_TEXT = {
  GOOD: 'Good: packaging and contents undamaged',
  DAMAGED: 'Damaged packaging or contents',
  WET_OR_CONTAMINATED: 'Wet, stained or contaminated',
  EXPIRED_OR_SHORT_DATED: 'Expired or short-dated stock'
}

// Reason codes, in the order they are reported (kept stable for eLMIS proof of delivery).
const REASON_TEXT = {
  PACKAGE_NOT_SCANNED: 'Not every package label was scanned',
  SEAL_DAMAGED: 'Seal damaged',
  SEAL_MISSING: 'Seal missing',
  SEAL_NUMBER_MISMATCH: 'Seal number does not match dispatch record',
  BATCH_MISMATCH: 'Batch on package does not match shipment record',
  CONDITION_DAMAGED: 'Goods damaged',
  CONDITION_WET_OR_CONTAMINATED: 'Goods wet or contaminated',
  CONDITION_EXPIRED_OR_SHORT_DATED: 'Goods expired or short-dated',
  QUANTITY_MISMATCH: 'Quantity received differs from quantity shipped',
  EXPIRED: 'Batch expiry date has passed',
  TEMPERATURE_EXCURSION: 'Temperature went outside the permitted range in transit (needs pharmacist review)',
  CUSTODY_INCOMPLETE: 'Custody history is incomplete',
  EVIDENCE_INVALID: 'Receipt photo missing or failed its integrity check'
}

const REQUIRED_HISTORY = ['CREATE', 'DISPATCH', 'DEPART', 'ARRIVE']
const SHORT_DATED_DAYS = 180

const digits = (v) => String(v || '').replace(/\D/g, '')

/**
 * @param shipment   stored shipment (with packages[].sealNumber)
 * @param input      clinic answers: packages[{packageNo, seal, sealNumber}], batchMatches, condition, quantityReceived
 * @param context    { events, scannedPackages, evidence: {present, intact, detail}, coldChain (analysis|null), user, now, revealSeal }
 *                   revealSeal=false (preview) never compares seal numbers, so the clinic cannot probe for them.
 */
function evaluateReceipt (shipment, input, context) {
  const now = context.now || new Date()
  const checks = []
  const add = (id, group, label, result, reason, mandatory = true) => checks.push({ id, group, label, result, reason, mandatory })
  const answers = input.packages || []

  // ------------------------------------------------------------------ identity
  const scanned = shipment.packages.filter(p => context.scannedPackages && context.scannedPackages[p.packageNo])
  add('labels', 'identity', 'Signed QR labels', scanned.length === shipment.packages.length ? PASS : FAIL,
    scanned.length === shipment.packages.length
      ? `All ${shipment.packages.length} package label(s) scanned; each signature verified for this shipment and facility`
      : `${scanned.length} of ${shipment.packages.length} package labels scanned. Unscanned packages are not verified.`)

  const ownFacility = context.user && context.user.facilityCode === shipment.destinationFacilityCode
  add('facility', 'identity', 'Addressed to this facility', ownFacility ? PASS : FAIL,
    ownFacility ? 'Shipment destination matches your facility' : 'Shipment is addressed to a different facility')

  const actions = (context.events || []).map(e => e.action)
  const missing = REQUIRED_HISTORY.filter(a => !actions.includes(a))
  const seqOk = (context.events || []).every((e, i) => e.seq === i + 1)
  add('custody', 'identity', 'Custody history', missing.length === 0 && seqOk ? PASS : FAIL,
    missing.length === 0 && seqOk
      ? 'Registered, dispatched, handed to transport and arrival recorded on the ledger, in order'
      : missing.length ? `Missing custody steps: ${missing.join(', ').toLowerCase()}` : 'Custody events are out of sequence')

  add('batch', 'identity', 'Batch / lot number', input.batchMatches === true ? PASS : input.batchMatches === false ? FAIL : NOT_CHECKED,
    input.batchMatches === true ? `Matches ${shipment.batch}` : input.batchMatches === false ? `Batch on the package is not ${shipment.batch}` : 'Not answered')

  // ------------------------------------------------------------------ seals
  for (const p of shipment.packages) {
    const a = answers.find(x => Number(x.packageNo) === p.packageNo) || {}
    const seal = a.seal
    add(`seal-${p.packageNo}`, 'seal', `Seal condition, package ${p.packageNo}`,
      seal === 'INTACT' ? PASS : seal === 'DAMAGED' || seal === 'MISSING' ? FAIL : NOT_CHECKED,
      seal === 'INTACT' ? 'Intact, not lifted' : seal === 'DAMAGED' ? 'Seal reported damaged' : seal === 'MISSING' ? 'No seal on the package' : 'Not answered')

    const observed = digits(a.sealNumber)
    let result, reason
    let deferred = false
    if (seal === 'MISSING') {
      result = NOT_CHECKED; reason = 'No seal to read'
    } else if (!observed) {
      result = seal === 'INTACT' ? FAIL : NOT_CHECKED; reason = 'No seal number entered'
    } else if (!context.revealSeal) {
      result = NOT_CHECKED; deferred = true; reason = 'Compared with the dispatch record when you confirm (the expected number is never shown)'
    } else if (!p.sealNumber) {
      result = FAIL; reason = 'No seal number was recorded at dispatch'
    } else if (observed === digits(p.sealNumber)) {
      result = PASS; reason = 'Number read matches the dispatch record'
    } else {
      result = FAIL; reason = `Number read (${String(a.sealNumber).trim().toUpperCase().slice(0, 40)}) does not match the dispatch record`
    }
    // Mandatory for an intact seal; a mismatch always counts. A damaged/missing seal already fails above.
    add(`seal-number-${p.packageNo}`, 'identity', `Seal number, package ${p.packageNo}`, result, reason, seal === 'INTACT' || result === FAIL)
    if (deferred) checks[checks.length - 1].deferred = true
  }

  // ------------------------------------------------------------------ goods
  const qty = Number(input.quantityReceived)
  const qtyKnown = Number.isInteger(qty) && qty >= 0
  add('quantity', 'goods', 'Quantity', !qtyKnown ? NOT_CHECKED : qty === shipment.quantity ? PASS : FAIL,
    !qtyKnown ? 'Not counted' : qty === shipment.quantity ? `${qty} of ${shipment.quantity} counted`
      : `${qty} of ${shipment.quantity} counted (${qty < shipment.quantity ? `${shipment.quantity - qty} short` : `${qty - shipment.quantity} over`})`)

  add('condition', 'goods', 'Condition of goods', !input.condition ? NOT_CHECKED : input.condition === 'GOOD' ? PASS : FAIL,
    CONDITION_TEXT[input.condition] || 'Not answered')

  if (!shipment.expiry) {
    add('expiry', 'goods', 'Expiry date', NOT_CHECKED, 'No expiry date on the shipment record', false)
  } else {
    const days = Math.floor((new Date(shipment.expiry) - now) / 86400000)
    if (days < 0) add('expiry', 'goods', 'Expiry date', FAIL, `Expired on ${shipment.expiry}`)
    else if (days < SHORT_DATED_DAYS) add('expiry', 'goods', 'Expiry date', WARNING, `Expires in ${days} days (${shipment.expiry}); issue first`, false)
    else add('expiry', 'goods', 'Expiry date', PASS, `Expires ${shipment.expiry}`)
  }

  const cc = context.coldChain
  if (!shipment.coldChain) {
    add('cold-chain', 'goods', 'Temperature in transit', NOT_CHECKED, 'No temperature requirement for this item', false)
  } else if (!cc || cc.status === 'NO_DATA') {
    add('cold-chain', 'goods', 'Temperature in transit', WARNING, `Cold-chain item (${shipment.coldChain.minC}–${shipment.coldChain.maxC} °C) but no temperature log was received. Not verified.`, false)
  } else if (cc.status === 'EXCURSION') {
    add('cold-chain', 'goods', 'Temperature in transit', FAIL,
      `Outside ${cc.range.minC}–${cc.range.maxC} °C for ${cc.totalExcursionMinutes} min (peak ${cc.peakC} °C)${cc.simulated ? ', simulated logger' : ''}. Needs pharmacist review; this alone does not mean the stock is unusable.`)
  } else {
    add('cold-chain', 'goods', 'Temperature in transit', PASS,
      `${cc.count} readings within ${cc.range.minC}–${cc.range.maxC} °C${cc.simulated ? ' (simulated logger)' : ''}`)
  }

  // ------------------------------------------------------------------ evidence
  const ev = context.evidence || {}
  add('evidence', 'evidence', 'Receipt photo', !ev.present ? FAIL : ev.intact ? PASS : FAIL,
    !ev.present ? 'No photo attached' : ev.intact ? `Stored; content re-hashed and matches its CID${ev.detail ? ` (${ev.detail})` : ''}` : `Integrity check failed: ${ev.detail || 'content does not match its CID'}`)

  // ------------------------------------------------------------------ decision
  const mandatory = checks.filter(c => c.mandatory)
  // Deferred checks (seal numbers in a preview) are neither passes nor failures yet.
  const failures = mandatory.filter(c => c.result !== PASS && !c.deferred)
  const pendingSeal = mandatory.some(c => c.deferred)
  const decision = failures.length ? 'DISPUTE' : pendingSeal ? 'CLEAN_IF_SEALS_MATCH' : 'CLEAN'

  const sealAnswers = shipment.packages.map(p => (answers.find(x => Number(x.packageNo) === p.packageNo) || {}).seal)
  const seal = sealAnswers.includes('MISSING') ? 'MISSING' : sealAnswers.includes('DAMAGED') ? 'DAMAGED' : sealAnswers.every(s => s === 'INTACT') ? 'INTACT' : 'UNCHECKED'
  const groupOk = (...groups) => mandatory.filter(c => groups.includes(c.group)).every(c => c.result === PASS)
  const contract = { seal, identityOk: groupOk('identity'), conditionOk: groupOk('goods', 'evidence') }
  if (context.revealSeal && (decision === 'CLEAN') !== (contract.seal === 'INTACT' && contract.identityOk && contract.conditionOk)) {
    throw new Error('Verification invariant broken: decision and ledger facts disagree')
  }

  const failed = (id) => checks.some(c => c.id === id && c.result === FAIL)
  const anyFailed = (prefix) => checks.some(c => c.id.startsWith(prefix) && c.result === FAIL)
  const reasons = []
  if (failed('labels')) reasons.push('PACKAGE_NOT_SCANNED')
  if (sealAnswers.includes('DAMAGED')) reasons.push('SEAL_DAMAGED')
  if (sealAnswers.includes('MISSING')) reasons.push('SEAL_MISSING')
  if (anyFailed('seal-number-')) reasons.push('SEAL_NUMBER_MISMATCH')
  if (failed('batch')) reasons.push('BATCH_MISMATCH')
  if (failed('condition')) reasons.push(`CONDITION_${input.condition}`)
  if (failed('quantity')) reasons.push('QUANTITY_MISMATCH')
  if (failed('expiry')) reasons.push('EXPIRED')
  if (failed('cold-chain')) reasons.push('TEMPERATURE_EXCURSION')
  if (failed('custody') || failed('facility')) reasons.push('CUSTODY_INCOMPLETE')
  if (failed('evidence')) reasons.push('EVIDENCE_INVALID')

  return {
    decision,
    summary: decision === 'DISPUTE'
      ? `${failures.length} mandatory check(s) did not pass`
      : decision === 'CLEAN_IF_SEALS_MATCH'
        ? 'Every other mandatory check passed; seal numbers are compared when you confirm'
        : `All ${mandatory.length} mandatory checks passed${checks.some(c => c.result === WARNING) ? ', with warnings to note' : ''}`,
    checks,
    reasons,
    reasonText: reasons.map(r => REASON_TEXT[r] || r),
    contract,
    // What this does and does not prove, shown with every decision.
    limits: 'Confirms the label, seal, custody record and photo integrity. It does not prove the contents are genuine medicine.'
  }
}

module.exports = { evaluateReceipt, REASON_TEXT, CONDITION_TEXT, PASS, WARNING, FAIL, NOT_CHECKED }
