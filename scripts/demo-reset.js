#!/usr/bin/env node
/**
 * Resets MedTrace to the clean demo state: redeploys both contracts on the running chain,
 * wipes the database and evidence store, and seeds accounts and eLMIS (mock) shipments.
 * Requires the chain to be running (npm run chain). The MedTrace server must be restarted
 * afterwards so it picks up the new contract address.
 */
// These scripts exist to run the local demo, so they turn demo mode on unless told otherwise.
if (process.env.MEDTRACE_DEMO_MODE === undefined) process.env.MEDTRACE_DEMO_MODE = '1'
const { load } = require('../server/config')
const { createServices } = require('../server/app')
const { seed } = require('../server/seed')

seed(createServices(load()))
  .then(() => {
    console.log('\nDemo reset complete. (Re)start the server: npm start')
    process.exit(0)
  })
  .catch(err => {
    console.error(`\nDemo reset failed: ${err.message}`)
    process.exit(1)
  })
