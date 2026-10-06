/**
 * Minimal QR Code encoder: byte mode, error correction level M, versions 1-10.
 * Algorithm adapted from Project Nayuki's QR Code generator (MIT License).
 * Used to render shipment/package labels as SVG without external dependencies.
 */

const ECC_PER_BLOCK_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]
const NUM_BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5]
const MAX_VERSION = 10
const ECC_FORMAT_BITS_M = 0

function rawDataModules (ver) {
  let result = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (ver >= 7) result -= 36
  }
  return result
}

function dataCodewords (ver) {
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK_M[ver] * NUM_BLOCKS_M[ver]
}

function gfMul (x, y) {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z
}

function rsDivisor (degree) {
  const result = new Array(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root)
      if (j + 1 < result.length) result[j] ^= result[j + 1]
    }
    root = gfMul(root, 0x02)
  }
  return result
}

function rsRemainder (data, divisor) {
  const result = divisor.map(() => 0)
  for (const b of data) {
    const factor = b ^ result.shift()
    result.push(0)
    divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor) })
  }
  return result
}

const bit = (x, i) => ((x >>> i) & 1) !== 0

function encodeData (bytes) {
  let ver = 1
  for (; ver <= MAX_VERSION; ver++) {
    const countBits = ver < 10 ? 8 : 16
    if (4 + countBits + bytes.length * 8 <= dataCodewords(ver) * 8) break
  }
  if (ver > MAX_VERSION) throw new Error('QR payload too long')

  const bits = []
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1) }
  push(0b0100, 4)
  push(bytes.length, ver < 10 ? 8 : 16)
  for (const b of bytes) push(b, 8)
  const capacity = dataCodewords(ver) * 8
  push(0, Math.min(4, capacity - bits.length))
  push(0, (8 - bits.length % 8) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8)

  const data = []
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2))
  return { ver, data }
}

function interleave (ver, data) {
  const numBlocks = NUM_BLOCKS_M[ver]
  const eccLen = ECC_PER_BLOCK_M[ver]
  const rawCodewords = Math.floor(rawDataModules(ver) / 8)
  const numShort = numBlocks - rawCodewords % numBlocks
  const shortLen = Math.floor(rawCodewords / numBlocks)
  const divisor = rsDivisor(eccLen)
  const blocks = []
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1))
    k += dat.length
    const ecc = rsRemainder(dat, divisor)
    if (i < numShort) dat.push(0)
    blocks.push(dat.concat(ecc))
  }
  const result = []
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) result.push(block[i])
    })
  }
  return result
}

function alignmentPositions (ver, size) {
  if (ver === 1) return []
  const numAlign = Math.floor(ver / 7) + 2
  const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2
  const result = [6]
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos)
  return result
}

function buildMatrix (ver, codewords) {
  const size = ver * 4 + 17
  const modules = Array.from({ length: size }, () => new Array(size).fill(false))
  const isFn = Array.from({ length: size }, () => new Array(size).fill(false))
  const setFn = (x, y, dark) => { modules[y][x] = dark; isFn[y][x] = true }

  const drawFormat = (mask) => {
    const data = (ECC_FORMAT_BITS_M << 3) | mask
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const bits = ((data << 10) | rem) ^ 0x5412
    for (let i = 0; i <= 5; i++) setFn(8, i, bit(bits, i))
    setFn(8, 7, bit(bits, 6))
    setFn(8, 8, bit(bits, 7))
    setFn(7, 8, bit(bits, 8))
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(bits, i))
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(bits, i))
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(bits, i))
    setFn(8, size - 8, true)
  }

  for (let i = 0; i < size; i++) {
    setFn(6, i, i % 2 === 0)
    setFn(i, 6, i % 2 === 0)
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx
        const y = cy + dy
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, dist !== 2 && dist !== 4)
      }
    }
  }
  const align = alignmentPositions(ver, size)
  const n = align.length
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) setFn(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
      }
    }
  }
  drawFormat(0)
  if (ver >= 7) {
    let rem = ver
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (ver << 12) | rem
    for (let i = 0; i < 18; i++) {
      const b = bit(bits, i)
      const a = size - 11 + i % 3
      const c = Math.floor(i / 3)
      setFn(a, c, b)
      setFn(c, a, b)
    }
  }

  let i = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (!isFn[y][x] && i < codewords.length * 8) {
          modules[y][x] = bit(codewords[i >>> 3], 7 - (i & 7))
          i++
        }
      }
    }
  }

  const applyMask = (mask) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let invert
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break
          case 1: invert = y % 2 === 0; break
          case 2: invert = x % 3 === 0; break
          case 3: invert = (x + y) % 3 === 0; break
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break
          case 5: invert = (x * y) % 2 + (x * y) % 3 === 0; break
          case 6: invert = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break
          default: invert = ((x + y) % 2 + (x * y) % 3) % 2 === 0
        }
        if (!isFn[y][x] && invert) modules[y][x] = !modules[y][x]
      }
    }
  }

  let best = 0
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask)
    drawFormat(mask)
    const score = penalty(modules)
    if (score < bestScore) {
      best = mask
      bestScore = score
    }
    applyMask(mask)
  }
  applyMask(best)
  drawFormat(best)
  return modules
}

function penalty (m) {
  const size = m.length
  let score = 0
  const line = (get) => {
    for (let a = 0; a < size; a++) {
      let run = 1
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) {
          run++
          if (run === 5) score += 3
          else if (run > 5) score++
        } else run = 1
      }
      for (let b = 0; b + 10 < size; b++) {
        const seq = Array.from({ length: 11 }, (_, k) => get(a, b + k) ? 1 : 0).join('')
        if (seq === '10111010000' || seq === '00001011101') score += 40
      }
    }
  }
  line((a, b) => m[a][b])
  line((a, b) => m[b][a])
  let dark = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (m[y][x]) dark++
      if (y + 1 < size && x + 1 < size && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3
    }
  }
  const total = size * size
  score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10
  return score
}

function matrix (text) {
  const { ver, data } = encodeData(Array.from(Buffer.from(text, 'utf8')))
  return buildMatrix(ver, interleave(ver, data))
}

function svg (text, { moduleSize = 8, border = 4 } = {}) {
  const m = matrix(text)
  const dim = m.length + border * 2
  let path = ''
  m.forEach((row, y) => row.forEach((dark, x) => {
    if (dark) path += `M${x + border},${y + border}h1v1h-1z`
  }))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim * moduleSize}" height="${dim * moduleSize}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
}

module.exports = { matrix, svg }
