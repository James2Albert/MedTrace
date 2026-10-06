// Authentication, authorisation and evidence protection.
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { startStack, listen } = require('./helpers')
const { createServices, createApp } = require('../../server/app')
const { load, assertSafeConfig } = require('../../server/config')
const { seed } = require('../../server/seed')

let stack, tokens

before(async () => {
  stack = await startStack({ loginMaxFailures: 3, loginLockMinutes: 1 })
  tokens = {
    dispatcher: await stack.login('msd.dispatch', '1111'),
    chanika: await stack.login('chanika.clinic', '2222'),
    mzinga: await stack.login('mzinga.clinic', '3333'),
    auditor: await stack.login('district.auditor', '4444')
  }
})
after(() => stack.stop())

test('demo PINs are not served to the login page', async () => {
  assert.equal((await stack.api('GET', '/api/demo-accounts')).status, 404)
  const health = (await stack.api('GET', '/api/health')).data
  assert.equal(health.demoMode, true)
  assert.equal(JSON.stringify(health).includes('relayer'), false, 'health does not expose the relayer account')
})

test('repeated wrong PINs lock the staff ID, even for the right PIN, without affecting others', async () => {
  const attempt = (pin) => stack.api('POST', '/api/login', { body: { username: 'mzinga.clinic', pin } })
  let r = await attempt('0000')
  assert.equal(r.status, 401)
  assert.equal(r.data.attemptsLeft, 2)
  r = await attempt('0001')
  assert.equal(r.data.attemptsLeft, 1)
  r = await attempt('0002')
  assert.equal(r.status, 429)
  assert.equal(r.data.code, 'LOGIN_LOCKED')
  assert.ok(Number(r.headers.get('retry-after')) > 0)
  assert.equal((await attempt('3333')).status, 429, 'correct PIN is refused while locked')
  assert.equal((await stack.api('POST', '/api/login', { body: { username: 'chanika.clinic', pin: '2222' } })).status, 200)
  // Unknown staff IDs get the same answer as wrong PINs (no account enumeration).
  const unknown = await stack.api('POST', '/api/login', { body: { username: 'nobody', pin: '1' } })
  assert.equal(unknown.status, 401)
  assert.equal(unknown.data.code, 'BAD_LOGIN')
})

test('evidence needs a valid, unexpired, user-bound link or a bearer token, and facility access', async () => {
  const a = stack.shipmentByKey('A')
  const { done } = await stack.receive(tokens.chanika, a.id, { packages: [{ packageNo: 1, seal: 'INTACT', sealNumber: 'MSD-S240117' }] })
  assert.equal(done.data.state, 'RECEIVED')
  const cid = done.data.receipt.evidence.cid
  const url = done.data.receipt.evidence.url
  assert.match(url, /^\/api\/evidence\/b[a-z2-7]+\?u=u2&exp=\d+&sig=[0-9a-f]{32}$/)

  assert.equal((await stack.api('GET', url)).status, 200, 'signed link works without a header (for <img>)')
  assert.equal((await stack.api('GET', `/api/evidence/${cid}`)).status, 401, 'anonymous')
  assert.equal((await stack.api('GET', url.replace(/sig=.{4}/, 'sig=0000'))).status, 401, 'forged signature')
  assert.equal((await stack.api('GET', url.replace('u=u2', 'u=u4'))).status, 401, 'link cannot be re-bound to another user')
  const expired = stack.services.links.sign(cid, 'u2', Date.now() - 3600 * 1000)
  assert.equal((await stack.api('GET', expired)).status, 401, 'expired link')

  // Another facility: no link from the API, a bearer request is refused, and a validly signed
  // link for that user is still refused because authorisation is re-checked on use.
  assert.equal((await stack.api('GET', `/api/shipments/${a.id}`, { token: tokens.mzinga })).status, 403)
  assert.equal((await stack.api('GET', `/api/evidence/${cid}`, { token: tokens.mzinga })).status, 403)
  assert.equal((await stack.api('GET', stack.services.links.sign(cid, 'u3'))).status, 403)
  assert.equal((await stack.api('GET', `/api/evidence/${cid}`, { token: tokens.auditor })).status, 200)
  const r = await stack.api('GET', url)
  assert.equal(r.headers.get('cache-control'), 'private, no-store')
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer')
})

