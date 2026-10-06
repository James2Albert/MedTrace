#!/usr/bin/env node
/** Syntax-checks every MedTrace JavaScript file (server, web, scripts, tests). No build step exists. */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const DIRS = ['server', 'web', 'scripts', 'test/custody']
const files = []
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory() && !['vendor', 'data', 'node_modules'].includes(e.name)) walk(p)
    else if (e.isFile() && p.endsWith('.js')) files.push(p)
  }
}
DIRS.forEach(d => walk(path.join(ROOT, d)))
let failed = 0
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' })
  } catch (e) {
    failed++
    console.error(`✖ ${path.relative(ROOT, f)}\n${e.stderr}`)
  }
}
JSON.parse(fs.readFileSync(path.join(ROOT, 'server/integrations/elmis/mock-shipments.json'), 'utf8'))
console.log(`${failed ? '✖' : '✔'} syntax check: ${files.length - failed}/${files.length} files OK`)
process.exit(failed ? 1 : 0)
