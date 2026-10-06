const fs = require('fs')
const path = require('path')

const EMPTY = () => ({
  meta: { version: 1, createdAt: new Date().toISOString(), chain: null },
  facilities: [],
  users: [],
  sessions: {},
  shipments: [],
  events: [],
  scans: [],
  evidence: [],
  integrationOutbox: [],
  // Journal of every ledger write: PENDING -> SUBMITTED -> CONFIRMED | FAILED | UNKNOWN -> RECONCILED.
  operations: []
})

/**
 * Small JSON-file database. Every mutation is written atomically (tmp file + rename),
 * so a crash or refresh never leaves a half-written file behind.
 */
class Store {
  constructor (dataDir) {
    this.dataDir = dataDir
    this.file = path.join(dataDir, 'db.json')
    fs.mkdirSync(dataDir, { recursive: true })
    this.data = { ...EMPTY(), ...(fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {}) }
  }

  save () {
    const tmp = this.file + '.tmp'
    const fd = fs.openSync(tmp, 'w', 0o600)
    try {
      fs.writeSync(fd, JSON.stringify(this.data, null, 2))
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, this.file)
  }

  reset () {
    this.data = EMPTY()
    this.save()
  }

  shipment (id) {
    return this.data.shipments.find(s => s.id === id) || null
  }

  facility (code) {
    return this.data.facilities.find(f => f.code === code) || null
  }

  user (id) {
    return this.data.users.find(u => u.id === id) || null
  }

  eventsFor (shipmentId) {
    return this.data.events.filter(e => e.shipmentId === shipmentId).sort((a, b) => a.seq - b.seq)
  }
}

module.exports = { Store }
