// Evidence store unit tests, including the Kubo (IPFS node) client against a minimal
// mock of Kubo's HTTP API (/api/v0/add, /api/v0/cat, /api/v0/version).
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { EvidenceStore, cidFor } = require('../../server/evidence')
const { JPEG } = require('./helpers')

let kubo, kuboUrl, blocks, dirs = []

function tempDir () {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'medtrace-ev-'))
  dirs.push(d)
  return d
}

before(async () => {
  blocks = new Map()
  kubo = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      if (url.pathname === '/api/v0/version') return res.end(JSON.stringify({ Version: 'mock-0.29.0' }))
      if (url.pathname === '/api/v0/add') {
        assert.equal(url.searchParams.get('cid-version'), '1')
        assert.equal(url.searchParams.get('raw-leaves'), 'true')
        const body = Buffer.concat(chunks)
        const boundary = '--' + req.headers['content-type'].split('boundary=')[1]
        const part = body.subarray(body.indexOf('\r\n\r\n') + 4, body.lastIndexOf(Buffer.from('\r\n' + boundary)))
        const { cid } = cidFor(part)
        blocks.set(cid, part)
        return res.end(JSON.stringify({ Name: 'evidence', Hash: cid, Size: String(part.length) }) + '\n')
      }
      if (url.pathname === '/api/v0/cat') {
        const data = blocks.get(url.searchParams.get('arg'))
        if (!data) { res.statusCode = 500; return res.end('not found') }
        return res.end(data)
      }
      res.statusCode = 404
      res.end()
    })
  })
  await new Promise(r => kubo.listen(0, '127.0.0.1', r))
  kuboUrl = `http://127.0.0.1:${kubo.address().port}`
})

after(() => {
  kubo.close()
  dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true }))
})

test('CIDs match IPFS for known content', () => {
  assert.equal(cidFor(Buffer.alloc(0)).cid, 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku')
  assert.equal(cidFor(Buffer.from('hello world')).cid, 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e')
})

test('local store: put/get round trip, idempotent', async () => {
  const store = new EvidenceStore({ dataDir: tempDir(), ipfsApiUrl: '' })
  const img = JPEG('local')
  const a = await store.put(img, 'image/jpeg')
  const b = await store.put(img, 'image/jpeg')
  assert.equal(a.cid, b.cid)
  assert.equal(a.storage, 'local')
  assert.deepEqual((await store.get(a.cid)).buffer, img)
})

test('kubo store: pins to the node and reads back through it', async () => {
  const store = new EvidenceStore({ dataDir: tempDir(), ipfsApiUrl: kuboUrl })
  assert.deepEqual(await store.status(), { mode: 'kubo', reachable: true, version: 'mock-0.29.0' })
  const img = JPEG('kubo')
  const put = await store.put(img, 'image/jpeg')
  assert.equal(put.storage, 'kubo')
  assert.equal(put.pinned, true)
  assert.ok(blocks.has(put.cid))
  fs.rmSync(path.join(store.dir, put.cid)) // force retrieval from the node
  const got = await store.get(put.cid)
  assert.equal(got.source, 'kubo')
  assert.deepEqual(got.buffer, img)
})

test('kubo unreachable: evidence is still stored locally and flagged unpinned', async () => {
  const store = new EvidenceStore({ dataDir: tempDir(), ipfsApiUrl: 'http://127.0.0.1:9' })
  const put = await store.put(JPEG('offline'), 'image/jpeg')
  assert.equal(put.storage, 'local')
  assert.equal(put.pinned, false)
  assert.ok(put.pinError)
  assert.equal((await store.status()).reachable, false)
})
