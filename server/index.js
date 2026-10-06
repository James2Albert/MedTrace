const fs = require('fs')
const { load, assertSafeConfig } = require('./config')
const { createServices, createApp } = require('./app')

async function start (overrides = {}) {
  const config = load(overrides)
  assertSafeConfig(config)
  const services = createServices(config)
  const app = createApp(services)
  // Phones only allow camera access on HTTPS (or localhost). Set MEDTRACE_TLS_CERT and
  // MEDTRACE_TLS_KEY to serve over HTTPS for a phone on the same network.
  const { MEDTRACE_TLS_CERT: cert, MEDTRACE_TLS_KEY: key } = process.env
  const scheme = cert && key ? 'https' : 'http'
  const server = await new Promise(resolve => {
    const s = scheme === 'https'
      ? require('https').createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, app).listen(config.port, () => resolve(s))
      : app.listen(config.port, () => resolve(s))
  })

  const ledger = await services.chain.status()
  console.log(`MedTrace running at ${scheme}://localhost:${config.port}`)
  console.log(`  Audit / clinic app : ${scheme}://localhost:${config.port}/`)
  console.log(`  Legacy donor dApp  : ${scheme}://localhost:${config.port}/legacy/ (MetaMask)`)
  console.log(`  Evidence store     : ${services.evidence.mode === 'kubo' ? `IPFS node ${config.ipfsApiUrl}` : 'local IPFS-compatible block store'}`)
  if (!ledger.connected) console.warn(`  ! Blockchain node not reachable at ${config.rpcUrl}. Start it with: npm run chain`)
  else if (!ledger.contractDeployed) console.warn('  ! Ledger contract not deployed on this chain. Run: npm run demo:reset')
  if (config.demoMode) console.warn(`  ! DEMO MODE: demo reset, demo kit and simulated temperature feed are enabled${config.demoSecrets.length ? `; using public demo values for ${config.demoSecrets.join(', ')}` : ''}. Not for real data.`)

  // Settle any ledger writes interrupted by a crash or lost connection, then keep checking
  // while some remain unresolved.
  const reconcile = async (label) => {
    if (!(await services.chain.status()).contractDeployed) return
    const reports = await services.custody.reconcileAll()
    const changed = reports.filter(r => r.error || (r.applied || []).length || (r.failed || []).length || (r.recovered || []).length || (r.problems || []).length)
    changed.forEach(r => console.log(`  ${label}: ${r.shipmentId} ${JSON.stringify(r)}`))
  }
  if (ledger.contractDeployed) await reconcile('Startup reconciliation').catch(e => console.warn(`  ! Startup reconciliation failed: ${e.message}`))
  const timer = setInterval(() => {
    const pending = services.store.data.operations.some(o => ['PENDING', 'SUBMITTED', 'UNKNOWN'].includes(o.status))
    if (pending) reconcile('Reconciliation').catch(() => {})
  }, 30000)
  timer.unref()
  return { server, services }
}

if (require.main === module) {
  start().catch(err => {
    console.error(err)
    process.exit(1)
  })
}

module.exports = { start }
