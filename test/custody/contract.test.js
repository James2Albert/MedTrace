// Contract-level checks: the ledger must refuse invalid transitions even if the backend
// were bypassed or buggy.
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { ethers } = require('ethers')
const { startStack } = require('./helpers')
const { ACTIONS, shipmentKey, revertReason } = require('../../server/chain')

let stack, chain, wallets, users

const user = (username) => users.find(u => u.username === username)
const wallet = (username) => wallets.forUser(user(username))

async function expectRevert (promise, reason) {
  await assert.rejects(promise, err => {
    assert.equal(err.code, 'LEDGER_REJECTED', `expected ledger rejection, got ${err.message}`)
    if (reason) assert.match(err.reason, new RegExp(reason))
    return true
  })
}

before(async () => {
  stack = await startStack()
  ;({ chain, wallets } = stack.services)
  users = stack.services.store.data.users
})
after(() => stack.stop())

test('shipment cannot be created twice', async () => {
  const s = stack.shipmentByOrder('ORD-MSD-DSM-2026-10-0412')
  await expectRevert(chain.createShipment(wallet('msd.dispatch'), s.id, s.destinationFacilityCode, s.manifestHash), 'already exists')
})

test('clinic cannot create shipments', async () => {
  await expectRevert(chain.createShipment(wallet('chanika.clinic'), 'SHP-TEST-1', 'HFR-105611', ethers.utils.id('x')), 'role not permitted')
})

test('invalid transitions revert on chain', async () => {
  const inTransit = stack.shipmentByOrder('ORD-MSD-DSM-2026-10-0412').id
  const created = stack.shipmentByOrder('ORD-MSD-DSM-2026-10-0427').id
  const ref = ethers.utils.id('ref')
  await expectRevert(chain.transition(wallet('msd.dispatch'), inTransit, 'DISPATCH', ref), 'Invalid transition')
  await expectRevert(chain.transition(wallet('district.auditor'), inTransit, 'ACCEPT', ref), 'Invalid transition')
  await expectRevert(chain.transition(wallet('district.auditor'), inTransit, 'INVESTIGATE', ref), 'Invalid transition')
  await expectRevert(chain.transition(wallet('chanika.clinic'), created, 'ARRIVE', ref), 'Invalid transition')
  await expectRevert(chain.transition(wallet('msd.dispatch'), created, 'DEPART', ref), 'Invalid transition')
})

test('only the destination facility can record arrival', async () => {
  const s = stack.shipmentByOrder('ORD-MSD-DSM-2026-10-0412') // addressed to Chanika
  await expectRevert(chain.transition(wallet('mzinga.clinic'), s.id, 'ARRIVE', ethers.utils.id('x')), 'Wrong facility')
  await expectRevert(chain.transition(wallet('msd.dispatch'), s.id, 'ARRIVE', ethers.utils.id('x')), 'role not permitted')
})

test('receipt is refused before arrival scan', async () => {
  const s = stack.shipmentByOrder('ORD-MSD-DSM-2026-10-0412')
  await expectRevert(chain.recordReceipt(wallet('chanika.clinic'), s.id, {
    seal: 'INTACT', conditionOk: true, identityOk: true, evidenceHash: ethers.utils.id('photo'), evidenceCid: 'bafy'
  }), 'Invalid transition')
})

test('relayer cannot forge an actor signature', async () => {
  const s = stack.shipmentByOrder('ORD-MSD-DSM-2026-10-0427')
  const key = shipmentKey(s.id)
  const ref = ethers.utils.id('forged')
  const payload = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['bytes32'], [ref]))
  const dispatcher = wallet('msd.dispatch')
  const impostor = ethers.Wallet.createRandom()
  const digest = await chain.contract.digestFor(dispatcher.address, key, ACTIONS.DISPATCH, payload)
  const sig = await impostor.signMessage(ethers.utils.arrayify(digest))
  await assert.rejects(chain.contract.callStatic.transition(key, ACTIONS.DISPATCH, ref, dispatcher.address, sig), e => revertReason(e) === 'Bad actor signature')
})

test('signatures cannot be replayed', async () => {
  const s = stack.shipmentByOrder('ORD-MSD-DSM-2026-10-0427')
  const key = shipmentKey(s.id)
  const ref = ethers.utils.id('seal')
  const payload = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['bytes32'], [ref]))
  const dispatcher = wallet('msd.dispatch')
  const sig = await chain.signAction(dispatcher, key, ACTIONS.DISPATCH, payload)
  await (await chain.contract.transition(key, ACTIONS.DISPATCH, ref, dispatcher.address, sig)).wait()
  // The same signature (old nonce) reused for the next legitimate step must fail.
  await assert.rejects(chain.contract.callStatic.transition(key, ACTIONS.DEPART, ref, dispatcher.address, sig), e => revertReason(e) === 'Bad actor signature')
})

test('unapproved relayer is refused', async () => {
  const other = stack.node.provider
  const accounts = await other.request({ method: 'eth_accounts', params: [] })
  const signer = new ethers.providers.Web3Provider(other).getSigner(accounts[5])
  const contract = chain.contract.connect(signer)
  const s = stack.shipmentByOrder('ORD-MSD-DSM-2026-10-0412')
  await assert.rejects(contract.callStatic.transition(shipmentKey(s.id), ACTIONS.DISPUTE, ethers.utils.id('x'), wallet('chanika.clinic').address, '0x' + '11'.repeat(65)), e => revertReason(e) === 'Relayer not approved')
})

test('damaged seal cannot become RECEIVED on chain', async () => {
  const s = stack.shipmentByOrder('ORD-MSD-DSM-2026-10-0413')
  await chain.transition(wallet('chanika.clinic'), s.id, 'ARRIVE', ethers.utils.id('arrive'))
  const r = await chain.recordReceipt(wallet('chanika.clinic'), s.id, {
    seal: 'DAMAGED', conditionOk: true, identityOk: true, evidenceHash: ethers.utils.id('photo'), evidenceCid: 'bafkreiexample'
  })
  assert.equal(r.toState, 'DISPUTED')
  // And a dispute cannot be accepted without investigation.
  await expectRevert(chain.transition(wallet('district.auditor'), s.id, 'ACCEPT', ethers.utils.id('x')), 'Invalid transition')
  await expectRevert(chain.transition(wallet('chanika.clinic'), s.id, 'INVESTIGATE', ethers.utils.id('x')), 'role not permitted')
  const inv = await chain.transition(wallet('district.auditor'), s.id, 'INVESTIGATE', ethers.utils.id('findings'))
  assert.equal(inv.toState, 'INVESTIGATED')
  const rej = await chain.transition(wallet('district.auditor'), s.id, 'REJECT', ethers.utils.id('decision'))
  assert.equal(rej.toState, 'REJECTED')
  await expectRevert(chain.transition(wallet('district.auditor'), s.id, 'ACCEPT', ethers.utils.id('x')), 'Invalid transition')
})
