const crypto = require('crypto')

const SESSION_HOURS = 12
const IP_FAILURE_LIMIT = 30 // failures per IP within the window, across all staff IDs
const WINDOW_MS = 15 * 60 * 1000

function hashPin (pin, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex')
  return `${salt}:${hash}`
}

function checkPin (pin, stored) {
  const [salt, hash] = stored.split(':')
  const candidate = crypto.scryptSync(String(pin), salt, 32)
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'))
}

// Session tokens are stored hashed, so a copy of db.json does not hand out live sessions.
const tokenKey = (token) => crypto.createHash('sha256').update(String(token)).digest('hex')

// A dummy hash so unknown staff IDs cost the same scrypt work as known ones.
const DUMMY_HASH = hashPin('not-a-real-pin')

class LoginError extends Error {
  constructor (message, status, code, extra = {}) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

function publicUser (store, user) {
  const facility = user.facilityCode ? store.facility(user.facilityCode) : null
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    facility: facility ? { code: facility.code, name: facility.name, type: facility.type } : null
  }
}

/**
 * Throttles PIN guessing. Per staff ID: after `maxFailures` wrong PINs the ID is locked for
 * `lockMinutes`, doubling on each further lock (max 24 h). Per IP: a hard cap across all IDs.
 * Kept in memory: a restart clears it, which is acceptable for a single-node deployment.
 */
function createThrottle ({ maxFailures, lockMinutes, now = Date.now }) {
  const byUser = new Map()
  const byIp = new Map()

  const entry = (map, key) => {
    let e = map.get(key)
    if (!e || (now() - e.first > WINDOW_MS && (!e.lockedUntil || e.lockedUntil < now()))) {
      e = { failures: 0, first: now(), lockedUntil: 0, locks: e ? e.locks : 0 }
      map.set(key, e)
    }
    return e
  }

  function check (username, ip) {
    const u = entry(byUser, username)
    const i = entry(byIp, ip)
    const until = Math.max(u.lockedUntil, i.lockedUntil)
    if (until > now()) {
      const seconds = Math.ceil((until - now()) / 1000)
      throw new LoginError(`Too many incorrect attempts. Sign-in is locked for ${Math.ceil(seconds / 60)} minute(s). Ask your supervisor if you have forgotten your PIN.`, 429, 'LOGIN_LOCKED', { retryAfter: seconds })
    }
  }

  function fail (username, ip) {
    const u = entry(byUser, username)
    const i = entry(byIp, ip)
    u.failures++
    i.failures++
    if (i.failures >= IP_FAILURE_LIMIT) i.lockedUntil = now() + WINDOW_MS
    if (u.failures >= maxFailures) {
      u.locks++
      u.lockedUntil = now() + Math.min(lockMinutes * 60000 * 2 ** (u.locks - 1), 24 * 3600 * 1000)
      u.failures = 0
      u.first = now()
      return 0
    }
    return maxFailures - u.failures
  }

  function succeed (username) {
    byUser.delete(username)
  }

  return { check, fail, succeed }
}

function createAuth (store, config = {}) {
  const throttle = createThrottle({ maxFailures: config.loginMaxFailures || 5, lockMinutes: config.loginLockMinutes || 5 })

  function login (rawUsername, pin, ip = 'unknown') {
    const username = String(rawUsername || '').trim().toLowerCase()
    throttle.check(username, ip)
    const user = store.data.users.find(u => u.username === username)
    const ok = checkPin(pin, user ? user.pinHash : DUMMY_HASH) && Boolean(user)
    if (!ok) {
      const left = throttle.fail(username, ip)
      throttle.check(username, ip) // throws if that failure triggered a lock
      throw new LoginError(`Staff ID or PIN is incorrect. ${left} attempt(s) left before sign-in is temporarily locked.`, 401, 'BAD_LOGIN', { attemptsLeft: left })
    }
    throttle.succeed(username)
    return issue(user)
  }

  function issue (user, hours = SESSION_HOURS) {
    const token = crypto.randomBytes(32).toString('hex')
    store.data.sessions[tokenKey(token)] = { userId: user.id, expiresAt: Date.now() + hours * 3600 * 1000 }
    store.save()
    return { token, user: publicUser(store, user) }
  }

  function logout (token) {
    delete store.data.sessions[tokenKey(token)]
    store.save()
  }

  function userForToken (token) {
    const session = token && store.data.sessions[tokenKey(token)]
    if (!session || session.expiresAt < Date.now()) return null
    return store.user(session.userId)
  }

  function middleware (req, res, next) {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    req.user = userForToken(token)
    req.token = token
    if (!req.user) return res.status(401).json({ error: 'Please sign in again.', code: 'UNAUTHENTICATED' })
    next()
  }

  const requireRole = (...roles) => (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Your role cannot do this.', code: 'FORBIDDEN' })
    next()
  }

  return { login, logout, issue, middleware, requireRole, userForToken, publicUser: (u) => publicUser(store, u) }
}

module.exports = { createAuth, createThrottle, hashPin, tokenKey }
