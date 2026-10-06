const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ROOT = path.join(__dirname, '..')

// Ganache's well-known deterministic account #0 (`ganache --wallet.deterministic`).
// It deploys the contracts and acts as the gas-sponsoring relayer. Local demo only.
const GANACHE_DETERMINISTIC_KEY0 = '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d'

// Seed for the per-user embedded wallets. Users never see these keys. Demo only.
const DEMO_WALLET_MNEMONIC = 'test test test test test test test test test test test junk'
const DEMO_LABEL_SECRET = 'medtrace-demo-label-secret'

/** Minimal .env reader (KEY=VALUE lines). Real environment variables always win. */
function loadEnvFile (file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!m || line.trim().startsWith('#')) continue
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2')
    if (process.env[m[1]] === undefined) process.env[m[1]] = value
  }
}

const flag = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase())

function load (overrides = {}) {
  loadEnvFile()
  const env = process.env
  const dataDir = overrides.dataDir || env.MEDTRACE_DATA_DIR || path.join(ROOT, 'server', 'data')
  const relayerKey = overrides.relayerKey || env.RELAYER_PRIVATE_KEY
  const walletMnemonic = overrides.walletMnemonic || env.MEDTRACE_WALLET_MNEMONIC
  const labelSecret = overrides.labelSecret || env.MEDTRACE_LABEL_SECRET
  const demoSecrets = []
  if (!relayerKey) demoSecrets.push('RELAYER_PRIVATE_KEY')
  if (!walletMnemonic) demoSecrets.push('MEDTRACE_WALLET_MNEMONIC')
  if (!labelSecret) demoSecrets.push('MEDTRACE_LABEL_SECRET')
  return {
    root: ROOT,
    port: Number(overrides.port || env.PORT || 4000),
    dataDir,
    // Demo mode enables the seed/reset script, the printable demo kit and the
    // simulated temperature feed, and permits the public demo secrets below.
    demoMode: overrides.demoMode !== undefined ? Boolean(overrides.demoMode) : flag(env.MEDTRACE_DEMO_MODE),
    demoSecrets,
    rpcUrl: overrides.rpcUrl || env.RPC_URL || 'http://127.0.0.1:7545',
    chainId: Number(overrides.chainId || env.CHAIN_ID || 1337),
    networkId: String(overrides.networkId || env.NETWORK_ID || '5777'),
    relayerKey: relayerKey || GANACHE_DETERMINISTIC_KEY0,
    walletMnemonic: walletMnemonic || DEMO_WALLET_MNEMONIC,
    labelSecret: labelSecret || DEMO_LABEL_SECRET,
    // Signs short-lived evidence links. A random per-process key is fine: links only live minutes.
    evidenceLinkSecret: overrides.evidenceLinkSecret || env.MEDTRACE_EVIDENCE_LINK_SECRET || crypto.randomBytes(32).toString('hex'),
    evidenceLinkSeconds: Number(overrides.evidenceLinkSeconds || env.MEDTRACE_EVIDENCE_LINK_SECONDS || 300),
    loginMaxFailures: Number(overrides.loginMaxFailures || env.MEDTRACE_LOGIN_MAX_FAILURES || 5),
    loginLockMinutes: Number(overrides.loginLockMinutes || env.MEDTRACE_LOGIN_LOCK_MINUTES || 5),
    transitSlaHours: Number(overrides.transitSlaHours || env.MEDTRACE_TRANSIT_SLA_HOURS || 48),
    coldChainToleranceMinutes: Number(overrides.coldChainToleranceMinutes ?? env.MEDTRACE_COLDCHAIN_TOLERANCE_MINUTES ?? 15),
    txTimeoutMs: Number(overrides.txTimeoutMs || env.MEDTRACE_TX_TIMEOUT_MS || 30000),
    // Optional Kubo (go-ipfs) node. When unset, evidence goes to the local
    // content-addressed store, which produces the same CIDs Kubo would.
    ipfsApiUrl: overrides.ipfsApiUrl !== undefined ? overrides.ipfsApiUrl : (env.IPFS_API_URL || ''),
    buildDir: path.join(ROOT, 'build', 'contracts')
  }
}

/** Refuses to run outside demo mode while any secret still has its public demo value. */
function assertSafeConfig (config) {
  if (config.demoMode || config.demoSecrets.length === 0) return
  throw new Error(
    `Refusing to start: ${config.demoSecrets.join(', ')} not set. These have public demo defaults.\n` +
    'Set them in the environment or .env (see .env.example), or run the local demo with MEDTRACE_DEMO_MODE=1 (npm run demo).'
  )
}

module.exports = { load, assertSafeConfig, GANACHE_DETERMINISTIC_KEY0 }
