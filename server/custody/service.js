const crypto = require('crypto')
const EventEmitter = require('events')
const { ethers } = require('ethers')
const labels = require('../labels')
const coldchain = require('../coldchain')
const { assertTransition, allowedActions, verificationStatus, STATE_LABELS, TransitionError } = require('./stateMachine')
const { evaluateReceipt, REASON_TEXT, CONDITION_TEXT } = require('./verification')

const SEAL_RESULTS = ['INTACT', 'DAMAGED', 'MISSING']
const CONDITIONS = CONDITION_TEXT
const UNRESOLVED = ['PENDING', 'SUBMITTED', 'UNKNOWN']
const OUTCOME_ACTIONS = ['RECEIVE', 'DISPUTE', 'ACCEPT', 'REJECT']

class ScanError extends Error {
  constructor (code, message, status = 422, extra = {}) {
    super(message)
    this.code = code
    this.status = status
    this.extra = extra
  }
}

/** The transaction was broadcast but its outcome is not known yet. Never reported as success. */
class UnconfirmedError extends Error {
  constructor (shipmentId) {
    super('The update was sent to the ledger but its confirmation did not arrive, so it is NOT shown as done. MedTrace checks the ledger and completes the record automatically. Do not repeat the action; refresh in a minute.')
    this.status = 503
    this.code = 'LEDGER_UNCONFIRMED'
    this.extra = { shipmentId }
  }
}

function hashJson (value) {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(JSON.stringify(value)))
}

function badRequest (message) {
  return new TransitionError(message, 400, 'BAD_REQUEST')
}

class CustodyService extends EventEmitter {
  constructor ({ store, chain, wallets, evidence, config, links }) {
    super()
    this.store = store
    this.chain = chain
    this.wallets = wallets
    this.evidence = evidence
    this.links = links || null
    this.config = config
    this.labelSecret = config.labelSecret
    this.lock = Promise.resolve()
  }

  /** Serialises every custody mutation: no two requests can race on one shipment. */
  exclusive (fn) {
    const run = this.lock.then(fn, fn)
    this.lock = run.catch(() => {})
    return run
  }

  get (id) {
    const shipment = this.store.shipment(id)
    if (!shipment) throw new TransitionError(`Shipment ${id} not found`, 404, 'NOT_FOUND')
    return shipment
  }

  actorOf (user) {
    const facility = user.facilityCode ? this.store.facility(user.facilityCode) : null
    return { userId: user.id, name: user.name, role: user.role, facilityCode: user.facilityCode || null, facilityName: facility ? facility.name : null }
  }

  // --------------------------------------------------------------- ledger journal

  unresolvedOps (shipmentId) {
    return this.store.data.operations.filter(o => o.shipmentId === shipmentId && UNRESOLVED.includes(o.status))
  }

  /** A retried request (same Idempotency-Key from the same user) returns the original result. */
  replayed (user, requestId) {
    if (!requestId) return null
    const op = this.store.data.operations.slice().reverse().find(o => o.requestId === requestId && o.userId === user.id)
    if (!op || op.status === 'FAILED') return null
    if (UNRESOLVED.includes(op.status)) throw new TransitionError('This request is still being confirmed by the ledger.', 409, 'REQUEST_IN_PROGRESS')
    return this.get(op.shipmentId)
  }

  /**
   * The only path to the ledger. Journals the operation before signing, records the transaction
   * hash before broadcast, and changes the local record only after confirmation.
   */
  async commit ({ user, shipmentId, action, details, ref, effects = {}, requestId, send }) {
    if (this.unresolvedOps(shipmentId).length) {
      await this._reconcileShipment(shipmentId)
      if (this.unresolvedOps(shipmentId).length) {
        throw new TransitionError('An earlier ledger update for this shipment is still awaiting confirmation. Try again shortly.', 409, 'RECONCILIATION_PENDING')
      }
    }
    const op = {
      id: crypto.randomUUID(),
      requestId: requestId ? String(requestId).slice(0, 100) : null,
      userId: user.id,
      actor: this.actorOf(user),
      shipmentId,
      action,
      ref,
      details,
      effects,
      status: 'PENDING',
      createdAt: new Date().toISOString(),
      txHash: null
    }
    this.store.data.operations.push(op)
    this.store.save()

    let result
    try {
      result = await send({
        onSigned: (txHash) => {
          op.txHash = txHash
          op.status = 'SUBMITTED'
          op.submittedAt = new Date().toISOString()
          this.store.save()
        }
      })
    } catch (err) {
      op.error = err.reason || err.message
      if (op.txHash && err.code !== 'LEDGER_REJECTED') {
        // Broadcast, outcome unknown (timeout, connection lost). Reconciliation settles it.
        op.status = 'UNKNOWN'
        this.get(shipmentId).reconciliation = { status: 'PENDING', since: op.submittedAt, note: 'A ledger update is awaiting confirmation.' }
        this.store.save()
        throw new UnconfirmedError(shipmentId)
      }
      op.status = 'FAILED' // rejected by the contract, or never broadcast
      op.closedAt = new Date().toISOString()
      this.store.save()
      throw err
    }
    return this.applyConfirmed(op, result)
  }