test('clinics cannot reach other facilities\' records or audit-only endpoints', async () => {
  const a = stack.shipmentByKey('A')
  const mz = stack.shipmentByKey('WRONG_FACILITY')
  const as = (token, method, url, body) => stack.api(method, url, { token, body })
  assert.equal((await as(tokens.chanika, 'GET', `/api/integrations/elmis/shipments/${a.externalRef.shipmentId}/pod`)).status, 403)
  assert.equal((await as(tokens.chanika, 'GET', `/api/shipments/${a.id}/ledger`)).status, 403)
  assert.equal((await as(tokens.chanika, 'GET', '/api/exceptions')).status, 403)
  assert.equal((await as(tokens.chanika, 'POST', '/api/reconcile')).status, 403)
  assert.equal((await as(tokens.chanika, 'POST', `/api/shipments/${mz.id}/temperature`, { source: 'LOGGER', readings: [] })).status, 403)
  assert.equal((await as(tokens.chanika, 'POST', `/api/shipments/${mz.id}/receipt/preview`, {})).status, 403)
  assert.equal((await as(tokens.chanika, 'POST', `/api/shipments/${mz.id}/dispute`, { reason: 'x' })).status, 403)
  assert.equal((await as(tokens.dispatcher, 'POST', `/api/shipments/${mz.id}/investigate`, { findings: 'x' })).status, 403)
  assert.equal((await as(tokens.chanika, 'GET', '/api/demo-kit')).status, 403)
})

test('responses never contain PIN hashes, keys or wallet details', async () => {
  const bodies = [
    await stack.api('GET', '/api/me', { token: tokens.auditor }),
    await stack.api('GET', `/api/shipments/${stack.shipmentByKey('A').id}`, { token: tokens.auditor }),
    await stack.api('GET', '/api/exceptions', { token: tokens.auditor })
  ].map(r => JSON.stringify(r.data))
  for (const b of bodies) {
    assert.equal(/pinHash|walletIndex|privateKey|mnemonic/.test(b), false)
  }
})

test('demo-only features are off outside demo mode, and demo secrets block a normal start', async () => {
  const prodLike = { ...stack.services, config: { ...stack.config, demoMode: false } }
  const server = await listen(createApp(prodLike))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const call = (method, url, body) => fetch(base + url, { method, headers: { Authorization: `Bearer ${tokens.dispatcher}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
    assert.equal((await call('GET', '/api/demo-kit')).status, 404)
    assert.equal((await call('POST', `/api/shipments/${stack.shipmentByKey('DISPATCH').id}/temperature/simulate`, { profile: 'normal' })).status, 404)
    assert.equal((await call('POST', '/api/demo/session', { role: 'auditor' })).status, 404, 'no PIN-less sign-in outside demo mode')
    assert.equal((await call('POST', '/api/demo/reset')).status, 404, 'no reset outside demo mode')
    assert.equal((await call('GET', '/api/demo/scenarios')).status, 404)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }

  if (!process.env.RELAYER_PRIVATE_KEY) assert.throws(() => assertSafeConfig(load({ demoMode: false })), /RELAYER_PRIVATE_KEY/)
  assert.doesNotThrow(() => assertSafeConfig(load({ demoMode: false, relayerKey: '0x' + '1'.repeat(64), walletMnemonic: 'x', labelSecret: 'y' })))
  await assert.rejects(seed(createServices({ ...stack.config, demoMode: false }), { log: () => {} }), /only allowed in demo mode/)
})
