const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// Kubo's default chunk size. Files up to this size are a single raw block, so the
// CID computed here is exactly what `ipfs add --cid-version=1 --raw-leaves` returns.
const MAX_EVIDENCE_BYTES = 262144
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
// Records MedTrace generates itself (e.g. temperature logs); never accepted from uploads.
const INTERNAL_TYPES = ['application/json']

const B32 = 'abcdefghijklmnopqrstuvwxyz234567'

function base32 (bytes) {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

/** CIDv1, raw codec (0x55), sha2-256 multihash, base32 multibase. */
function cidFor (buffer) {
  const digest = crypto.createHash('sha256').update(buffer).digest()
  return { cid: 'b' + base32(Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest])), sha256: digest.toString('hex') }
}

function looksLike (buffer, mimeType) {
  const head = buffer.subarray(0, 12)
  if (mimeType === 'image/jpeg') return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
  if (mimeType === 'image/png') return head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  return head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP'
}

class EvidenceError extends Error {
  constructor (message, status = 400) {
    super(message)
    this.status = status
    this.code = 'EVIDENCE_INVALID'
  }
}

class EvidenceStore {
  constructor ({ dataDir, ipfsApiUrl }) {
    this.dir = path.join(dataDir, 'ipfs', 'blocks')
    this.apiUrl = (ipfsApiUrl || '').replace(/\/$/, '')
    fs.mkdirSync(this.dir, { recursive: true })
  }

  get mode () {
    return this.apiUrl ? 'kubo' : 'local'
  }

  async status () {
    if (!this.apiUrl) return { mode: 'local', reachable: true }
    try {
      const res = await fetch(`${this.apiUrl}/api/v0/version`, { method: 'POST', signal: AbortSignal.timeout(3000) })
      const body = await res.json()
      return { mode: 'kubo', reachable: res.ok, version: body.Version }
    } catch (e) {
      return { mode: 'kubo', reachable: false }
    }
  }

  async put (buffer, mimeType, { internal = false } = {}) {
    const json = internal && INTERNAL_TYPES.includes(mimeType)
    if (!json && !ALLOWED_TYPES.includes(mimeType)) throw new EvidenceError('Evidence must be a JPEG, PNG or WebP photo')
    if (!buffer || buffer.length === 0) throw new EvidenceError('Photo is empty')
    if (buffer.length > MAX_EVIDENCE_BYTES) throw new EvidenceError(`Photo is too large (${buffer.length} bytes, max ${MAX_EVIDENCE_BYTES})`, 413)
    if (!json && !looksLike(buffer, mimeType)) throw new EvidenceError('File content is not a valid photo')

    const { cid, sha256 } = cidFor(buffer)
    const file = path.join(this.dir, cid)
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file + '.tmp', buffer)
      fs.renameSync(file + '.tmp', file)
    }

    const result = { cid, sha256, size: buffer.length, mimeType, storage: 'local', pinned: false }
    if (this.apiUrl) {
      try {
        result.pinned = await this.pinToKubo(buffer, cid)
        result.storage = 'kubo'
      } catch (e) {
        result.pinError = e.message
      }
    }
    return result
  }

  async pinToKubo (buffer, expectedCid) {
    const form = new FormData()
    form.append('file', new Blob([buffer]), 'evidence')
    const res = await fetch(`${this.apiUrl}/api/v0/add?cid-version=1&raw-leaves=true&pin=true`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(15000)
    })
    if (!res.ok) throw new Error(`IPFS node returned ${res.status}`)
    const body = JSON.parse((await res.text()).trim().split('\n').pop())
    if (body.Hash !== expectedCid) throw new Error(`IPFS node returned unexpected CID ${body.Hash}`)
    return true
  }

  /** Returns the bytes for a CID after checking they still hash to that CID. */
  async get (cid) {
    if (!/^b[a-z2-7]{58}$/.test(cid)) throw new EvidenceError('Not a valid evidence CID', 400)
    const file = path.join(this.dir, cid)
    let buffer = fs.existsSync(file) ? fs.readFileSync(file) : null
    let source = 'local'
    if (!buffer && this.apiUrl) {
      const res = await fetch(`${this.apiUrl}/api/v0/cat?arg=${cid}`, { method: 'POST', signal: AbortSignal.timeout(15000) })
      if (res.ok) {
        buffer = Buffer.from(await res.arrayBuffer())
        source = 'kubo'
      }
    }
    if (!buffer) throw new EvidenceError('Evidence not found', 404)
    if (cidFor(buffer).cid !== cid) throw new EvidenceError('Evidence integrity check failed: content does not match CID', 500)
    return { buffer, source }
  }
}

module.exports = { EvidenceStore, EvidenceError, cidFor, base32, MAX_EVIDENCE_BYTES }