  /** Writes the confirmed event and its effects. Used for live writes and for recovery. */
  applyConfirmed (op, result, { recovered = false } = {}) {
    if (op.action === 'CREATE' && !this.store.shipment(op.shipmentId)) this.store.data.shipments.push(op.effects.shipment)
    const shipment = this.get(op.shipmentId)
    const now = new Date().toISOString()
    if (!this.store.data.events.some(e => e.chain.txHash === result.txHash)) {
      this.store.data.events.push({
        id: crypto.randomUUID(),
        shipmentId: shipment.id,
        seq: result.seq,
        action: op.action,
        fromState: result.fromState,
        toState: result.toState,
        at: recovered ? (op.submittedAt || op.createdAt) : now,
        actor: op.actor,
        details: op.details,
        ref: op.ref,
        chain: { txHash: result.txHash, blockNumber: result.blockNumber, signer: result.signer },
        opId: op.id,
        ...(recovered ? { recoveredAt: now } : {})
      })
      shipment.state = result.toState
      shipment.updatedAt = now
      this.applyEffects(shipment, op, result)
    }
    Object.assign(op, { status: recovered ? 'RECONCILED' : 'CONFIRMED', txHash: result.txHash, blockNumber: result.blockNumber, seq: result.seq, closedAt: now })
    if (!this.unresolvedOps(shipment.id).length && shipment.reconciliation && shipment.reconciliation.status === 'PENDING') {
      shipment.reconciliation = recovered ? { status: 'RECOVERED', at: now, note: 'A ledger update confirmed after an interruption was completed automatically.' } : null
    }
    this.store.save()
    if (OUTCOME_ACTIONS.includes(op.action)) this.emit('outcome', shipment)
    return shipment
  }

  applyEffects (shipment, op, result) {
    const fx = op.effects || {}
    switch (op.action) {
      case 'DISPATCH':
        shipment.packages.forEach(p => {
          const s = fx.seals.find(x => x.packageNo === p.packageNo)
          if (s) p.sealNumber = s.sealNumber
        })
        break
      case 'ARRIVE':
        shipment.receiptDraft = shipment.receiptDraft || { startedAt: op.createdAt, scannedPackages: {}, evidence: null }
        shipment.receiptDraft.scannedPackages[fx.packageNo] = { at: op.createdAt, by: op.actor.name }
        break
      case 'RECEIVE':
        shipment.receipt = { ...fx.receipt, txHash: result.txHash, blockNumber: result.blockNumber, ledgerOutcome: result.toState }
        if (result.toState === 'DISPUTED') {
          shipment.dispute = { openedAt: fx.receipt.at, openedBy: op.actor.name, automatic: true, reasons: fx.receipt.verification.reasonText }
        }
        shipment.receiptDraft = null
        break
      case 'DISPUTE':
        shipment.dispute = { openedAt: op.createdAt, openedBy: op.actor.name, automatic: false, reasons: [op.details.reason] }
        shipment.receiptDraft = null
        break
      case 'INVESTIGATE':
        shipment.dispute = { ...shipment.dispute, findings: op.details.findings, investigatedBy: op.actor.name, investigatedAt: op.createdAt }
        break
      case 'ACCEPT':
      case 'REJECT':
        shipment.dispute = { ...shipment.dispute, decision: op.action, decisionNotes: op.details.notes, decidedBy: op.actor.name, decidedAt: op.createdAt }
        break
    }
  }

  // --------------------------------------------------------------- reconciliation

  reconcileShipment (id) {
    return this.exclusive(() => this._reconcileShipment(id))
  }

  /** Reconciles every shipment (and every journaled creation) with the ledger. Safe to repeat. */
  reconcileAll () {
    return this.exclusive(async () => {
      const ids = new Set([
        ...this.store.data.operations.filter(o => UNRESOLVED.includes(o.status)).map(o => o.shipmentId),
        ...this.store.data.shipments.map(s => s.id)
      ])
      const reports = []
      for (const id of ids) {
        try {
          reports.push(await this._reconcileShipment(id))
        } catch (e) {
          reports.push({ shipmentId: id, error: e.message })
        }
      }
      return reports
    })
  }

