const crypto = require('crypto')

/**
 * Package label codes. Each physical package carries a QR with:
 *   MT1:<shipmentId>:<packageNo>:<signature>
 * The signature is an HMAC over the shipment, package, batch and destination facility,
 * so a label cannot be edited (e.g. re-addressed or re-batched) without failing validation.
 */
const PATTERN = /^MT1:(SHP-[0-9A-Z-]{4,40}):(\d{1,3}):([0-9A-F]{10})$/

function signature (secret, shipment, packageNo) {
  return crypto.createHmac('sha256', secret)
    .update(['MT1', shipment.id, packageNo, shipment.batch, shipment.destinationFacilityCode].join('|'))
    .digest('hex').slice(0, 10).toUpperCase()
}

function codeFor (secret, shipment, packageNo) {
  return `MT1:${shipment.id}:${packageNo}:${signature(secret, shipment, packageNo)}`
}

/** Accepts raw scanner output (may include whitespace, lowercase, or a URL with ?code=). */
function parse (raw) {
  let text = String(raw || '').trim()
  const fromUrl = text.match(/[?&#]code=([^&\s]+)/)
  if (fromUrl) text = decodeURIComponent(fromUrl[1])
  const m = text.toUpperCase().match(PATTERN)
  if (!m) return null
  return { shipmentId: m[1], packageNo: Number(m[2]), signature: m[3], code: m[0] }
}

function verify (secret, shipment, parsed) {
  if (parsed.packageNo < 1 || parsed.packageNo > shipment.packages.length) return false
  const expected = signature(secret, shipment, parsed.packageNo)
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parsed.signature))
}

module.exports = { codeFor, parse, verify }
