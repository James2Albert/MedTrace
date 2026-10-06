const crypto = require('crypto')

/**
 * Short-lived evidence links. Images are shown with <img src>, which cannot send the bearer
 * token, so the server hands out a URL bound to one CID, one user and an expiry, signed with
 * HMAC. Authorisation is checked when the link is issued and again when it is used.
 */
function createEvidenceLinks ({ evidenceLinkSecret, evidenceLinkSeconds = 300 }) {
  const mac = (cid, userId, exp) => crypto.createHmac('sha256', evidenceLinkSecret).update(`${cid}|${userId}|${exp}`).digest('hex').slice(0, 32)

  function sign (cid, userId, now = Date.now()) {
    const exp = Math.floor(now / 1000) + evidenceLinkSeconds
    return `/api/evidence/${cid}?u=${encodeURIComponent(userId)}&exp=${exp}&sig=${mac(cid, userId, exp)}`
  }

  /** Returns the user id the link was issued to, or null if it is forged or expired. */
  function verify (cid, { u, exp, sig } = {}, now = Date.now()) {
    if (!u || !exp || !sig || !/^\d+$/.test(String(exp)) || Number(exp) * 1000 < now) return null
    const expected = Buffer.from(mac(cid, String(u), String(exp)))
    const given = Buffer.from(String(sig))
    return given.length === expected.length && crypto.timingSafeEqual(given, expected) ? String(u) : null
  }

  return { sign, verify }
}

module.exports = { createEvidenceLinks }