  async _reconcileShipment (id) {
    const report = { shipmentId: id, applied: [], failed: [], pending: [], recovered: [], problems: [] }
    for (const op of this.unresolvedOps(id).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const outcome = op.txHash ? await this.chain.txOutcome(op.txHash) : { status: 'NOT_FOUND' }
      if (outcome.status === 'CONFIRMED') {
        this.applyConfirmed(op, outcome.result, { recovered: true })
        report.applied.push(op.action)
      } else if (outcome.status === 'PENDING' || (outcome.status === 'NOT_FOUND' && op.txHash && await this.chain.relayerHasPending())) {
        report.pending.push(op.action)
      } else {
        // Reverted, or never reached the node: safe to report as failed and retry.
        Object.assign(op, { status: 'FAILED', error: outcome.status === 'FAILED' ? 'Transaction reverted' : 'Transaction never reached the ledger', closedAt: new Date().toISOString() })
        report.failed.push(op.action)
      }
    }

    const shipment = this.store.shipment(id)
    if (shipment && report.pending.length === 0) {
      const onChain = await this.chain.readShipment(id)
      const local = this.store.eventsFor(id)
      for (const ev of onChain.events) {
        const mine = local.find(l => l.seq === ev.seq)
        if (mine && mine.chain.txHash !== ev.txHash) report.problems.push(`Event ${ev.seq} differs from the ledger`)
        if (mine) continue
        // On the ledger but not in the record, and no journal entry describes it.
        const signer = this.store.data.users.find(u => u.address && u.address.toLowerCase() === ev.actor.toLowerCase())
        this.store.data.events.push({
          id: crypto.randomUUID(),
          shipmentId: id,
          seq: ev.seq,
          action: ev.action,
          fromState: ev.fromState,
          toState: ev.toState,
          at: new Date().toISOString(),
          actor: signer ? this.actorOf(signer) : { name: 'Unregistered signer', role: null, facilityName: null },
          details: { recoveredFromLedger: true },
          ref: ev.ref,
          chain: { txHash: ev.txHash, blockNumber: ev.blockNumber, signer: ev.actor },
          recoveredAt: new Date().toISOString()
        })
        report.recovered.push(ev.action)
      }
      if (local.some(l => !onChain.events.find(e => e.seq === l.seq))) report.problems.push('The record has custody events the ledger does not')
      if (report.recovered.length && !report.problems.length) {
        shipment.state = onChain.state
        shipment.updatedAt = new Date().toISOString()
        if (onChain.state !== 'RECEIPT_PENDING') shipment.receiptDraft = null
        shipment.reconciliation = {
          status: 'PARTIAL',
          at: new Date().toISOString(),
          note: `Custody step(s) ${report.recovered.join(', ').toLowerCase()} were recovered from the ledger. Their off-chain details (seal numbers, photos, notes) were not available and need review.`
        }
      }
    }
    if (shipment) {
      if (report.pending.length) shipment.reconciliation = { status: 'PENDING', at: new Date().toISOString(), note: 'A ledger update is awaiting confirmation.' }
      else if (report.problems.length) shipment.reconciliation = { status: 'INCONSISTENT', at: new Date().toISOString(), note: report.problems.join('; ') }
      else if (shipment.reconciliation && shipment.reconciliation.status === 'PENDING') shipment.reconciliation = null
    }
    this.store.save()
    return report
  }

  // --------------------------------------------------------------- creation

  nextShipmentId () {
    const meta = this.store.data.meta
    meta.shipmentSeq = (meta.shipmentSeq || 0) + 1
    return `SHP-${new Date().getFullYear()}-${String(meta.shipmentSeq).padStart(5, '0')}`
  }

  createShipment (user, consignment) {
    return this.exclusive(async () => {
      if (user.role !== 'dispatcher') throw new TransitionError('Only dispatchers can create shipments', 403, 'FORBIDDEN')
      const facility = this.store.facility(consignment.destinationFacilityCode)
      if (!facility) throw badRequest(`Unknown destination facility ${consignment.destinationFacilityCode}`)
      const ref = consignment.externalRef
      const already = (list) => list.some(s => s.externalRef.shipmentId === ref.shipmentId && s.externalRef.lineNo === ref.lineNo)
      if (already(this.store.data.shipments) || already(this.store.data.operations.filter(o => o.action === 'CREATE' && UNRESOLVED.includes(o.status)).map(o => o.effects.shipment))) {
        throw new TransitionError(`eLMIS shipment ${ref.orderCode} line ${ref.lineNo} is already registered`, 409, 'DUPLICATE')
      }

      const id = this.nextShipmentId()
      const shipment = {
        id,
        externalRef: ref,
        source: consignment.source,
        donor: consignment.donor,
        programme: consignment.programme,
        destinationFacilityCode: consignment.destinationFacilityCode,
        commodity: consignment.commodity,
        unit: consignment.unit,
        batch: consignment.batch,
        expiry: consignment.expiry,
        quantity: consignment.quantity,
        coldChain: consignment.coldChain || null,
        packages: [],
        state: 'NONE',
        createdAt: new Date().toISOString(),
        updatedAt: null,
        receiptDraft: null,
        receipt: null,
        dispute: null,
        temperatureLog: null
      }
      for (let n = 1; n <= consignment.packages; n++) {
        shipment.packages.push({ packageNo: n, code: labels.codeFor(this.labelSecret, shipment, n), sealNumber: null })
      }
      const manifest = {
        id, externalRef: ref, destination: shipment.destinationFacilityCode, commodity: shipment.commodity.code,
        batch: shipment.batch, expiry: shipment.expiry, quantity: shipment.quantity, packages: shipment.packages.length,
        ...(shipment.coldChain ? { coldChain: shipment.coldChain } : {})
      }
      shipment.manifestHash = hashJson(manifest)

      await this.commit({
        user,
        shipmentId: id,
        action: 'CREATE',
        details: { manifest },
        ref: shipment.manifestHash,
        effects: { shipment },
        send: (hooks) => this.chain.createShipment(this.wallets.forUser(user), id, shipment.destinationFacilityCode, shipment.manifestHash, hooks)
      })
      return this.get(id)
    })
  }

