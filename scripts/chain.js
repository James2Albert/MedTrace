#!/usr/bin/env node
/**
 * Local Ganache chain for MedTrace (chainId 1337, networkId 5777, port 7545).
 * State is persisted in server/data/chain so the ledger survives restarts.
 *   npm run chain            keep existing state
 *   npm run chain -- --fresh wipe the chain first
 */
const fs = require('fs')
const path = require('path')

const DB_PATH = path.join(__dirname, '..', 'server', 'data', 'chain')

function startChain ({ port = 7545, fresh = false, quiet = true } = {}) {
  if (fresh) fs.rmSync(DB_PATH, { recursive: true, force: true })
  fs.mkdirSync(DB_PATH, { recursive: true })
  const ganache = require('ganache')
  const server = ganache.server({
    logging: { quiet },
    wallet: { deterministic: true },
    chain: { chainId: 1337, networkId: 5777 },
    database: { dbPath: DB_PATH }
  })
  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', err => err ? reject(err) : resolve(server))
  })
}

if (require.main === module) {
  const fresh = process.argv.includes('--fresh')
  startChain({ fresh, quiet: false }).then(() => {
    console.log(`\nGanache ledger listening on http://127.0.0.1:7545 (chainId 1337, networkId 5777)${fresh ? ' [fresh]' : ''}`)
    console.log(`State persisted in ${path.relative(process.cwd(), DB_PATH)}`)
  }).catch(err => {
    console.error(err.message)
    process.exit(1)
  })
}

module.exports = { startChain, DB_PATH }
