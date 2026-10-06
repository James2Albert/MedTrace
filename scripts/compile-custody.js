#!/usr/bin/env node
/**
 * Compiles contracts/MedTraceCustody.sol with a native solc (>=0.8.20) and writes a
 * Truffle-compatible artifact to build/contracts/MedTraceCustody.json.
 *
 * The compiled artifact is committed, so the demo does not need a compiler.
 * Run this only after changing the contract:  SOLC=/path/to/solc npm run compile:custody
 * (`truffle compile` also works when Truffle can download solc 0.8.20.)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const SOURCE = path.join(ROOT, 'contracts', 'MedTraceCustody.sol')
const OUT = path.join(ROOT, 'build', 'contracts', 'MedTraceCustody.json')

function findSolc () {
  const candidates = [process.env.SOLC, 'solc']
  const selectDir = path.join(os.homedir(), '.solc-select', 'artifacts')
  if (fs.existsSync(selectDir)) {
    for (const dir of fs.readdirSync(selectDir).sort().reverse()) {
      if (/^solc-0\.8\.(2\d|3\d)$/.test(dir)) candidates.push(path.join(selectDir, dir, dir))
    }
  }
  for (const bin of candidates.filter(Boolean)) {
    try {
      const out = execFileSync(bin, ['--version'], { encoding: 'utf8' })
      if (/Version: 0\.8\.(2\d|3\d)/.test(out)) return bin
    } catch (e) { /* try next */ }
  }
  throw new Error('No solc >= 0.8.20 found. Set SOLC=/path/to/solc')
}

const solc = findSolc()
const source = fs.readFileSync(SOURCE, 'utf8')
const input = {
  language: 'Solidity',
  sources: { 'MedTraceCustody.sol': { content: source } },
  settings: {
    evmVersion: 'paris',
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } }
  }
}

const output = JSON.parse(execFileSync(solc, ['--standard-json'], { input: JSON.stringify(input), encoding: 'utf8' }))
const errors = (output.errors || []).filter(e => e.severity === 'error')
if (errors.length) {
  errors.forEach(e => console.error(e.formattedMessage))
  process.exit(1)
}

const compiled = output.contracts['MedTraceCustody.sol'].MedTraceCustody
const version = execFileSync(solc, ['--version'], { encoding: 'utf8' }).match(/Version: (\S+)/)[1]
const previous = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {}

fs.writeFileSync(OUT, JSON.stringify({
  contractName: 'MedTraceCustody',
  abi: compiled.abi,
  bytecode: '0x' + compiled.evm.bytecode.object,
  deployedBytecode: '0x' + compiled.evm.deployedBytecode.object,
  source,
  sourcePath: SOURCE,
  compiler: { name: 'solc', version },
  networks: previous.networks || {},
  schemaVersion: '3.4.16',
  updatedAt: new Date().toISOString()
}, null, 2))

console.log(`Compiled MedTraceCustody with solc ${version} -> ${path.relative(ROOT, OUT)}`)