  // --------------------------------------------------------------- dispatcher

  dispatch (user, id, { sealNumbers } = {}, requestId) {
    return this.exclusive(async () => {
      const prior = this.replayed(user, requestId)
      if (prior) return prior
      const shipment = this.get(id)
      assertTransition('DISPATCH', shipment, user)
      const seals = shipment.packages.map((p, i) => {
        const given = sealNumbers && sealNumbers[i] ? String(sealNumbers[i]).trim().toUpperCase().slice(0, 40) : ''
        return given || `MSD-S${crypto.randomInt(100000, 999999)}`
      })
      const details = { seals: shipment.packages.map((p, i) => ({ packageNo: p.packageNo, sealNumber: seals[i] })) }
      const ref = hashJson(details)
      return this.commit({
        user, shipmentId: id, action: 'DISPATCH', details, ref, effects: { seals: details.seals }, requestId,
        send: (hooks) => this.chain.transition(this.wallets.forUser(user), id, 'DISPATCH', ref, hooks)
      })
    })
  }

  depart (user, id, { vehicle, driver } = {}, requestId) {
    return this.exclusive(async () => {
      const prior = this.replayed(user, requestId)
      if (prior) return prior
      const shipment = this.get(id)
      assertTransition('DEPART', shipment, user)
      if (!vehicle || !String(vehicle).trim()) throw badRequest('Vehicle registration is required')
      const details = { vehicle: String(vehicle).trim().toUpperCase().slice(0, 20), driver: driver ? String(driver).trim().slice(0, 80) : null }
      const ref = hashJson(details)
      return this.commit({
        user, shipmentId: id, action: 'DEPART', details, ref, requestId,
        send: (hooks) => this.chain.transition(this.wallets.forUser(user), id, 'DEPART', ref, hooks)
      })
    })
  }

  // --------------------------------------------------------------- cold chain

  coldChainStatus (shipment) {
    if (!shipment.coldChain) return null
    const tolerance = shipment.coldChain.toleranceMinutes ?? this.config.coldChainToleranceMinutes ?? 15
    return coldchain.analyse(shipment.temperatureLog, shipment.coldChain, tolerance)
  }

  /**
   * Attaches the data-logger record for a cold-chain shipment. One log per shipment and it cannot
   * be replaced, so a later "clean" upload cannot hide an excursion. The log is stored
   * content-addressed alongside the photos.
   */
  attachTemperatureLog (user, id, body = {}) {
    return this.exclusive(async () => {
      const shipment = this.get(id)
      const allowed = user.role === 'dispatcher' || (user.role === 'clinic' && user.facilityCode === shipment.destinationFacilityCode)
      if (!allowed) throw new TransitionError('Only MSD dispatch or the receiving facility can attach a temperature log', 403, 'FORBIDDEN')
      if (!shipment.coldChain) throw badRequest('This item has no temperature requirement')
      if (!['DISPATCHED', 'IN_TRANSIT', 'RECEIPT_PENDING'].includes(shipment.state)) throw new TransitionError('A temperature log can only be attached between dispatch and receipt')
      if (shipment.temperatureLog) throw new TransitionError('A temperature log is already attached and cannot be replaced', 409, 'TEMPERATURE_LOG_EXISTS')
      const log = coldchain.normaliseLog(body)
      const stored = await this.evidence.put(Buffer.from(JSON.stringify({ shipmentId: id, ...log })), 'application/json', { internal: true })
      shipment.temperatureLog = { ...log, cid: stored.cid, sha256: stored.sha256, uploadedAt: new Date().toISOString(), uploadedBy: this.actorOf(user) }
      this.store.data.evidence.push({ ...stored, shipmentId: id, kind: 'temperature-log', uploadedBy: this.actorOf(user), at: shipment.temperatureLog.uploadedAt })
      const analysis = this.coldChainStatus(shipment)
      if (analysis.status === 'EXCURSION') {
        shipment.incidents = shipment.incidents || []
        shipment.incidents.push({
          type: 'TEMPERATURE_EXCURSION',
          at: shipment.temperatureLog.uploadedAt,
          simulated: analysis.simulated,
          summary: `Outside ${analysis.range.minC}–${analysis.range.maxC} °C for ${analysis.totalExcursionMinutes} min (peak ${analysis.peakC} °C)`,
          logCid: stored.cid
        })
      }
      this.store.save()
      return shipment
    })
  }

