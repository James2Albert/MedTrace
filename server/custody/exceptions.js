/**
 * Operational exceptions for the auditor, computed only from stored records (shipments,
 * custody events, receipts, scans, temperature logs, the ledger journal and evidence files).
 *
 * The review priority is a transparent sum of explicit rule weights. It orders the work
 * queue; it is NOT a validated fraud prediction. Missing information is listed separately
 * and never adds points.
 */

const RULES = {
  EVIDENCE_INTEGRITY: { points: 40, text: 'Stored evidence no longer matches its hash' },
  LEDGER_MISMATCH: { points: 40, text: 'Record does not match the ledger' },
  SEAL_BROKEN: { points: 35, text: 'Seal reported damaged or missing at receipt' },
  SEAL_NUMBER_MISMATCH: { points: 35, text: 'Seal number read at receipt differs from dispatch' },
  LABEL_TAMPER_ATTEMPT: { points: 30, text: 'Altered or counterfeit label scanned for this shipment' },
  BATCH_MISMATCH: { points: 25, text: 'Batch at receipt differs from the record' },
  TEMPERATURE_EXCURSION: { points: 25, text: 'Temperature outside the permitted range in transit' },
  CUSTODY_GAP: { points: 25, text: 'Custody history has gaps' },
  QUANTITY_MISMATCH: { points: 15, text: 'Quantity received differs from quantity shipped' },
  CONDITION_PROBLEM: { points: 15, text: 'Goods reported damaged, wet or expired' },
  OVERDUE: { points: 15, text: 'In transit longer than the delivery window' },
  WRONG_FACILITY_SCAN: { points: 10, text: 'Scanned at a facility it was not addressed to' },
  RECOVERED_FROM_LEDGER: { points: 10, text: 'Custody steps recovered from the ledger without their details' }
}

const FINAL = ['RECEIVED', 'ACCEPTED', 'REJECTED']
const level = (score) => score >= 50 ? 'HIGH' : score >= 20 ? 'MEDIUM' : 'LOW'

