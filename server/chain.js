const fs = require('fs')
const path = require('path')
const { ethers } = require('ethers')

const ACTIONS = { CREATE: 0, DISPATCH: 1, DEPART: 2, ARRIVE: 3, RECEIVE: 4, DISPUTE: 5, INVESTIGATE: 6, ACCEPT: 7, REJECT: 8 }
const ACTION_NAMES = Object.keys(ACTIONS)
const STATES = ['NONE', 'CREATED', 'DISPATCHED', 'IN_TRANSIT', 'RECEIPT_PENDING', 'RECEIVED', 'DISPUTED', 'INVESTIGATED', 'ACCEPTED', 'REJECTED']
const SEALS = ['UNCHECKED', 'INTACT', 'DAMAGED', 'MISSING']
const ROLES = { dispatcher: 1, clinic: 2, auditor: 3 }

class ChainUnavailableError extends Error {
  constructor (message) {
    super(message)
    this.status = 503
    this.code = 'LEDGER_UNAVAILABLE'
  }
}

class ChainRejectedError extends Error {
  constructor (reason) {
    super(`Ledger rejected the update: ${reason}`)
    this.status = 409
    this.code = 'LEDGER_REJECTED'
    this.reason = reason
  }
}

const enc = ethers.utils.defaultAbiCoder
const keccak = ethers.utils.keccak256

function shipmentKey (shipmentId) {
  return ethers.utils.id(shipmentId)
}

function facilityKey (facilityCode) {
  return ethers.utils.formatBytes32String(facilityCode)
}

// ethers v5 wraps connection failures of eth_call in a CALL_EXCEPTION ("reverted"),
// so look at every nested error for a transport failure.
function isNetworkError (e) {
  if (encodedRevert(e)) return false
  for (let err = e, depth = 0; err && depth < 5; err = err.error, depth++) {
    const text = `${err.code} ${err.message} ${err.serverError && err.serverError.code}`
    if (/NETWORK_ERROR|SERVER_ERROR|TIMEOUT|ECONNREFUSED|ECONNRESET|ETIMEDOUT|missing response|could not detect network|socket hang up|fetch failed/i.test(text)) return true
  }
  return false
}

// Ganache returns the ABI-encoded Error(string) in places ethers v5 does not decode,
// so search the whole error object for it.
function encodedRevert (e) {
  const seen = new Set()
  const walk = (v, depth) => {
    if (v === null || v === undefined || depth > 5 || seen.has(v)) return null
    if (typeof v === 'string') {
      const m = v.match(/0x08c379a0[0-9a-fA-F]+/)
      return m ? m[0] : null
    }
    if (typeof v !== 'object') return null
    seen.add(v)
    for (const k of Object.getOwnPropertyNames(v)) {
      const found = walk(v[k], depth + 1)
      if (found) return found
    }
    return null
  }
  const hex = walk(e, 0)
  if (!hex) return null
  try {
    return enc.decode(['string'], '0x' + hex.slice(10))[0]
  } catch (err) {
    return null
  }
}

function revertReason (e) {
  const decoded = encodedRevert(e)
  if (decoded) return decoded
  const candidates = [
    e && e.reason,
    e && e.error && e.error.reason,
    e && e.error && e.error.data && e.error.data.reason,
    e && e.data && e.data.reason,
    e && e.error && e.error.message,
    e && e.message
  ]
  for (const c of candidates) {
    if (!c || typeof c !== 'string') continue
    const m = c.match(/reverted with reason string '([^']+)'|revert(?:ed)?:? ([^"\n]+?)(?:"|$)/)
    if (m) return (m[1] || m[2]).trim()
    if (!/^(processing response error|cannot estimate gas|call revert exception)/i.test(c)) return c
  }
  return 'transaction reverted'
}

function readArtifact (buildDir, name) {
  return JSON.parse(fs.readFileSync(path.join(buildDir, `${name}.json`), 'utf8'))
}

/**
 * The relayer. One funded account submits every MedTrace transaction (gas sponsor);
 * the contract only accepts transitions signed by a registered actor's embedded wallet.
 * All submissions go through a single queue so nonces never collide.
 */
class Chain {
  constructor (config) {
    this.config = config
    this.artifact = readArtifact(config.buildDir, 'MedTraceCustody')
    this.address = null
    this.queue = Promise.resolve()
    this.connect(config.rpcUrl)
  }

  connect (rpcUrl) {
    this.rpcUrl = rpcUrl
    this.provider = new ethers.providers.StaticJsonRpcProvider(
      { url: rpcUrl, timeout: 8000 },
      { chainId: this.config.chainId, name: 'medtrace' }
    )
    this.relayer = new ethers.Wallet(this.config.relayerKey, this.provider)
    if (this.address) this.attach(this.address)
  }

  attach (address) {
    this.address = address
    this.contract = new ethers.Contract(address, this.artifact.abi, this.relayer)
  }