  // --------------------------------------------------------------- clinic

  logScan (user, raw, outcome) {
    this.store.data.scans.push({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      by: this.actorOf(user),
      code: String(raw || '').slice(0, 120),
      shipmentId: outcome.shipmentId || null,
      packageNo: outcome.packageNo || null,
      result: outcome.result,
      message: outcome.message
    })
    this.store.save()
  }

  /**
   * Validates a scanned label for the logged-in user. A destination clinic's first valid
   * scan of an in-transit shipment records arrival (IN_TRANSIT -> RECEIPT_PENDING).
   */
  scan (user, raw, { expectShipmentId } = {}) {
    return this.exclusive(async () => {
      const fail = (code, message, status, extra = {}) => {
        this.logScan(user, raw, { result: code, message, ...extra })
        throw new ScanError(code, message, status, extra)
      }
      const parsed = labels.parse(raw)
      if (!parsed) fail('INVALID_CODE', 'This is not a MedTrace package label.', 422)
      const shipment = this.store.shipment(parsed.shipmentId)
      if (!shipment) fail('UNKNOWN_SHIPMENT', `No shipment ${parsed.shipmentId} exists. Do not accept this package.`, 404, { shipmentId: parsed.shipmentId })
      if (!labels.verify(this.labelSecret, shipment, parsed)) {
        fail('LABEL_TAMPERED', 'Label failed verification. It may be altered or counterfeit. Do not accept this package.', 422, { shipmentId: shipment.id })
      }
      if (expectShipmentId && expectShipmentId !== shipment.id) {
        fail('DIFFERENT_SHIPMENT', `This package belongs to ${shipment.id}, not ${expectShipmentId}. Set it aside.`, 409, { shipmentId: shipment.id, packageNo: parsed.packageNo })
      }

      if (user.role !== 'clinic') {
        this.logScan(user, raw, { result: 'LOOKUP', message: 'Label verified (lookup only)', shipmentId: shipment.id, packageNo: parsed.packageNo })
        return { result: 'LOOKUP', shipment, packageNo: parsed.packageNo }
      }
      if (user.facilityCode !== shipment.destinationFacilityCode) {
        const dest = this.store.facility(shipment.destinationFacilityCode)
        fail('WRONG_FACILITY', `This shipment is addressed to ${dest ? dest.name : shipment.destinationFacilityCode}, not your facility. Do not accept it.`, 403, { shipmentId: shipment.id, packageNo: parsed.packageNo })
      }
      if (['CREATED', 'DISPATCHED'].includes(shipment.state)) {
        fail('NOT_IN_TRANSIT', 'This shipment has not been released for transport. Do not accept it; contact MSD.', 409, { shipmentId: shipment.id, packageNo: parsed.packageNo })
      }
      if (!['IN_TRANSIT', 'RECEIPT_PENDING'].includes(shipment.state)) {
        const receipt = shipment.receipt
        const when = receipt ? ` on ${new Date(receipt.at).toLocaleString('en-GB')}` : ''
        fail('ALREADY_PROCESSED', `This shipment was already processed${when} (${STATE_LABELS[shipment.state]}). It cannot be received twice.`, 409, { shipmentId: shipment.id, packageNo: parsed.packageNo })
      }

      let arrival = null
      if (shipment.state === 'IN_TRANSIT') {
        const details = { facilityCode: user.facilityCode, scannedPackage: parsed.packageNo }
        const ref = hashJson(details)
        await this.commit({
          user, shipmentId: shipment.id, action: 'ARRIVE', details, ref, effects: { packageNo: parsed.packageNo },
          send: (hooks) => this.chain.transition(this.wallets.forUser(user), shipment.id, 'ARRIVE', ref, hooks)
        })
        arrival = this.store.eventsFor(shipment.id).slice(-1)[0]
      } else {
        shipment.receiptDraft = shipment.receiptDraft || { startedAt: new Date().toISOString(), scannedPackages: {}, evidence: null }
        shipment.receiptDraft.scannedPackages[parsed.packageNo] = { at: new Date().toISOString(), by: user.name }
      }
      this.logScan(user, raw, { result: 'VERIFIED', message: 'Label verified for this facility', shipmentId: shipment.id, packageNo: parsed.packageNo })
      return { result: 'VERIFIED', shipment, packageNo: parsed.packageNo, arrival }
    })
  }