async function buildExceptions ({ store, custody, evidence, config, now = new Date() }) {
  const exceptions = []
  const scores = {}
  const slaMs = (config.transitSlaHours || 48) * 3600 * 1000

  for (const s of store.data.shipments) {
    const factors = []
    const missing = []
    const factor = (rule, detail) => { if (!factors.some(f => f.rule === rule)) factors.push({ rule, points: RULES[rule].points, text: RULES[rule].text, detail }) }
    const issue = (type, severity, title, reason, at, action) => exceptions.push({
      shipmentId: s.id, type, severity, title, reason, at, state: s.state, stateLabel: custody.summary(s).stateLabel, action
    })
    const events = store.eventsFor(s.id)
    const open = !FINAL.includes(s.state)

    // Disputes waiting for an auditor.
    if (s.state === 'DISPUTED') issue('DISPUTE_OPEN', 'high', 'Disputed receipt', (s.dispute && s.dispute.reasons || []).join('; ') || 'Disputed', s.dispute ? s.dispute.openedAt : s.updatedAt, 'Investigate')
    if (s.state === 'INVESTIGATED') issue('DECISION_DUE', 'medium', 'Investigation recorded, decision due', s.dispute && s.dispute.findings, s.dispute ? s.dispute.investigatedAt : s.updatedAt, 'Accept or reject')

    // What the receipt found.
    const r = s.receipt
    if (r) {
      if (r.packages.some(p => p.seal !== 'INTACT')) factor('SEAL_BROKEN', r.packages.filter(p => p.seal !== 'INTACT').map(p => `package ${p.packageNo}: ${p.seal.toLowerCase()}`).join(', '))
      const mismatched = r.packages.filter(p => p.sealNumberMatches === false)
      if (mismatched.length) {
        factor('SEAL_NUMBER_MISMATCH', mismatched.map(p => `package ${p.packageNo}: read ${p.observedSealNumber}, dispatched ${p.expectedSealNumber}`).join('; '))
        if (open) issue('SEAL_MISMATCH', 'high', 'Seal number mismatch', mismatched.map(p => `Package ${p.packageNo}: read ${p.observedSealNumber}, dispatched ${p.expectedSealNumber}`).join('; '), r.at, 'Inspect seal evidence')
      }
      if (!r.batchMatches) factor('BATCH_MISMATCH', `record ${s.batch}`)
      if (r.quantityReceived !== s.quantity) factor('QUANTITY_MISMATCH', `${r.quantityReceived} of ${s.quantity}`)
      if (r.condition !== 'GOOD') factor('CONDITION_PROBLEM', r.condition.toLowerCase().replace(/_/g, ' '))
      try {
        await evidence.get(r.evidence.cid)
      } catch (e) {
        factor('EVIDENCE_INTEGRITY', `receipt photo: ${e.message}`)
        issue('EVIDENCE_INTEGRITY', 'high', 'Evidence integrity failure', `Receipt photo ${r.evidence.cid}: ${e.message}`, now.toISOString(), 'Verify against ledger')
      }
    }

    // Temperature.
    const cc = custody.coldChainStatus(s)
    if (cc && cc.status === 'EXCURSION') {
      factor('TEMPERATURE_EXCURSION', `${cc.totalExcursionMinutes} min, peak ${cc.peakC} °C${cc.simulated ? ' (simulated logger)' : ''}`)
      if (open) issue('TEMPERATURE_EXCURSION', 'medium', `Temperature excursion${cc.simulated ? ' (simulated data)' : ''}`, `Outside ${cc.range.minC}–${cc.range.maxC} °C for ${cc.totalExcursionMinutes} min, peak ${cc.peakC} °C. Needs pharmacist review.`, cc.excursions[0].start, 'Review temperature log')
    } else if (cc && cc.status === 'NO_DATA' && ['DISPATCHED', 'IN_TRANSIT', 'RECEIPT_PENDING', 'RECEIVED'].includes(s.state)) {
      missing.push(`Cold-chain item (${s.coldChain.minC}–${s.coldChain.maxC} °C) with no temperature log`)
    }
    if (s.temperatureLog) {
      try {
        await evidence.get(s.temperatureLog.cid)
      } catch (e) {
        factor('EVIDENCE_INTEGRITY', `temperature log: ${e.message}`)
        issue('EVIDENCE_INTEGRITY', 'high', 'Evidence integrity failure', `Temperature log ${s.temperatureLog.cid}: ${e.message}`, now.toISOString(), 'Verify against ledger')
      }
    }

    // Overdue deliveries (window measured from hand-over to transport).
    const depart = events.find(e => e.action === 'DEPART')
    if (depart && ['IN_TRANSIT', 'RECEIPT_PENDING'].includes(s.state)) {
      const due = new Date(new Date(depart.at).getTime() + slaMs)
      if (now > due) {
        const hours = Math.round((now - due) / 3600000)
        factor('OVERDUE', `${hours} h past the ${config.transitSlaHours || 48} h window`)
        issue('OVERDUE', 'medium', 'Delivery overdue', `Left the warehouse ${depart.at.slice(0, 16).replace('T', ' ')}; ${hours} h past the delivery window`, due.toISOString(), 'Contact transport / facility')
      }
    }

    // Custody record integrity.
    if (events.some((e, i) => e.seq !== i + 1)) {
      factor('CUSTODY_GAP', 'event sequence has gaps')
      issue('CUSTODY_GAP', 'high', 'Missing custody events', 'Custody event sequence has gaps', s.updatedAt, 'Reconcile with ledger')
    }
    const pendingOps = custody.unresolvedOps(s.id)
    const rec = s.reconciliation
    if (pendingOps.length) {
      issue('RECONCILIATION', 'medium', 'Ledger update awaiting confirmation', `${pendingOps.map(o => o.action.toLowerCase()).join(', ')} sent ${pendingOps[0].submittedAt || pendingOps[0].createdAt}`, pendingOps[0].createdAt, 'Reconcile with ledger')
    } else if (rec && rec.status === 'INCONSISTENT') {
      factor('LEDGER_MISMATCH', rec.note)
      issue('RECONCILIATION', 'high', 'Record does not match ledger', rec.note, rec.at, 'Reconcile with ledger')
    } else if (rec && rec.status === 'PARTIAL') {
      factor('RECOVERED_FROM_LEDGER', rec.note)
      issue('RECONCILIATION', 'medium', 'Recovered from ledger, details missing', rec.note, rec.at, 'Review custody record')
    }
    if (s.lastLedgerCheck && s.lastLedgerCheck.status === 'INCONSISTENT' && !(rec && rec.status === 'INCONSISTENT')) {
      factor('LEDGER_MISMATCH', 'last ledger verification failed')
      issue('RECONCILIATION', 'high', 'Ledger verification failed', 'The last "Verify against ledger" found differences', s.lastLedgerCheck.at, 'Reconcile with ledger')
    }

    // Suspicious scans recorded against this shipment.
    const scans = store.data.scans.filter(x => x.shipmentId === s.id)
    const tampered = scans.filter(x => x.result === 'LABEL_TAMPERED')
    const wrongFacility = scans.filter(x => x.result === 'WRONG_FACILITY')
    if (tampered.length) {
      factor('LABEL_TAMPER_ATTEMPT', `${tampered.length} attempt(s)`)
      issue('SUSPICIOUS_SCAN', 'high', 'Counterfeit or altered label scanned', `${tampered.length} attempt(s), last by ${tampered[tampered.length - 1].by.name}${tampered[tampered.length - 1].by.facilityName ? `, ${tampered[tampered.length - 1].by.facilityName}` : ''}`, tampered[tampered.length - 1].at, 'Inspect scan log')
    }
    if (wrongFacility.length) {
      factor('WRONG_FACILITY_SCAN', `${wrongFacility.length} attempt(s)`)
      if (open) issue('WRONG_FACILITY_SCAN', 'low', 'Scanned at the wrong facility', `${wrongFacility.length} attempt(s), last at ${wrongFacility[wrongFacility.length - 1].by.facilityName || wrongFacility[wrongFacility.length - 1].by.name}`, wrongFacility[wrongFacility.length - 1].at, 'Confirm package location')
    }

    const score = factors.reduce((n, f) => n + f.points, 0)
    scores[s.id] = { score, level: level(score), factors, missing }
  }

  // Labels that matched no shipment at all.
  for (const x of store.data.scans.filter(sc => sc.result === 'UNKNOWN_SHIPMENT')) {
    exceptions.push({ shipmentId: null, type: 'UNKNOWN_LABEL', severity: 'medium', title: 'Label for an unknown shipment', reason: `Scanned by ${x.by.name}${x.by.facilityName ? `, ${x.by.facilityName}` : ''}: ${x.code}`, at: x.at, state: null, stateLabel: null, action: 'Report to MSD' })
  }

  const rank = { high: 0, medium: 1, low: 2 }
  exceptions.sort((a, b) => rank[a.severity] - rank[b.severity] || ((scores[b.shipmentId] || {}).score || 0) - ((scores[a.shipmentId] || {}).score || 0) || String(b.at).localeCompare(String(a.at)))
  const counts = {}
  exceptions.forEach(e => { counts[e.type] = (counts[e.type] || 0) + 1 })
  return {
    generatedAt: now.toISOString(),
    method: 'Rule-based review priority: each rule adds fixed points (listed per shipment). It orders the review queue; it is not a validated fraud prediction.',
    rules: Object.entries(RULES).map(([rule, r]) => ({ rule, points: r.points, text: r.text })),
    exceptions,
    counts,
    shipments: scores
  }
}

module.exports = { buildExceptions, RULES }