  enqueue (fn) {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  async guard (fn) {
    if (!this.contract) throw new ChainUnavailableError('Ledger contract is not configured. Run: npm run demo:reset')
    try {
      return await fn()
    } catch (e) {
      if (e instanceof ChainUnavailableError || e instanceof ChainRejectedError) throw e
      const fromEthers = typeof e.code === 'string' || /revert/i.test(e.message || '')
      if (!fromEthers) throw e
      if (isNetworkError(e)) throw new ChainUnavailableError('Blockchain node is not reachable. The record was not changed; try again when the ledger is back.')
      const code = await this.provider.getCode(this.address).catch(() => null)
      if (code === '0x') throw new ChainUnavailableError('Ledger contract not found on this chain (was the node restarted?). Run: npm run demo:reset')
      throw new ChainRejectedError(revertReason(e))
    }
  }

  async status () {
    try {
      const blockNumber = await this.provider.getBlockNumber()
      const code = this.address ? await this.provider.getCode(this.address) : '0x'
      return {
        connected: true,
        blockNumber,
        contractAddress: this.address,
        contractDeployed: code !== '0x',
        relayer: this.relayer.address
      }
    } catch (e) {
      return { connected: false, error: 'Blockchain node not reachable', contractAddress: this.address }
    }
  }

  // ------------------------------------------------------------- deployment

  async deploy ({ writeArtifacts = true } = {}) {
    const deployOne = async (artifact) => {
      const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, this.relayer)
      const contract = await factory.deploy()
      await contract.deployTransaction.wait()
      return { address: contract.address, transactionHash: contract.deployTransaction.hash }
    }
    const custody = await deployOne(this.artifact)
    // The original donation contract is redeployed unchanged so the legacy MetaMask UI keeps working.
    const donationArtifact = readArtifact(this.config.buildDir, 'MedicalSupplyDonation')
    const donation = await deployOne(donationArtifact)

    if (writeArtifacts) {
      const record = (name, artifact, deployed) => {
        artifact.networks = artifact.networks || {}
        artifact.networks[this.config.networkId] = { events: {}, links: {}, ...deployed }
        fs.writeFileSync(path.join(this.config.buildDir, `${name}.json`), JSON.stringify(artifact, null, 2))
      }
      record('MedTraceCustody', this.artifact, custody)
      record('MedicalSupplyDonation', donationArtifact, donation)
      fs.copyFileSync(
        path.join(this.config.buildDir, 'MedicalSupplyDonation.json'),
        path.join(this.config.root, 'src', 'MedicalSupplyDonation.json')
      )
    }
    this.attach(custody.address)
    return { custody, donation }
  }

  // ------------------------------------------------------------- admin

  async setActor (address, role, facilityCode, active = true) {
    return this.enqueue(() => this.guard(async () => {
      const facility = facilityCode ? facilityKey(facilityCode) : ethers.constants.HashZero
      const tx = await this.contract.setActor(address, ROLES[role], facility, active)
      await tx.wait()
      return tx.hash
    }))
  }

  async setRelayer (address, allowed) {
    return this.enqueue(() => this.guard(async () => {
      const tx = await this.contract.setRelayer(address, allowed)
      await tx.wait()
      return tx.hash
    }))
  }

  // ------------------------------------------------------------- custody

  async signAction (wallet, key, action, payloadHash) {
    const digest = await this.contract.digestFor(wallet.address, key, action, payloadHash)
    return wallet.signMessage(ethers.utils.arrayify(digest))
  }