  addEvidence (user, id, buffer, mimeType) {
    return this.exclusive(async () => {
      const shipment = this.get(id)
      if (user.role !== 'clinic' || user.facilityCode !== shipment.destinationFacilityCode) {
        throw new TransitionError('Only the receiving facility can add receipt evidence', 403, 'FORBIDDEN')
      }
      if (shipment.state !== 'RECEIPT_PENDING') throw new TransitionError('Scan the package label before adding a photo')
      const stored = await this.evidence.put(buffer, mimeType)
      const entry = { ...stored, shipmentId: id, kind: 'receipt-photo', uploadedBy: this.actorOf(user), at: new Date().toISOString() }
      this.store.data.evidence.push(entry)
      shipment.receiptDraft.evidence = entry
      this.store.save()
      return entry
    })
  }

  /** Runs every receiving check. revealSeal=false is the clinic's preview and never compares seal numbers. */
  async evaluate (shipment, user, input, { revealSeal }) {
    const draft = shipment.receiptDraft || { scannedPackages: {}, evidence: null }
    let evidence = { present: false }
    const ev = draft.evidence
    if (ev && (!input.evidenceCid || input.evidenceCid === ev.cid)) {
      try {
        await this.evidence.get(ev.cid)
        evidence = { present: true, intact: true, detail: ev.storage === 'kubo' ? 'pinned to an IPFS node' : 'local IPFS-compatible store' }
      } catch (e) {
        evidence = { present: true, intact: false, detail: e.message }
      }
    }
    return evaluateReceipt(shipment, input, {
      events: this.store.eventsFor(shipment.id),
      scannedPackages: draft.scannedPackages,
      evidence,
      coldChain: this.coldChainStatus(shipment),
      user,
      revealSeal
    })
  }

  async previewReceipt (user, id, input = {}) {
    const shipment = this.get(id)
    assertTransition('RECEIVE', shipment, user)
    const result = await this.evaluate(shipment, user, input, { revealSeal: false })
    delete result.contract
    return result
  }

  confirmReceipt (user, id, input = {}, requestId) {
    return this.exclusive(async () => {
      const prior = this.replayed(user, requestId)
      if (prior) return prior
      const shipment = this.get(id)
      assertTransition('RECEIVE', shipment, user)
      const draft = shipment.receiptDraft || { scannedPackages: {}, evidence: null }

      if (!draft.evidence || draft.evidence.cid !== input.evidenceCid) throw badRequest('Take and upload a receipt photo first')
      for (const p of shipment.packages) {
        const check = (input.packages || []).find(c => Number(c.packageNo) === p.packageNo) || {}
        if (!SEAL_RESULTS.includes(check.seal)) throw badRequest(`Record the seal result for package ${p.packageNo}`)
        if (check.seal === 'INTACT' && !String(check.sealNumber || '').replace(/\D/g, '')) throw badRequest(`Enter the seal number on package ${p.packageNo}`)
      }
      if (!CONDITIONS[input.condition]) throw badRequest('Record the condition of the goods')
      const quantityReceived = Number(input.quantityReceived)
      if (!Number.isInteger(quantityReceived) || quantityReceived < 0) throw badRequest('Enter the quantity received')
      if (typeof input.batchMatches !== 'boolean') throw badRequest('Confirm whether the batch number matches')

      const result = await this.evaluate(shipment, user, { ...input, quantityReceived }, { revealSeal: true })
      const packageChecks = shipment.packages.map(p => {
        const a = input.packages.find(c => Number(c.packageNo) === p.packageNo)
        const numberCheck = result.checks.find(c => c.id === `seal-number-${p.packageNo}`)
        return {
          packageNo: p.packageNo,
          scanned: Boolean(draft.scannedPackages[p.packageNo]),
          seal: a.seal,
          expectedSealNumber: p.sealNumber,
          observedSealNumber: a.sealNumber ? String(a.sealNumber).trim().toUpperCase().slice(0, 40) : null,
          sealNumberMatches: numberCheck.result === 'PASS' ? true : numberCheck.result === 'FAIL' ? false : null
        }
      })
      const evidence = draft.evidence
      const facility = this.store.facility(user.facilityCode)
      const cc = this.coldChainStatus(shipment)
      const receipt = {
        at: new Date().toISOString(),
        facilityCode: user.facilityCode,
        facilityName: facility ? facility.name : user.facilityCode,
        receivedBy: user.id,
        receivedByName: user.name,
        packages: packageChecks,
        seal: result.contract.seal,
        batchMatches: input.batchMatches,
        condition: input.condition,
        quantityReceived,
        notes: input.notes ? String(input.notes).slice(0, 500) : '',
        verification: {
          result: result.decision === 'CLEAN' ? 'VERIFIED' : 'MISMATCH',
          decision: result.decision,
          summary: result.summary,
          limits: result.limits,
          checks: result.checks,
          reasons: result.reasons,
          reasonText: result.reasonText,
          sealOk: result.contract.seal === 'INTACT',
          identityOk: result.contract.identityOk,
          conditionOk: result.contract.conditionOk
        },
        evidence: { cid: evidence.cid, sha256: evidence.sha256, size: evidence.size, mimeType: evidence.mimeType, storage: evidence.storage, pinned: evidence.pinned },
        temperature: cc ? { status: cc.status, totalExcursionMinutes: cc.totalExcursionMinutes, logCid: shipment.temperatureLog ? shipment.temperatureLog.cid : null, simulated: Boolean(cc.simulated) } : null
      }
      const details = {
        verification: receipt.verification.result,
        reasons: result.reasons,
        seal: result.contract.seal,
        condition: input.condition,
        quantityReceived,
        evidenceCid: evidence.cid,
        evidenceSha256: evidence.sha256,
        facilityCode: user.facilityCode
      }
      return this.commit({
        user, shipmentId: id, action: 'RECEIVE', details, ref: '0x' + evidence.sha256, effects: { receipt }, requestId,
        send: (hooks) => this.chain.recordReceipt(this.wallets.forUser(user), id, {
          seal: result.contract.seal,
          conditionOk: result.contract.conditionOk,
          identityOk: result.contract.identityOk,
          evidenceHash: '0x' + evidence.sha256,
          evidenceCid: evidence.cid
        }, hooks)
      })
    })
  }

