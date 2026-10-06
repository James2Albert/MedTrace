#!/usr/bin/env node
/**
 * One-command demo: starts the ledger (unless one is already running on :7545),
 * seeds it when needed, and serves MedTrace on http://localhost:4000.
 *   npm run demo         reuse existing demo state (survives restarts)
 *   npm run demo:fresh   wipe chain + database and start the scenario from scratch
 */
// These scripts exist to run the local demo, so they turn demo mode on unless told otherwise.
if (process.env.MEDTRACE_DEMO_MODE === undefined) process.env.MEDTRACE_DEMO_MODE = '1'
const { load } = require('../server/config')
const { createServices } = require('../server/app')
const { seed } = require('../server/seed')
const { start } = require('../server/index')
const { startChain } = require('./chain')

async function main () {
  const fresh = process.argv.includes('--fresh')
  const config = load()
  const services = createServices(config)
  let status = await services.chain.status()

  if (!status.connected) {
    if (config.rpcUrl !== 'http://127.0.0.1:7545') throw new Error(`No blockchain node at ${config.rpcUrl}. Start it first, or unset RPC_URL to use the built-in local chain.`)
    console.log('Starting local ledger (Ganache) on :7545 ...')
    await startChain({ fresh })
    status = await services.chain.status()
  } else if (fresh) {
    console.log(`Using the ledger already running at ${config.rpcUrl} (contracts will be redeployed).`)
  }

  if (fresh || !status.contractDeployed || services.store.data.users.length === 0) {
    if (!fresh) console.log('No deployed MedTrace ledger found for this database: seeding demo data.')
    await seed(services)
  } else {
    console.log('Reusing existing demo state. Use `npm run demo:fresh` to start over.')
  }

  await start()
}

main().catch(err => {
  console.error(err.message)
  process.exit(1)
})