  /**
   * Simulates, signs, reports the transaction hash through hooks.onSigned *before* broadcasting
   * (so a crash after this point can always be traced on chain), then waits for one confirmation.
   */
  async submit (method, args, hooks = {}) {
    // Simulate first so a revert produces a readable reason and no failed transaction.
    await this.contract.callStatic[method](...args)
    const unsigned = await this.relayer.populateTransaction(await this.contract.populateTransaction[method](...args))
    const signed = await this.relayer.signTransaction(unsigned)
    const txHash = keccak(signed)
    if (hooks.onSigned) await hooks.onSigned(txHash)
    await this.provider.sendTransaction(signed)
    let timer
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new ChainUnavailableError('The ledger did not confirm the update in time. It may still be recorded; MedTrace will check automatically.')), this.config.txTimeoutMs || 30000)
    })
    try {
      const receipt = await Promise.race([this.provider.waitForTransaction(txHash, 1), timeout])
      if (receipt.status === 0) throw new ChainRejectedError('transaction reverted')
      return this.parseReceipt(receipt)
    } finally {
      clearTimeout(timer)
    }
  }

  parseReceipt (receipt) {
    const events = receipt.logs
      .filter(log => this.address && log.address.toLowerCase() === this.address.toLowerCase())
      .map(log => { try { return this.contract.interface.parseLog(log) } catch (e) { return null } })
      .filter(Boolean)
    const custody = events.find(e => e.name === 'CustodyEvent')
    return {
      txHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber,
      seq: custody ? Number(custody.args.seq) : null,
      action: custody ? ACTION_NAMES[custody.args.action] : null,
      ref: custody ? custody.args.ref : null,
      toState: custody ? STATES[custody.args.toState] : null,
      fromState: custody ? STATES[custody.args.fromState] : null,
      signer: custody ? custody.args.actor : null
    }
  }

  createShipment (wallet, shipmentId, destinationCode, manifestHash, hooks) {
    return this.enqueue(() => this.guard(async () => {
      const key = shipmentKey(shipmentId)
      const destination = facilityKey(destinationCode)
      const payload = keccak(enc.encode(['bytes32', 'bytes32'], [destination, manifestHash]))
      const sig = await this.signAction(wallet, key, ACTIONS.CREATE, payload)
      return this.submit('createShipment', [key, destination, manifestHash, wallet.address, sig], hooks)
    }))
  }

  transition (wallet, shipmentId, actionName, ref, hooks) {
    return this.enqueue(() => this.guard(async () => {
      const key = shipmentKey(shipmentId)
      const action = ACTIONS[actionName]
      const payload = keccak(enc.encode(['bytes32'], [ref]))
      const sig = await this.signAction(wallet, key, action, payload)
      return this.submit('transition', [key, action, ref, wallet.address, sig], hooks)
    }))
  }

  recordReceipt (wallet, shipmentId, { seal, conditionOk, identityOk, evidenceHash, evidenceCid }, hooks) {
    return this.enqueue(() => this.guard(async () => {
      const key = shipmentKey(shipmentId)
      const sealCode = SEALS.indexOf(seal)
      const payload = keccak(enc.encode(
        ['uint8', 'bool', 'bool', 'bytes32', 'bytes32'],
        [sealCode, conditionOk, identityOk, evidenceHash, ethers.utils.id(evidenceCid)]
      ))
      const sig = await this.signAction(wallet, key, ACTIONS.RECEIVE, payload)
      return this.submit('recordReceipt', [key, sealCode, conditionOk, identityOk, evidenceHash, evidenceCid, wallet.address, sig], hooks)
    }))
  }

  // ------------------------------------------------------------- reconciliation

  /** CONFIRMED (with parsed result) | FAILED | PENDING (known to the node, not mined) | NOT_FOUND. */
  async txOutcome (txHash) {
    return this.guard(async () => {
      const receipt = await this.provider.getTransactionReceipt(txHash)
      if (receipt) return receipt.status === 0 ? { status: 'FAILED' } : { status: 'CONFIRMED', result: this.parseReceipt(receipt) }
      const tx = await this.provider.getTransaction(txHash)
      return { status: tx ? 'PENDING' : 'NOT_FOUND' }
    })
  }

  /** True while the relayer has broadcast transactions that are not yet mined. */
  async relayerHasPending () {
    return this.guard(async () => {
      const [latest, pending] = await Promise.all([
        this.provider.getTransactionCount(this.relayer.address, 'latest'),
        this.provider.getTransactionCount(this.relayer.address, 'pending')
      ])
      return pending > latest
    })
  }

  // ------------------------------------------------------------- reads

  async readShipment (shipmentId) {
    return this.guard(async () => {
      const key = shipmentKey(shipmentId)
      const s = await this.contract.shipments(key)
      const r = await this.contract.receipts(key)
      const logs = await this.contract.queryFilter(this.contract.filters.CustodyEvent(key), 0, 'latest')
      // Positional: the result array's own `.at` method shadows the struct field name.
      const receiptAt = ethers.BigNumber.from(r[6]).toNumber()
      return {
        key,
        state: STATES[s.state],
        destination: s.destination === ethers.constants.HashZero ? null : ethers.utils.parseBytes32String(s.destination),
        manifestHash: s.manifestHash,
        eventCount: Number(s.eventCount),
        receipt: receiptAt === 0 ? null : {
          seal: SEALS[r.seal],
          conditionOk: r.conditionOk,
          identityOk: r.identityOk,
          evidenceHash: r.evidenceHash,
          evidenceCid: r.evidenceCid,
          receivedBy: r.receivedBy,
          at: new Date(receiptAt * 1000).toISOString()
        },
        events: logs.map(l => ({
          seq: Number(l.args.seq),
          action: ACTION_NAMES[l.args.action],
          fromState: STATES[l.args.fromState],
          toState: STATES[l.args.toState],
          actor: l.args.actor,
          ref: l.args.ref,
          txHash: l.transactionHash,
          blockNumber: l.blockNumber
        }))
      }
    })
  }
}

module.exports = {
  Chain,
  ChainUnavailableError,
  ChainRejectedError,
  ACTIONS,
  STATES,
  SEALS,
  shipmentKey,
  facilityKey,
  revertReason,
  isNetworkError
}