  // --------------------------------------------------------------- disputes

  dispute (user, id, { reason } = {}, requestId) {
    return this.exclusive(async () => {
      const prior = this.replayed(user, requestId)
      if (prior) return prior
      const shipment = this.get(id)
      assertTransition('DISPUTE', shipment, user)
      if (!reason || !String(reason).trim()) throw badRequest('Describe why the shipment is disputed')
      const details = { reason: String(reason).trim().slice(0, 500) }
      const ref = hashJson(details)
      return this.commit({
        user, shipmentId: id, action: 'DISPUTE', details, ref, requestId,
        send: (hooks) => this.chain.transition(this.wallets.forUser(user), id, 'DISPUTE', ref, hooks)
      })
    })
  }

  investigate (user, id, { findings } = {}, requestId) {
    return this.exclusive(async () => {
      const prior = this.replayed(user, requestId)
      if (prior) return prior
      const shipment = this.get(id)
      assertTransition('INVESTIGATE', shipment, user)
      if (!findings || !String(findings).trim()) throw badRequest('Record the investigation findings')
      const details = { findings: String(findings).trim().slice(0, 1000) }
      const ref = hashJson(details)
      return this.commit({
        user, shipmentId: id, action: 'INVESTIGATE', details, ref, requestId,
        send: (hooks) => this.chain.transition(this.wallets.forUser(user), id, 'INVESTIGATE', ref, hooks)
      })
    })
  }

  resolve (user, id, { decision, notes } = {}, requestId) {
    return this.exclusive(async () => {
      const prior = this.replayed(user, requestId)
      if (prior) return prior
      const shipment = this.get(id)
      if (!['ACCEPT', 'REJECT'].includes(decision)) throw badRequest('Decision must be ACCEPT or REJECT')
      assertTransition(decision, shipment, user)
      const details = { decision, notes: notes ? String(notes).trim().slice(0, 1000) : '' }
      const ref = hashJson(details)
      return this.commit({
        user, shipmentId: id, action: decision, details, ref, requestId,
        send: (hooks) => this.chain.transition(this.wallets.forUser(user), id, decision, ref, hooks)
      })
    })
  }

  // --------------------------------------------------------------- views

  summary (shipment, user) {
    const facility = this.store.facility(shipment.destinationFacilityCode)
    const cc = this.coldChainStatus(shipment)
    return {
      id: shipment.id,
      externalRef: shipment.externalRef,
      source: shipment.source,
      donor: shipment.donor,
      programme: shipment.programme,
      destination: { code: shipment.destinationFacilityCode, name: facility ? facility.name : shipment.destinationFacilityCode },
      commodity: shipment.commodity,
      unit: shipment.unit,
      batch: shipment.batch,
      expiry: shipment.expiry,
      quantity: shipment.quantity,
      packageCount: shipment.packages.length,
      state: shipment.state,
      stateLabel: STATE_LABELS[shipment.state],
      verification: verificationStatus(shipment),
      reconciliation: this.unresolvedOps(shipment.id).length ? { status: 'PENDING', note: 'A ledger update is awaiting confirmation.' } : (shipment.reconciliation || null),
      coldChain: cc ? { status: cc.status, range: cc.range, simulated: Boolean(cc.simulated) } : null,
      createdAt: shipment.createdAt,
      updatedAt: shipment.updatedAt,
      allowedActions: user ? allowedActions(shipment, user) : []
    }
  }

  link (cid, user) {
    return this.links && user ? this.links.sign(cid, user.id) : null
  }

  detail (shipment, user) {
    const canSeeLabels = user && user.role !== 'clinic'
    const events = this.store.eventsFor(shipment.id)
    const scans = this.store.data.scans.filter(s => s.shipmentId === shipment.id)
    const cc = this.coldChainStatus(shipment)
    const log = shipment.temperatureLog
    return {
      ...this.summary(shipment, user),
      manifestHash: shipment.manifestHash,
      ledgerKey: ethers.utils.id(shipment.id),
      packages: shipment.packages.map(p => ({
        packageNo: p.packageNo,
        sealNumber: user && (user.role !== 'clinic' || shipment.receipt) ? p.sealNumber : (p.sealNumber ? 'recorded' : null),
        code: canSeeLabels ? p.code : undefined,
        scanned: Boolean(shipment.receiptDraft && shipment.receiptDraft.scannedPackages[p.packageNo])
      })),
      receiptDraft: shipment.receiptDraft ? {
        startedAt: shipment.receiptDraft.startedAt,
        scannedPackages: Object.keys(shipment.receiptDraft.scannedPackages).map(Number),
        evidence: shipment.receiptDraft.evidence ? { cid: shipment.receiptDraft.evidence.cid, size: shipment.receiptDraft.evidence.size, url: this.link(shipment.receiptDraft.evidence.cid, user) } : null
      } : null,
      receipt: shipment.receipt ? { ...shipment.receipt, evidence: { ...shipment.receipt.evidence, url: this.link(shipment.receipt.evidence.cid, user) } } : null,
      dispute: shipment.dispute,
      integration: shipment.integration || null,
      coldChain: cc ? {
        ...cc,
        requirement: shipment.coldChain,
        log: log ? { source: log.source, deviceId: log.deviceId, cid: log.cid, sha256: log.sha256, uploadedAt: log.uploadedAt, uploadedBy: log.uploadedBy.name, readings: log.readings, url: this.link(log.cid, user) } : null
      } : null,
      incidents: shipment.incidents || [],
      lastLedgerCheck: shipment.lastLedgerCheck || null,
      events,
      scans: scans.map(s => ({ at: s.at, by: s.by.name, facility: s.by.facilityName, result: s.result, message: s.message, packageNo: s.packageNo }))
    }
  }

  /** Independent check that the off-chain record matches the ledger. */
  async ledgerCheck (id) {
    const shipment = this.get(id)
    const pending = this.unresolvedOps(id)
    const onChain = await this.chain.readShipment(id)
    const events = this.store.eventsFor(id)
    const checks = []
    const add = (name, ok, detail) => checks.push({ name, ok, detail })
    add('Shipment registered on ledger', onChain.state !== 'NONE', onChain.state)
    add('Custody state matches', onChain.state === shipment.state, `ledger ${onChain.state} / record ${shipment.state}`)
    add('Manifest hash matches', onChain.manifestHash === shipment.manifestHash, onChain.manifestHash)
    add('Destination facility matches', onChain.destination === shipment.destinationFacilityCode, onChain.destination)
    add('Event count matches', onChain.eventCount === events.length, `ledger ${onChain.eventCount} / record ${events.length}`)
    const eventsMatch = events.every(e => {
      const c = onChain.events.find(x => x.seq === e.seq)
      return c && c.txHash === e.chain.txHash && c.ref === e.ref && c.toState === e.toState
    })
    add('Every event hash and transaction matches', eventsMatch, `${onChain.events.length} ledger events`)
    if (shipment.receipt) {
      const r = onChain.receipt
      add('Evidence CID matches', Boolean(r) && r.evidenceCid === shipment.receipt.evidence.cid, r ? r.evidenceCid : 'none')
      add('Evidence hash matches', Boolean(r) && r.evidenceHash === '0x' + shipment.receipt.evidence.sha256, r ? r.evidenceHash : 'none')
      add('Seal result matches', Boolean(r) && r.seal === shipment.receipt.seal, r ? r.seal : 'none')
      try {
        await this.evidence.get(shipment.receipt.evidence.cid)
        add('Evidence photo retrievable and unaltered', true, shipment.receipt.evidence.cid)
      } catch (e) {
        add('Evidence photo retrievable and unaltered', false, e.message)
      }
    }
    if (shipment.temperatureLog) {
      try {
        await this.evidence.get(shipment.temperatureLog.cid)
        add('Temperature log retrievable and unaltered', true, shipment.temperatureLog.cid)
      } catch (e) {
        add('Temperature log retrievable and unaltered', false, e.message)
      }
    }
    const consistent = checks.every(c => c.ok)
    // While a write is in flight a mismatch is expected, so it is reported as pending, not inconsistent.
    const status = pending.length ? 'PENDING' : consistent ? 'CONSISTENT' : 'INCONSISTENT'
    shipment.lastLedgerCheck = { at: new Date().toISOString(), status }
    this.store.save()
    return { status, consistent: pending.length ? null : consistent, pendingOperations: pending.map(o => ({ action: o.action, status: o.status, txHash: o.txHash })), checkedAt: shipment.lastLedgerCheck.at, checks, ledger: onChain }
  }
}

module.exports = { CustodyService, ScanError, UnconfirmedError, CONDITIONS, REASON_TEXT }
