'use strict'

/* ===================================================================== basics */

const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))
const esc = (v) => String(v === undefined || v === null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const view = () => $('#view')

const store = {
  get (key) { try { return JSON.parse(localStorage.getItem(key)) } catch (e) { return null } },
  set (key, value) { try { localStorage.setItem(key, JSON.stringify(value)) } catch (e) { /* storage unavailable */ } },
  del (key) { try { localStorage.removeItem(key) } catch (e) { /* storage unavailable */ } }
}
const draftStore = {
  key: (id) => `medtrace.receipt.${id}`,
  get (id) { try { return JSON.parse(sessionStorage.getItem(this.key(id))) || {} } catch (e) { return {} } },
  set (id, value) { try { sessionStorage.setItem(this.key(id), JSON.stringify(value)) } catch (e) { /* storage unavailable */ } },
  del (id) { try { sessionStorage.removeItem(this.key(id)) } catch (e) { /* storage unavailable */ } }
}

const session = { token: store.get('medtrace.token'), user: store.get('medtrace.user') }

class ApiError extends Error {
  constructor (status, data) {
    super((data && data.error) || `Request failed (${status})`)
    this.status = status
    this.code = data && data.code
    this.data = data || {}
  }
}

const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`)

// idem: an Idempotency-Key, so a retried submission is applied at most once by the server.
async function api (method, path, body, { raw, type, text, idem } = {}) {
  const headers = {}
  if (session.token) headers.Authorization = `Bearer ${session.token}`
  if (idem) headers['Idempotency-Key'] = idem
  let payload
  if (raw) { payload = raw; headers['Content-Type'] = type } else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json' }
  let res
  try {
    res = await fetch(path, { method, headers, body: payload })
  } catch (e) {
    throw new ApiError(0, { error: 'Cannot reach the MedTrace server. Check the connection and try again.', code: 'OFFLINE' })
  }
  if (res.status === 401 && path !== '/api/login') {
    signOut(false)
    throw new ApiError(401, { error: 'Your session ended. Please sign in again.' })
  }
  if (text && res.ok) return res.text()
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : {}
  if (!res.ok) throw new ApiError(res.status, data)
  return data
}

const fmt = {
  date: (iso) => iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—',
  day: (iso) => iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—',
  hash: (h) => h ? `${h.slice(0, 10)}…${h.slice(-8)}` : '—',
  qty: (n, unit) => `${Number(n).toLocaleString('en-GB')} ${esc(unit || '')}`,
  bytes: (n) => n > 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`
}

const ROLE_LABEL = { dispatcher: 'MSD dispatch', clinic: 'Health facility', auditor: 'Auditor' }
const ACTION_LABEL = {
  CREATE: 'Registered from eLMIS',
  DISPATCH: 'Dispatched and sealed',
  DEPART: 'Left warehouse (in transit)',
  ARRIVE: 'Arrived: label scanned at facility',
  RECEIVE: 'Receipt verification recorded',
  DISPUTE: 'Disputed',
  INVESTIGATE: 'Investigation recorded',
  ACCEPT: 'Accepted after investigation',
  REJECT: 'Rejected after investigation'
}
const SCAN_TITLES = {
  INVALID_CODE: 'Not a MedTrace label',
  LABEL_TAMPERED: 'Label failed verification',
  UNKNOWN_SHIPMENT: 'Unknown shipment',
  WRONG_FACILITY: 'Wrong facility',
  NOT_IN_TRANSIT: 'Not released for transport',
  ALREADY_PROCESSED: 'Already received',
  DIFFERENT_SHIPMENT: 'Package from a different shipment',
  LEDGER_UNAVAILABLE: 'Service temporarily offline. Nothing was saved',
  LEDGER_UNCONFIRMED: 'Not confirmed yet',
  LEDGER_REJECTED: 'Refused by the ledger. Nothing was saved',
  RECONCILIATION_PENDING: 'Waiting for an earlier update',
  REQUEST_IN_PROGRESS: 'Still being confirmed',
  LOGIN_LOCKED: 'Sign-in temporarily locked',
  OFFLINE: 'No connection'
}
const STATE_TEXT = {
  NONE: 'Not registered',
  CREATED: 'Registered',
  DISPATCHED: 'Dispatched',
  IN_TRANSIT: 'In transit',
  RECEIPT_PENDING: 'Awaiting receipt',
  RECEIVED: 'Received',
  DISPUTED: 'Disputed',
  INVESTIGATED: 'Under investigation',
  ACCEPTED: 'Accepted',
  REJECTED: 'Rejected'
}
// PASS / WARNING / FAIL / NOT_CHECKED from the server's verification service.
const RESULT_UI = {
  PASS: ['ok', '✓', 'Pass'],
  WARNING: ['warn', '!', 'Warning'],
  FAIL: ['bad', '✗', 'Fail'],
  NOT_CHECKED: ['na', '–', 'Not checked']
}
const CONDITIONS = [
  ['GOOD', 'Good', 'Packaging and contents undamaged'],
  ['DAMAGED', 'Damaged', 'Crushed, broken or opened'],
  ['WET_OR_CONTAMINATED', 'Wet or contaminated', 'Water, stains, spills'],
  ['EXPIRED_OR_SHORT_DATED', 'Expired / short-dated', 'Expiry passed or too close']
]

const badge = (code, label) => `<span class="badge s-${esc(code)}">${esc(label)}</span>`
const isClinic = () => session.user && session.user.role === 'clinic'
const reconBadge = (s) => s.reconciliation && s.reconciliation.status !== 'RECOVERED' ? ` ${badge('RECONCILE', 'Reconciliation required')}` : ''

function checkList (checks) {
  return `<div class="vchecks">${checks.map(c => {
    const [cls, mark, word] = RESULT_UI[c.result] || RESULT_UI.NOT_CHECKED
    return `<div class="vcheck ${cls}"><span class="mark" aria-hidden="true">${mark}</span>
      <div><div class="vlabel">${esc(c.label)}${c.mandatory ? '' : ' <span class="muted small">(advisory)</span>'}</div><div class="vreason">${esc(c.reason)}</div></div>
      <span class="vresult">${word}</span></div>`
  }).join('')}</div>`
}

function errorBox (err, title) {
  const heading = title || SCAN_TITLES[err.code] || 'Something went wrong'
  return `<div class="error-box" role="alert"><strong>${esc(heading)}</strong>${esc(err.message)}</div>`
}

function setBusy (button, busy, label) {
  if (!button) return
  if (busy) {
    button.dataset.label = button.innerHTML
    button.disabled = true
    button.textContent = label || 'Saving…'
  } else {
    button.disabled = false
    if (button.dataset.label) button.innerHTML = button.dataset.label
  }
}

/* ===================================================================== shell */

let leaveHooks = []
const onLeave = (fn) => leaveHooks.push(fn)

function signOut (callServer = true) {
  if (callServer && session.token) api('POST', '/api/logout').catch(() => {})
  session.token = null
  session.user = null
  store.del('medtrace.token')
  store.del('medtrace.user')
  location.hash = '#/login'
}

function renderShell () {
  const top = $('#topbar')
  top.hidden = false
  const u = session.user
  const current = location.hash || '#/'
  $('#logout').hidden = !u
  $('#signin').hidden = Boolean(u) || current === '#/login'
  if (!u) {
    $('#who').innerHTML = ''
    $('#nav').innerHTML = [['#/welcome', 'About'], ...(session.demoMode ? [['#/demo', 'Live demo']] : [])]
      .map(([href, label]) => `<a href="${href}" class="${current.startsWith(href) ? 'active' : ''}">${esc(label)}</a>`).join('')
    return
  }
  const demo = session.demoMode ? [['#/demo', 'Demo guide']] : []
  const links = {
    clinic: [['#/', 'Deliveries'], ['#/receive', 'Receive delivery'], ...demo],
    dispatcher: [['#/', 'Shipments'], ['#/import', 'eLMIS import'], ...demo],
    auditor: [['#/', 'Audit'], ...demo]
  }[u.role] || []
  $('#nav').innerHTML = links.map(([href, label]) => {
    const active = href === '#/' ? current === '#/' || current.startsWith('#/shipments') : current.startsWith(href)
    return `<a href="${href}" class="${active ? 'active' : ''}">${esc(label)}</a>`
  }).join('')
  $('#who').innerHTML = `<strong>${esc(u.name)}</strong><span class="muted">${esc(u.facility ? u.facility.name : ROLE_LABEL[u.role])}</span>`
}

async function checkHealth () {
  let health
  try {
    const res = await fetch('/api/health')
    health = await res.json()
  } catch (e) {
    health = { ok: false, unreachable: true }
  }
  if (health.demoMode !== undefined) session.demoMode = health.demoMode
  if (!session.user) return
  const conn = $('#conn')
  const banner = $('#banner')
  conn.classList.toggle('down', !health.ok)
  conn.textContent = health.ok ? (health.demoMode ? 'Online · demo mode' : 'Online') : 'Offline'
  if (health.ok) { banner.classList.add('hidden'); return }
  let message
  if (health.unreachable) message = 'The MedTrace server cannot be reached. Your progress on this device is kept; try again shortly.'
  else if (isClinic()) message = 'The records service is offline. Receipts cannot be saved right now. Your progress is kept; try again shortly.'
  else if (health.ledger && !health.ledger.connected) message = 'Blockchain node not reachable. No custody changes can be recorded until it is back (start it with: npm run chain).'
  else message = 'Ledger contract not found on the running chain. Run: npm run demo:reset, then restart the server.'
  banner.textContent = message
  banner.classList.remove('hidden')
}

/* ===================================================================== router */

const routes = [
  [/^#\/login$/, renderLogin, { public: true }],
  [/^#\/welcome$/, renderWelcome, { public: true }],
  [/^#\/demo$/, renderDemoHub, { public: true }],
  [/^#\/?$/, renderHome],
  [/^#\/receive$/, () => renderReceive(null)],
  [/^#\/receive\?code=([^&]+)$/, (m) => renderReceive(null, decodeURIComponent(m[1]))],
  [/^#\/receive\/(SHP-[\w-]+)$/, (m) => renderReceive(m[1])],
  [/^#\/shipments\/(SHP-[\w-]+)$/, (m) => renderShipment(m[1])],
  [/^#\/shipments\/(SHP-[\w-]+)\/labels$/, (m) => renderLabels(m[1])],
  [/^#\/import$/, renderImport],
  [/^#\/demo-kit$/, renderDemoKit]
]

async function route () {
  leaveHooks.forEach(fn => { try { fn() } catch (e) { /* ignore */ } })
  leaveHooks = []
  const hash = location.hash || '#/'
  if (hash === '#how') return // in-page anchor on the welcome page
  const match = routes.map(([re, fn, opts]) => [hash.match(re), fn, opts || {}]).find(([m]) => m)
  if (!session.token && !(match && match[2].public)) { location.hash = store.get('medtrace.seenIntro') ? '#/login' : '#/welcome'; return }
  if (session.token && hash === '#/login') { location.hash = '#/'; return }
  renderShell()
  view().classList.remove('narrow', 'wide-page')
  if (!match) { view().innerHTML = '<div class="panel"><div class="empty">Page not found. <a href="#/">Go to start</a></div></div>'; return }
  try {
    await match[1](match[0])
  } catch (err) {
    if (err.status === 401) return
    view().innerHTML = errorBox(err, 'Could not load this page') + '<a class="btn" href="#/">Back to start</a>'
  }
  window.scrollTo(0, 0)
}

/* ===================================================================== login */

async function renderLogin () {
  view().innerHTML = `
    <div class="login-wrap">
      <section class="intro">
        <h1>MedTrace</h1>
        <p>Chain-of-custody records for medical supplies, from MSD dispatch to verified receipt at the health facility.</p>
        <p><a href="#/welcome">What is MedTrace and how does it work?</a></p>
        <div class="note-box" id="demoNote" hidden><strong>Judging or trying it out?</strong> This server runs in demo mode with synthetic data. <a href="#/demo">Open the live demo</a> to enter a role without a PIN and follow a guided scenario.</div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Sign in</h2></div>
        <div class="panel-body">
          <form id="loginForm" autocomplete="off">
            <div id="loginError"></div>
            <label class="field"><span>Staff ID</span><input type="text" id="username" autocapitalize="off" spellcheck="false" required></label>
            <label class="field"><span>PIN</span><input type="password" id="pin" inputmode="numeric" required></label>
            <button class="btn primary block large" type="submit">Sign in</button>
          </form>
        </div>
      </section>
    </div>`
  store.set('medtrace.seenIntro', true)
  $('#username').focus()
  fetch('/api/health').then(r => r.json()).then(h => { if (h.demoMode) $('#demoNote').hidden = false }).catch(() => {})

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault()
    const btn = e.submitter || $('#loginForm button')
    setBusy(btn, true, 'Signing in…')
    try {
      const res = await api('POST', '/api/login', { username: $('#username').value, pin: $('#pin').value })
      session.token = res.token
      session.user = res.user
      store.set('medtrace.token', res.token)
      store.set('medtrace.user', res.user)
      location.hash = '#/'
      checkHealth()
    } catch (err) {
      $('#loginError').innerHTML = errorBox(err, 'Sign-in failed')
      setBusy(btn, false)
    }
  })
}

/* ===================================================================== welcome + demo hub */

async function enterDemo (role, hash) {
  const res = await api('POST', '/api/demo/session', { role })
  session.token = res.token
  session.user = res.user
  store.set('medtrace.token', res.token)
  store.set('medtrace.user', res.user)
  store.set('medtrace.seenIntro', true)
  if (location.hash === hash) route()
  else location.hash = hash
}

function renderWelcome () {
  view().classList.add('wide-page')
  const demo = session.demoMode
  view().innerHTML = `
    <section class="hero">
      <p class="eyebrow">Medical supply custody and integrity</p>
      <h1>Every medical delivery should be verifiable.</h1>
      <p class="lede">MedTrace connects shipment custody records, signed QR labels, independent seal checks and tamper-evident photos, so health facilities and auditors can see when a delivery does not match what was sent, and find out what happened.</p>
      <div class="actions">
        ${demo ? '<a class="btn primary large" href="#/demo" id="ctaDemo">Explore the live demo</a>' : `<a class="btn primary large" href="#/${session.user ? '' : 'login'}">${session.user ? 'Go to your workspace' : 'Sign in'}</a>`}
        <a class="btn large" href="#how" id="ctaHow">See how verification works</a>
      </div>
      ${demo ? '<p class="small muted">The demo uses synthetic data on a local test blockchain. No sign-in needed.</p>' : ''}
    </section>

    <section class="problem">
      <h2>The problem</h2>
      <p>A signature on a delivery note says a box arrived. It does not say whether it was the right box, whether it was opened on the way, or who is accountable when something is missing. Discrepancies surface weeks later, spread across MSD, transporters and facilities.</p>
    </section>

    <section id="how" class="how">
      <h2>How it works</h2>
      <ol class="three">
        <li><span class="num">1</span><h3>Dispatch</h3><p>MSD registers the shipment from eLMIS, applies numbered tamper seals and prints a signed QR label for each package.</p></li>
        <li><span class="num">2</span><h3>Verify</h3><p>The clinic scans the label, counts the goods, and types the number on the seal <strong>without being shown what it should be</strong>, then photographs the delivery.</p></li>
        <li><span class="num">3</span><h3>Investigate</h3><p>If anything differs, the delivery is recorded as disputed, never as received. The district auditor sees the custody history, the evidence and the exact mismatch, and decides.</p></li>
      </ol>
    </section>

    <section class="diff">
      <h2>What makes it different from a shipment tracker</h2>
      <div class="grid-2 diff-grid">
        <div><h3>Signed package identity</h3><p>A QR label that cannot be edited or re-addressed without failing verification. Wrong-facility and counterfeit labels are refused and logged.</p></div>
        <div><h3>Independent seal check</h3><p>The clinic reports what it sees; MedTrace compares it with the dispatch record afterwards. A valid label never outweighs a wrong seal.</p></div>
        <div><h3>Tamper-evident evidence</h3><p>Photos and temperature logs are stored by their content hash and re-checked on every view. Access is limited to the people involved.</p></div>
        <div><h3>Accountable custody record</h3><p>Every hand-over is signed and recorded on a ledger that the receiving decision cannot bypass: a failed check can only become a dispute.</p></div>
      </div>
      <p class="note-box"><strong>What the record proves, and what it does not.</strong> The ledger proves who recorded which step and when, and that the photo has not changed since. It does not prove the medicine inside is genuine. That still needs the physical checks MedTrace asks for.</p>
    </section>

    <section class="who-for">
      <h2>Who uses it</h2>
      <div class="roles">
        <div class="role-card static"><h3>Dispatcher <span class="muted small">MSD warehouse</span></h3><p>Prepares shipments, seals packages and records hand-over to transport.</p></div>
        <div class="role-card static"><h3>Clinic <span class="muted small">health facility</span></h3><p>Receives deliveries and independently verifies label, seal, quantity and condition.</p></div>
        <div class="role-card static"><h3>Auditor <span class="muted small">district pharmacist</span></h3><p>Reviews discrepancies, inspects evidence and custody history, and decides.</p></div>
      </div>
      <div class="actions" style="margin-top:20px">${demo ? '<a class="btn primary large" href="#/demo">Explore the live demo</a>' : ''}<a class="btn" href="#/login" id="skipIntro">Sign in with a staff ID</a></div>
    </section>`
  store.set('medtrace.seenIntro', true)
  $('#ctaHow').addEventListener('click', (e) => { e.preventDefault(); $('#how').scrollIntoView({ behavior: 'smooth' }) })
}

/** What to do next in a guided scenario, derived from the shipment's real state. */
function guideStep (sc) {
  const s = sc.shipment
  const seal = sc.packages[0].seal || sc.packages[0].plannedSeal
  const code = sc.packages[0].code
  const receive = { role: 'clinic', hash: `#/receive?code=${encodeURIComponent(code)}`, label: 'Receive it as the clinic' }
  const audit = { role: 'auditor', hash: `#/shipments/${s.id}`, label: 'Investigate as the auditor' }
  if (sc.key === 'GUIDED_A') {
    if (s.state === 'CREATED') return { n: 1, text: `Dispatch it: as the dispatcher, record dispatch with seal number <span class="mono">${esc(sc.packages[0].plannedSeal)}</span>, then hand it over to transport.`, role: 'dispatcher', hash: `#/shipments/${s.id}`, label: 'Dispatch it as MSD' }
    if (s.state === 'DISPATCHED') return { n: 1, text: 'Hand it over to transport: enter any vehicle registration.', role: 'dispatcher', hash: `#/shipments/${s.id}`, label: 'Continue as MSD' }
    if (['IN_TRANSIT', 'RECEIPT_PENDING'].includes(s.state)) return { n: 2, text: `Receive it: the label code is filled in for you. Count the full quantity (${s.quantity}), condition good, seal intact, and type the number the seal shows: <span class="mono">${esc(seal)}</span>. Add any photo.`, ...receive }
    return { n: 3, text: `Done: the shipment is <strong>${esc(s.stateLabel)}</strong>. Open the record to see expected vs observed and the ledger entries.`, role: 'auditor', hash: `#/shipments/${s.id}`, label: 'Open the record' }
  }
  if (['IN_TRANSIT', 'RECEIPT_PENDING'].includes(s.state)) return { n: 1, text: `Receive it: everything matches the paperwork. Count the full quantity (${s.quantity}), condition good, the seal looks intact, and type exactly what it shows: <span class="mono">${esc(seal)}</span>.`, ...receive }
  if (['DISPUTED', 'INVESTIGATED'].includes(s.state)) return { n: 2, text: 'The clinic could not record a clean receipt. As the auditor, open the shipment: compare expected and observed seal numbers, view the photo, verify against the ledger, then record findings and decide.', ...audit }
  return { n: 3, text: `Resolved: <strong>${esc(s.stateLabel)}</strong>. The full trail stays on the record.`, ...audit, label: 'Open the record' }
}

async function renderDemoHub () {
  view().classList.add('wide-page')
  let scenarios
  try {
    scenarios = await api('GET', '/api/demo/scenarios')
  } catch (err) {
    view().innerHTML = `<div class="note-box">The live demo is not enabled on this server. <a href="#/login">Sign in</a> with a staff ID instead.</div>`
    return
  }
  store.set('medtrace.seenIntro', true)
  const guided = ['GUIDED_A', 'B'].map(k => scenarios.find(x => x.key === k)).filter(Boolean)
  const extras = scenarios.filter(x => !['GUIDED_A', 'B'].includes(x.key))
  const who = session.user ? `You are signed in as <strong>${esc(session.user.name)}</strong> (${esc(ROLE_LABEL[session.user.role])}). The buttons below switch role.` : 'Pick a scenario. Each button opens the right workspace for the next step. No PIN needed in the demo.'
  view().innerHTML = `
    <div class="page-head"><div><h1>Live demo</h1><p>Real application, real checks, real ledger writes, on <strong>synthetic data</strong> and a local test blockchain. ${who}</p></div>
      <button class="btn" type="button" id="resetDemo">Reset demo</button></div>
    <div id="hubMsg"></div>
    <div class="scenarios">${guided.map(sc => {
      const step = guideStep(sc)
      const total = sc.key === 'GUIDED_A' ? 3 : 3
      return `<section class="panel scenario ${sc.key === 'B' ? 'suspicious' : 'legit'}">
        <div class="panel-head"><h2>${esc(sc.guide.title)}</h2>${badge(sc.shipment.state, sc.shipment.stateLabel)}</div>
        <div class="panel-body">
          <p>${esc(sc.guide.story)}</p>
          <div class="scenario-label">
            <div class="qr">${sc.packages[0].qr}</div>
            <div class="small">
              <div class="muted">Package label (scan with a phone, or it is filled in for you)</div>
              <div class="mono-wrap">${esc(sc.packages[0].code)}</div>
              <div class="muted" style="margin-top:6px">Shipment</div><div class="mono">${esc(sc.shipment.id)} · ${esc(sc.shipment.commodity)}</div>
              ${sc.packages[0].seal ? `<div class="seal-tag">The tamper seal on this box reads <strong>${esc(sc.packages[0].seal)}</strong></div>` : '<div class="seal-tag">Not sealed yet: dispatch applies the seal</div>'}
            </div>
          </div>
          <div class="next-step"><span class="step-n">Step ${step.n} of ${total}</span><p>${step.text}</p>
            <button class="btn primary" type="button" data-role="${step.role}" data-hash="${esc(step.hash)}">${esc(step.label)}</button></div>
        </div></section>`
    }).join('')}</div>

    <section class="panel"><div class="panel-head"><h2>Or explore a role freely</h2></div><div class="panel-body">
      <div class="roles">
        <button class="role-card" type="button" data-role="dispatcher" data-hash="#/"><h3>Dispatcher</h3><p>Prepares shipments from eLMIS, seals packages and records dispatch. <span class="muted">MSD Dar es Salaam</span></p></button>
        <button class="role-card" type="button" data-role="clinic" data-hash="#/"><h3>Clinic</h3><p>Receives shipments and independently verifies label, seal, quantity and condition. <span class="muted">Chanika Health Centre</span></p></button>
        <button class="role-card" type="button" data-role="auditor" data-hash="#/"><h3>Auditor</h3><p>Reviews discrepancies, inspects evidence and custody history, verifies records against the ledger. <span class="muted">District pharmacist</span></p></button>
      </div></div></section>

    <details class="panel extras"><summary class="panel-head"><h2>More scenarios</h2><span class="muted small">wrong facility, forged label, cold-chain excursion with simulated logger data</span></summary>
      <div class="panel-body">${extras.map(sc => `<div class="extra"><strong>${esc(sc.scenario)}</strong> · <span class="mono">${esc(sc.shipment.id)}</span> ${badge(sc.shipment.state, sc.shipment.stateLabel)}<div class="small muted">${esc(sc.instructions)}</div>
        <div class="small">Label: <span class="mono-wrap">${esc(sc.packages.map(p => p.code).join('  ·  '))}</span>${sc.packages[0].seal ? ` · seal reads <span class="mono">${esc(sc.packages.map(p => p.seal).join(', '))}</span>` : ''}</div></div>`).join('')}
        <p class="small">A forged label: take any label code above and change its last character. Printable labels for all scenarios: sign in as dispatcher or auditor and open <span class="mono">#/demo-kit</span>.</p>
      </div></details>`

  $$('[data-role]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true
    try {
      await enterDemo(b.dataset.role, b.dataset.hash)
    } catch (err) {
      b.disabled = false
      $('#hubMsg').innerHTML = errorBox(err, 'Could not open the demo workspace')
    }
  }))
  $('#resetDemo').addEventListener('click', async (e) => {
    if (!confirm('Reset the demo? All demo shipments return to their starting state and everyone is signed out. Demo data only.')) return
    const btn = e.currentTarget
    setBusy(btn, true, 'Resetting… (redeploying the test ledger)')
    try {
      await api('POST', '/api/demo/reset')
      session.token = null
      session.user = null
      store.del('medtrace.token')
      store.del('medtrace.user')
      sessionStorage.clear()
      await renderDemoHub()
      renderShell()
      $('#hubMsg').innerHTML = '<div class="note-box" style="margin-bottom:16px">Demo reset: both scenarios are back at step 1.</div>'
    } catch (err) {
      setBusy(btn, false)
      $('#hubMsg').innerHTML = errorBox(err, 'Reset failed')
    }
  })
}

/* ===================================================================== home */

function shipmentTable (list, { columns, empty, prio }) {
  if (!list.length) return `<div class="empty">${esc(empty)}</div>`
  const cols = {
    prio: ['Priority', s => { const p = prio(s.id); return `<span class="prio p-${p.level}" title="Rule-based review priority">${p.score}</span>` }],
    id: ['Shipment', s => `<a href="#/shipments/${esc(s.id)}" class="mono nowrap">${esc(s.id)}</a>`],
    order: ['eLMIS order', s => `<span class="mono small nowrap">${esc(s.externalRef.orderCode)}</span>`],
    commodity: ['Commodity', s => `${esc(s.commodity.name)}<div class="muted small">Batch ${esc(s.batch)}</div>`],
    destination: ['Destination', s => esc(s.destination.name)],
    qty: ['Quantity', s => fmt.qty(s.quantity, s.unit)],
    status: ['Status', s => badge(s.state, s.stateLabel) + reconBadge(s) + (s.coldChain && s.coldChain.status === 'EXCURSION' ? ` ${badge('WARN', 'Temperature excursion')}` : '')],
    result: ['Result', s => badge(s.verification.code, s.verification.label)],
    updated: ['Last update', s => `<span class="small">${fmt.date(s.updatedAt || s.createdAt)}</span>`],
    receive: ['', s => s.state === 'RECEIPT_PENDING' ? `<a class="btn small primary" href="#/receive/${esc(s.id)}">Continue receipt</a>` : '']
  }
  return `<div class="table-wrap"><table>
    <thead><tr>${columns.map(c => `<th>${cols[c][0]}</th>`).join('')}</tr></thead>
    <tbody>${list.map(s => `<tr class="link" data-id="${esc(s.id)}">${columns.map(c => `<td>${cols[c][1](s)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`
}

function bindRows (root = view()) {
  $$('tr.link', root).forEach(tr => tr.addEventListener('click', (e) => {
    if (e.target.closest('a, button')) return
    location.hash = `#/shipments/${tr.dataset.id}`
  }))
}

async function renderHome () {
  const list = await api('GET', '/api/shipments')
  const u = session.user
  if (u.role === 'clinic') {
    const expected = list.filter(s => ['IN_TRANSIT', 'RECEIPT_PENDING'].includes(s.state))
    const done = list.filter(s => !['CREATED', 'DISPATCHED', 'IN_TRANSIT', 'RECEIPT_PENDING'].includes(s.state))
    const waiting = expected.filter(s => s.state === 'RECEIPT_PENDING')
    view().innerHTML = `
      <div class="page-head">
        <div><h1>Deliveries for ${esc(u.facility.name)}</h1><p>When a delivery arrives, scan the QR label on the package before unpacking.</p></div>
        <a class="btn primary large" href="#/receive">Receive a delivery</a>
      </div>
      ${waiting.length ? `<div class="callout"><strong>${waiting.length} receipt(s) started but not confirmed.</strong> <a href="#/receive/${esc(waiting[0].id)}">Continue ${esc(waiting[0].id)}</a></div>`
        : expected.length ? `<div class="callout"><strong>${expected.length} deliver${expected.length === 1 ? 'y is' : 'ies are'} on the way to you.</strong> When one arrives, press <em>Receive a delivery</em> and scan its label.</div>` : ''}
      <section class="panel"><div class="panel-head"><h2>Expected deliveries</h2><span class="muted small">${expected.length} on the way</span></div>
        <div class="panel-body flush">${shipmentTable(expected, { columns: ['id', 'commodity', 'qty', 'status', 'receive'], empty: 'No deliveries are on the way to this facility.' })}</div></section>
      <section class="panel"><div class="panel-head"><h2>Recent receipts</h2></div>
        <div class="panel-body flush">${shipmentTable(done, { columns: ['id', 'commodity', 'qty', 'result', 'updated'], empty: 'No deliveries received yet.' })}</div></section>`
  } else if (u.role === 'dispatcher') {
    const toDispatch = list.filter(s => ['CREATED', 'DISPATCHED'].includes(s.state))
    view().innerHTML = `
      <div class="page-head">
        <div><h1>Shipments</h1><p>Consignments registered from eLMIS, sealed at dispatch and tracked to the receiving facility.</p></div>
        <div class="actions">${session.demoMode ? '<a class="btn" href="#/demo-kit">Demo labels</a>' : ''}<a class="btn ${toDispatch.length ? '' : 'primary'}" href="#/import">Import from eLMIS</a></div>
      </div>
      ${toDispatch.length ? `<div class="callout"><strong>${toDispatch.length} shipment(s) waiting for you.</strong> Seal and release the next one: <a class="btn small primary" href="#/shipments/${esc(toDispatch[toDispatch.length - 1].id)}">Open ${esc(toDispatch[toDispatch.length - 1].id)}</a></div>` : ''}
      ${list.length ? '' : '<div class="callout"><strong>No shipments yet.</strong> Create your first shipment by importing a released order from eLMIS. <a class="btn small primary" href="#/import">Import from eLMIS</a></div>'}
      <section class="panel"><div class="panel-body flush">${shipmentTable(list, { columns: ['id', 'order', 'commodity', 'destination', 'qty', 'status'], empty: 'No shipments yet. Import one from eLMIS.' })}</div></section>`
  } else {
    const ex = await api('GET', '/api/exceptions')
    const scoreOf = (id) => ex.shipments[id] || { score: 0, level: 'LOW', factors: [], missing: [] }
    const firstReview = (ex.exceptions.find(e => e.shipmentId) || {}).shipmentId
    // One row per shipment (exceptions arrive sorted by severity, then priority).
    const groups = []
    ex.exceptions.forEach((e, i) => {
      const g = e.shipmentId && groups.find(x => x.shipmentId === e.shipmentId)
      if (g) g.items.push(e)
      else groups.push({ shipmentId: e.shipmentId, items: [e], key: i })
    })
    const typeLabel = { DISPUTE_OPEN: 'Disputed receipts', DECISION_DUE: 'Decisions due', SEAL_MISMATCH: 'Seal mismatches', TEMPERATURE_EXCURSION: 'Temperature excursions', OVERDUE: 'Overdue', EVIDENCE_INTEGRITY: 'Evidence integrity', CUSTODY_GAP: 'Missing custody events', RECONCILIATION: 'Ledger reconciliation', SUSPICIOUS_SCAN: 'Counterfeit label scans', WRONG_FACILITY_SCAN: 'Wrong-facility scans', UNKNOWN_LABEL: 'Unknown labels' }
    view().innerHTML = `
      <div class="page-head"><div><h1>Custody audit</h1><p>Exceptions from receipts, scans, temperature logs and the ledger, highest priority first.</p></div>
        <button class="btn" type="button" id="reconcileAll">Reconcile all with ledger</button></div>
      <div id="reconcileResult"></div>
      ${firstReview ? `<div class="callout"><strong>${groups.length} item(s) need review.</strong> Start with the highest priority: <a class="btn small primary" href="#/shipments/${esc(firstReview)}">Open ${esc(firstReview)}</a></div>` : groups.length ? '' : '<div class="callout ok">Nothing needs review. Every receipt so far passed its checks.</div>'}
      ${Object.keys(ex.counts).length ? `<div class="chips">${Object.entries(ex.counts).map(([t, n]) => `<span class="chip"><strong>${n}</strong> ${esc(typeLabel[t] || t)}</span>`).join('')}</div>` : ''}
      <section class="panel"><div class="panel-head"><h2>Exceptions</h2><span class="muted small">${ex.exceptions.length} open on ${groups.length} item(s)</span></div>
        <div class="panel-body flush">${groups.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Priority</th><th>Shipment</th><th>Exceptions</th><th>Status</th><th>Latest</th><th></th></tr></thead>
          <tbody>${groups.map(g => {
            const sc = g.shipmentId ? scoreOf(g.shipmentId) : null
            const first = g.items[0]
            const latest = g.items.map(e => e.at).sort().slice(-1)[0]
            return `<tr class="${g.shipmentId ? 'link' : ''}" data-id="${esc(g.shipmentId || '')}">
              <td>${sc ? `<span class="prio p-${sc.level}" title="Rule-based review priority">${sc.score}</span>` : '—'}</td>
              <td class="nowrap">${g.shipmentId ? `<a class="mono" href="#/shipments/${esc(g.shipmentId)}">${esc(g.shipmentId)}</a>` : '<span class="muted">none</span>'}</td>
              <td>${g.items.map(e => `<div class="exc-item"><strong class="sev-${e.severity}">${esc(e.title)}</strong> <span class="small muted">${fmt.date(e.at)}</span><div class="small muted">${esc(e.reason || '')}</div></div>`).join('')}</td>
              <td>${first.state ? badge(first.state, first.stateLabel) : '—'}</td>
              <td class="small">${fmt.date(latest)}</td>
              <td>${g.shipmentId ? `<a class="btn small" href="#/shipments/${esc(g.shipmentId)}">${esc(first.action)}</a>` : `<span class="small">${esc(first.action)}</span>`}</td></tr>`
          }).join('')}</tbody></table></div>` : '<div class="empty">No open exceptions. Every receipt so far passed its checks.</div>'}</div></section>
      <p class="small muted">${esc(ex.method)}</p>
      <section class="panel"><div class="panel-head"><h2>All shipments</h2></div>
        <div class="panel-body flush">${shipmentTable(list, { columns: ['prio', 'id', 'order', 'commodity', 'destination', 'status', 'result'], empty: 'No shipments.', prio: scoreOf })}</div></section>`
    $('#reconcileAll').addEventListener('click', async (e) => {
      const btn = e.currentTarget
      setBusy(btn, true, 'Checking ledger…')
      try {
        const reports = await api('POST', '/api/reconcile')
        const changed = reports.filter(r => r.error || r.applied.length || r.failed.length || r.recovered.length || r.problems.length || r.pending.length)
        $('#reconcileResult').innerHTML = `<div class="outcome ${changed.length ? 'warn' : 'ok'}" style="margin-bottom:16px"><div class="icon">${changed.length ? '!' : '✓'}</div><div><h2>${changed.length ? `${changed.length} shipment(s) needed attention` : `All ${reports.length} shipment records match the ledger`}</h2>
          ${changed.length ? `<ul>${changed.map(r => `<li><span class="mono">${esc(r.shipmentId)}</span>: ${esc(r.error || [r.applied.length && `completed ${r.applied.join(', ')}`, r.recovered.length && `recovered ${r.recovered.join(', ')} from ledger`, r.failed.length && `marked ${r.failed.join(', ')} as failed`, r.pending.length && `${r.pending.join(', ')} still pending`, r.problems.length && r.problems.join('; ')].filter(Boolean).join('; '))}</li>`).join('')}</ul>` : ''}</div></div>`
        if (changed.length) setTimeout(() => route(), 2500)
      } catch (err) {
        $('#reconcileResult').innerHTML = errorBox(err, 'Reconciliation failed')
      } finally {
        setBusy(btn, false)
      }
    })
  }
  bindRows()
}

/* ===================================================================== QR scanner */

// jsQR 1.4.0 (Apache-2.0) is vendored so scanning works offline; the CDN is a fallback.
const JSQR_SOURCES = ['vendor/jsQR.js', 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js']
let jsQrLoading = null

function loadScript (src) {
  return new Promise(resolve => {
    const s = document.createElement('script')
    s.src = src
    const timer = setTimeout(() => resolve(false), 5000)
    s.onload = () => { clearTimeout(timer); resolve(Boolean(window.jsQR)) }
    s.onerror = () => { clearTimeout(timer); resolve(false) }
    document.head.appendChild(s)
  })
}

function loadJsQr () {
  if (window.jsQR) return Promise.resolve(true)
  if (!jsQrLoading) {
    jsQrLoading = (async () => {
      for (const src of JSQR_SOURCES) if (await loadScript(src)) return true
      return false
    })()
  }
  return jsQrLoading
}

async function qrDecoder () {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats()
      if (formats.includes('qr_code')) {
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] })
        return async (video) => { const r = await detector.detect(video); return r[0] && r[0].rawValue }
      }
    } catch (e) { /* fall through */ }
  }
  if (await loadJsQr()) {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    return async (video) => {
      const w = video.videoWidth
      const h = video.videoHeight
      if (!w || !h) return null
      const scale = Math.min(1, 640 / w)
      canvas.width = Math.round(w * scale)
      canvas.height = Math.round(h * scale)
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const r = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' })
      return r && r.data
    }
  }
  return null
}

/** Camera scanner with a typed-code fallback. onCode returns true to stop scanning. */
function mountScanner (root, onCode, { prompt = 'Point the camera at the QR label on the package' } = {}) {
  root.innerHTML = `
    <div class="scanner hidden"><video playsinline muted></video><div class="frame"></div><div class="scan-status">Starting camera…</div></div>
    <div class="actions" style="margin-bottom:14px"><button class="btn primary" type="button" data-start>Scan with camera</button></div>
    <form class="manual" autocomplete="off">
      <label class="field"><span>Or type the code printed under the QR</span>
        <input type="text" name="code" placeholder="MT1:SHP-2026-00001:1:XXXXXXXXXX" autocapitalize="characters" spellcheck="false"></label>
      <button class="btn" type="submit">Check code</button>
    </form>`
  const box = $('.scanner', root)
  const video = $('video', box)
  const status = $('.scan-status', box)
  let stream = null
  let timer = null
  let busy = false

  const stop = () => {
    if (timer) clearInterval(timer)
    timer = null
    if (stream) stream.getTracks().forEach(t => t.stop())
    stream = null
  }
  onLeave(stop)

  // Camera reads get a short cooldown so one label is not submitted on every frame;
  // typed codes are only blocked while a check is in flight.
  const submit = async (code, { fromCamera = false } = {}) => {
    if (busy) return
    busy = true
    try {
      const done = await onCode(code)
      if (done) stop()
    } finally {
      if (fromCamera) setTimeout(() => { busy = false }, 1200)
      else busy = false
    }
  }

  $('[data-start]', root).addEventListener('click', async (e) => {
    e.target.closest('.actions').classList.add('hidden')
    box.classList.remove('hidden')
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      status.textContent = 'Camera is not available on this connection. Type the code instead.'
      return
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
    } catch (err) {
      status.textContent = 'Camera permission was refused or no camera was found. Type the code instead.'
      return
    }
    video.srcObject = stream
    await video.play().catch(() => {})
    const decode = await qrDecoder()
    if (!decode) {
      status.textContent = 'This browser cannot read QR codes from the camera. Type the code printed under the QR.'
      return
    }
    status.textContent = prompt
    timer = setInterval(async () => {
      if (busy || !stream) return
      try {
        const code = await decode(video)
        if (code) { status.textContent = 'Label read. Checking…'; await submit(code, { fromCamera: true }); if (stream) status.textContent = prompt }
      } catch (e) { /* frame not ready */ }
    }, 250)
  })

  $('.manual', root).addEventListener('submit', (e) => {
    e.preventDefault()
    const code = e.target.code.value.trim()
    if (code) submit(code)
  })
  return { stop }
}

/* ===================================================================== photo capture */

async function compressImage (source) {
  // source: File/Blob or HTMLVideoElement
  let bitmap
  if (source instanceof HTMLVideoElement) {
    const c = document.createElement('canvas')
    c.width = source.videoWidth
    c.height = source.videoHeight
    c.getContext('2d').drawImage(source, 0, 0)
    bitmap = c
  } else {
    bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(source))
  }
  const width = bitmap.width
  const height = bitmap.height
  let maxSide = 1280
  let quality = 0.8
  for (let i = 0; i < 10; i++) {
    const scale = Math.min(1, maxSide / Math.max(width, height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
    if (blob && blob.size <= 240 * 1024) return blob
    quality -= 0.15
    if (quality < 0.45) { maxSide = Math.round(maxSide * 0.75); quality = 0.75 }
  }
  throw new Error('Could not make the photo small enough. Try again with less zoom.')
}

/* ===================================================================== receive wizard */

const STEPS = [['scan', 'Scan label'], ['verify', 'Verify shipment'], ['seal', 'Check seal'], ['photo', 'Take photo'], ['confirm', 'Confirm']]

function stepper (current) {
  const idx = STEPS.findIndex(s => s[0] === current)
  return `<ol class="steps" aria-label="Receiving steps">${STEPS.map(([key, label], i) => `<li class="${i < idx ? 'done' : i === idx ? 'current' : ''}" ${i === idx ? 'aria-current="step"' : ''}>${esc(label)}</li>`).join('')}</ol>
    ${idx > 0 ? '<p class="draft-note">Your answers are saved on this device as you go. Nothing is submitted until you press Confirm.</p>' : ''}`
}

async function renderReceive (id, prefill) {
  view().classList.add('narrow')
  if (session.user.role !== 'clinic') {
    view().innerHTML = '<div class="note-box">Receiving is done by the destination facility. Sign in with a facility account.</div>'
    return
  }
  if (!id) return receiveScanStep(prefill)
  const shipment = await api('GET', `/api/shipments/${id}`)
  if (shipment.state !== 'RECEIPT_PENDING') return receiveResult(shipment)
  const draft = draftStore.get(id)
  const step = draft.step || 'verify'
  if (step === 'seal') return receiveSealStep(shipment)
  if (step === 'photo') return receivePhotoStep(shipment)
  if (step === 'confirm') return receiveConfirmStep(shipment)
  return receiveVerifyStep(shipment)
}

function receiveScanStep (prefill) {
  view().innerHTML = `
    ${stepper('scan')}
    <section class="panel">
      <div class="panel-head"><h2>Scan the package label</h2></div>
      <div class="panel-body">
        <p class="muted" style="margin-top:0">Scan the QR label before opening the package. MedTrace checks that the label is genuine and that the delivery is addressed to ${esc(session.user.facility.name)}.</p>
        ${prefill ? '<div class="note-box" style="margin-bottom:12px">Demo: the code printed under the QR label has been typed in for you. Press <strong>Check code</strong>, or scan the label on the demo page with a camera.</div>' : ''}
        <div id="scanResult"></div>
        <div id="scanner"></div>
      </div>
    </section>`
  if (prefill) setTimeout(() => { const i = $('.manual input'); if (i) { i.value = prefill; $('.manual button').focus() } })
  mountScanner($('#scanner'), async (code) => {
    $('#scanResult').innerHTML = ''
    try {
      const res = await api('POST', '/api/scan', { code })
      draftStore.set(res.shipment.id, { ...draftStore.get(res.shipment.id), step: 'verify' })
      location.hash = `#/receive/${res.shipment.id}`
      return true
    } catch (err) {
      const advice = ['WRONG_FACILITY', 'LABEL_TAMPERED', 'UNKNOWN_SHIPMENT', 'NOT_IN_TRANSIT'].includes(err.code)
        ? '<p class="small" style="margin:6px 0 0">This attempt has been logged. Keep the package aside and contact MSD.</p>' : ''
      $('#scanResult').innerHTML = errorBox(err).replace('</div>', `${advice}</div>`)
      if (err.code === 'ALREADY_PROCESSED' && err.data.shipmentId) {
        $('#scanResult').insertAdjacentHTML('beforeend', `<p><a href="#/shipments/${esc(err.data.shipmentId)}">View the existing receipt record</a></p>`)
      }
      return false
    }
  })
}

function shipmentFacts (s) {
  return `<dl class="facts">
    <dt>Shipment</dt><dd class="mono">${esc(s.id)}</dd>
    <dt>Commodity</dt><dd>${esc(s.commodity.name)} <span class="muted small">(${esc(s.commodity.code)})</span></dd>
    <dt>Batch / lot</dt><dd class="mono">${esc(s.batch)}</dd>
    <dt>Expiry</dt><dd>${fmt.day(s.expiry)}</dd>
    <dt>Quantity shipped</dt><dd>${fmt.qty(s.quantity, s.unit)}</dd>
    <dt>Packages</dt><dd>${s.packageCount}</dd>
    <dt>From</dt><dd>${esc(s.source.name)}</dd>
    <dt>Donor / funding</dt><dd>${esc(s.donor ? s.donor.name : '—')}</dd>
  </dl>`
}

function receiveVerifyStep (s) {
  const draft = draftStore.get(s.id)
  const choice = (name, value, title, sub, cls = '') => `
    <label class="choice ${cls}"><input type="radio" name="${name}" value="${esc(value)}" ${String(draft[name]) === String(value) ? 'checked' : ''}><strong>${esc(title)}</strong>${sub ? `<small>${esc(sub)}</small>` : ''}</label>`
  view().innerHTML = `
    ${stepper('verify')}
    <div class="outcome ok" style="margin-bottom:16px"><div class="icon">✓</div><div><h2>Label signature valid for your facility</h2><p>That is the first check only. Now compare the delivery with the shipment record below.</p></div></div>
    <section class="panel"><div class="panel-head"><h2>Expected delivery</h2>${badge(s.state, s.stateLabel)}</div><div class="panel-body">${shipmentFacts(s)}</div></section>
    <section class="panel"><div class="panel-head"><h2>Packages</h2><span class="muted small">Scan every package label</span></div>
      <div class="panel-body">
        <div id="pkgList">${s.packages.map(p => `
          <div class="check ${p.scanned ? 'ok' : 'na'}"><span class="mark">${p.scanned ? '✓' : '○'}</span><span class="label">Package ${p.packageNo} of ${s.packageCount}</span><span class="value">${p.scanned ? 'Label verified' : 'Not scanned yet'}</span></div>`).join('')}</div>
        ${s.packages.some(p => !p.scanned) ? '<div id="pkgScanResult" style="margin-top:12px"></div><div id="pkgScanner" style="margin-top:12px"></div>' : ''}
      </div></section>
    <section class="panel"><div class="panel-head"><h2>Check the goods</h2></div>
      <div class="panel-body">
        <form id="verifyForm">
          <div class="field-label">Does the batch number printed on the packages read <span class="mono">${esc(s.batch)}</span>?</div>
          <div class="choices cols-2" style="margin-bottom:16px">${choice('batchMatches', 'true', 'Yes, it matches', '', 'ok')}${choice('batchMatches', 'false', 'No, it is different', '', 'bad')}</div>
          <label class="field"><span>Quantity counted</span><input type="number" name="quantity" min="0" inputmode="numeric" value="${esc(draft.quantity !== undefined ? draft.quantity : '')}" required>
            <div class="hint">Shipped: ${fmt.qty(s.quantity, s.unit)}. Count what actually arrived.</div></label>
          <div class="field-label">Condition of the goods</div>
          <div class="choices cols-2" style="margin-bottom:16px">${CONDITIONS.map(([v, t, sub]) => choice('condition', v, t, sub, v === 'GOOD' ? 'ok' : 'bad')).join('')}</div>
          <label class="field"><span>Notes <span class="muted">(optional)</span></span><textarea name="notes" rows="2" maxlength="500">${esc(draft.notes || '')}</textarea></label>
          <div id="verifyError"></div>
          <div class="actions end"><button class="btn primary large" type="submit">Next: check seal</button></div>
        </form>
      </div></section>
    <p class="small"><a href="#" id="refuse">Refuse this delivery without completing receipt</a></p>`

  if ($('#pkgScanner')) {
    mountScanner($('#pkgScanner'), async (code) => {
      try {
        await api('POST', '/api/scan', { code, expectShipmentId: s.id })
        saveVerify()
        route()
        return true
      } catch (err) {
        $('#pkgScanResult').innerHTML = errorBox(err)
        return false
      }
    }, { prompt: 'Scan the next package label' })
  }

  const form = $('#verifyForm')
  const saveVerify = () => {
    const d = draftStore.get(s.id)
    const fd = new FormData(form)
    draftStore.set(s.id, {
      ...d,
      batchMatches: fd.get('batchMatches') === null ? d.batchMatches : fd.get('batchMatches') === 'true',
      quantity: fd.get('quantity') === '' ? undefined : Number(fd.get('quantity')),
      condition: fd.get('condition') || d.condition,
      notes: fd.get('notes')
    })
  }
  form.addEventListener('change', saveVerify)
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    saveVerify()
    const d = draftStore.get(s.id)
    const missing = []
    if (typeof d.batchMatches !== 'boolean') missing.push('whether the batch matches')
    if (!Number.isInteger(d.quantity) || d.quantity < 0) missing.push('the quantity counted')
    if (!d.condition) missing.push('the condition of the goods')
    if (missing.length) { $('#verifyError').innerHTML = errorBox(new Error(`Please record ${missing.join(', ')}.`), 'Incomplete'); return }
    draftStore.set(s.id, { ...d, step: 'seal' })
    route()
  })
  $('#refuse').addEventListener('click', (e) => { e.preventDefault(); refuseDelivery(s) })
}

function refuseDelivery (s) {
  view().innerHTML = `
    <section class="panel"><div class="panel-head"><h2>Refuse delivery ${esc(s.id)}</h2></div>
      <div class="panel-body">
        <p class="muted" style="margin-top:0">The shipment will be marked DISPUTED and sent to the district pharmacist for investigation.</p>
        <form id="refuseForm">
          <label class="field"><span>Reason</span><textarea name="reason" rows="3" required maxlength="500"></textarea></label>
          <div id="refuseError"></div>
          <div class="actions end"><a class="btn" href="#/receive/${esc(s.id)}">Back</a><button class="btn danger" type="submit">Record as disputed</button></div>
        </form>
      </div></section>`
  $('#refuseForm').addEventListener('submit', async (e) => {
    e.preventDefault()
    const btn = e.submitter
    setBusy(btn, true)
    try {
      const res = await api('POST', `/api/shipments/${s.id}/dispute`, { reason: e.target.reason.value })
      draftStore.del(s.id)
      receiveResult(res, true)
    } catch (err) {
      $('#refuseError').innerHTML = errorBox(err)
      setBusy(btn, false)
    }
  })
}

function receiveSealStep (s) {
  const draft = draftStore.get(s.id)
  const seals = draft.seals || {}
  view().innerHTML = `
    ${stepper('seal')}
    <section class="panel"><div class="panel-head"><h2>Check the tamper seal</h2></div>
      <div class="panel-body">
        <p class="muted" style="margin-top:0">Every package was sealed at MSD. Look at the seal before opening and type the number printed on it. <strong>MedTrace does not show you the expected number</strong>: your reading is compared with the dispatch record only after you confirm, so the check is independent.</p>
        <form id="sealForm">
          ${s.packages.map(p => {
            const v = seals[p.packageNo] || {}
            const opt = (val, title, sub, cls) => `<label class="choice ${cls}"><input type="radio" name="seal-${p.packageNo}" value="${val}" ${v.seal === val ? 'checked' : ''}><strong>${title}</strong><small>${sub}</small></label>`
            return `<div class="pkg-row" data-pkg="${p.packageNo}">
              <h3>Package ${p.packageNo} of ${s.packageCount}</h3>
              <div class="choices cols-3">${opt('INTACT', 'Intact', 'Unbroken, not lifted', 'ok')}${opt('DAMAGED', 'Damaged', 'Cut, torn, lifted or re-taped', 'bad')}${opt('MISSING', 'Missing', 'No seal on the package', 'bad')}</div>
              <label class="field seal-number ${v.seal === 'MISSING' ? 'hidden' : ''}" style="margin:12px 0 0"><span>Number printed on the seal</span>
                <input type="text" name="sealNumber-${p.packageNo}" value="${esc(v.sealNumber || '')}" placeholder="e.g. MSD-S240117" autocapitalize="characters" spellcheck="false"></label>
            </div>`
          }).join('')}
          <div id="sealError"></div>
          <div class="actions end"><button class="btn" type="button" id="back">Back</button><button class="btn primary large" type="submit">Next: take photo</button></div>
        </form>
      </div></section>`
  const form = $('#sealForm')
  const save = () => {
    const out = {}
    s.packages.forEach(p => {
      const seal = (form.querySelector(`input[name="seal-${p.packageNo}"]:checked`) || {}).value
      out[p.packageNo] = { seal, sealNumber: form.querySelector(`input[name="sealNumber-${p.packageNo}"]`).value.trim() }
      $(`.pkg-row[data-pkg="${p.packageNo}"] .seal-number`).classList.toggle('hidden', seal === 'MISSING')
    })
    draftStore.set(s.id, { ...draftStore.get(s.id), seals: out })
    return out
  }
  form.addEventListener('change', save)
  form.addEventListener('input', save)
  $('#back').addEventListener('click', () => { draftStore.set(s.id, { ...draftStore.get(s.id), step: 'verify' }); route() })
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const out = save()
    const problem = s.packages.find(p => !out[p.packageNo].seal) ? 'Choose a seal result for every package.'
      : s.packages.find(p => out[p.packageNo].seal === 'INTACT' && !out[p.packageNo].sealNumber) ? 'Type the seal number for every intact seal.' : null
    if (problem) { $('#sealError').innerHTML = errorBox(new Error(problem), 'Incomplete'); return }
    draftStore.set(s.id, { ...draftStore.get(s.id), step: 'photo' })
    route()
  })
}

function receivePhotoStep (s) {
  const existing = s.receiptDraft && s.receiptDraft.evidence
  view().innerHTML = `
    ${stepper('photo')}
    <section class="panel"><div class="panel-head"><h2>Photograph the delivery</h2></div>
      <div class="panel-body">
        <p class="muted" style="margin-top:0">Take one clear photo showing the package, its label and the seal. It is stored as tamper-proof evidence with this receipt.</p>
        <div id="photoArea">${existing && existing.url ? `<img class="photo-preview" src="${esc(existing.url)}" alt="Receipt photo">` : ''}</div>
        <div id="photoStatus" class="small" style="margin:10px 0">${existing ? `Photo saved (${fmt.bytes(existing.size)}).` : ''}</div>
        <div id="photoError"></div>
        <div class="scanner hidden" id="webcamBox"><video playsinline muted></video></div>
        <div class="actions" style="margin-bottom:16px">
          <label class="btn primary"><input type="file" accept="image/*" capture="environment" id="photoInput" hidden>${existing ? 'Retake photo' : 'Take photo'}</label>
          <button class="btn" type="button" id="webcamBtn">Use webcam</button>
          <button class="btn primary hidden" type="button" id="snapBtn">Capture</button>
        </div>
        <div class="actions end"><button class="btn" type="button" id="back">Back</button><button class="btn primary large" type="button" id="next" ${existing ? '' : 'disabled'}>Next: confirm</button></div>
      </div></section>`

  let stream = null
  const stopCam = () => { if (stream) stream.getTracks().forEach(t => t.stop()); stream = null }
  onLeave(stopCam)

  const upload = async (source) => {
    $('#photoError').innerHTML = ''
    $('#photoStatus').textContent = 'Preparing photo…'
    $('#next').disabled = true
    try {
      const blob = await compressImage(source)
      $('#photoArea').innerHTML = `<img class="photo-preview" src="${URL.createObjectURL(blob)}" alt="Receipt photo">`
      $('#photoStatus').textContent = 'Saving photo…'
      const res = await api('POST', `/api/shipments/${s.id}/evidence`, null, { raw: blob, type: 'image/jpeg' })
      $('#photoStatus').textContent = `Photo saved (${fmt.bytes(res.size)}).`
      draftStore.set(s.id, { ...draftStore.get(s.id), evidenceCid: res.cid })
      $('#next').disabled = false
    } catch (err) {
      $('#photoStatus').textContent = ''
      $('#photoError').innerHTML = errorBox(err, 'Photo not saved')
    }
  }

  $('#photoInput').addEventListener('change', (e) => { if (e.target.files[0]) upload(e.target.files[0]) })
  $('#webcamBtn').addEventListener('click', async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      const video = $('#webcamBox video')
      video.srcObject = stream
      await video.play()
      $('#webcamBox').classList.remove('hidden')
      $('#snapBtn').classList.remove('hidden')
      $('#webcamBtn').classList.add('hidden')
    } catch (err) {
      $('#photoError').innerHTML = errorBox(new Error('No camera available here. Use "Take photo" to pick an image instead.'), 'Camera unavailable')
    }
  })
  $('#snapBtn').addEventListener('click', async () => {
    const video = $('#webcamBox video')
    await upload(video)
    stopCam()
    $('#webcamBox').classList.add('hidden')
    $('#snapBtn').classList.add('hidden')
    $('#webcamBtn').classList.remove('hidden')
  })
  $('#back').addEventListener('click', () => { draftStore.set(s.id, { ...draftStore.get(s.id), step: 'seal' }); route() })
  $('#next').addEventListener('click', () => { draftStore.set(s.id, { ...draftStore.get(s.id), step: 'confirm' }); route() })
}

function receiptBody (s, d) {
  return {
    packages: s.packages.map(p => ({ packageNo: p.packageNo, seal: ((d.seals || {})[p.packageNo] || {}).seal, sealNumber: ((d.seals || {})[p.packageNo] || {}).sealNumber })),
    batchMatches: d.batchMatches,
    condition: d.condition,
    quantityReceived: d.quantity,
    notes: d.notes,
    evidenceCid: s.receiptDraft && s.receiptDraft.evidence && s.receiptDraft.evidence.cid
  }
}

async function receiveConfirmStep (s) {
  const d = draftStore.get(s.id)
  // One key per receipt draft: pressing Confirm again after a dropped connection cannot record twice.
  if (!d.idem) draftStore.set(s.id, { ...d, idem: newKey() })
  const body = receiptBody(s, d)
  view().innerHTML = `${stepper('confirm')}<section class="panel"><div class="panel-body"><p class="muted">Checking the delivery…</p></div></section>`
  let preview
  try {
    preview = await api('POST', `/api/shipments/${s.id}/receipt/preview`, body)
  } catch (err) {
    view().innerHTML = `${stepper('confirm')}${errorBox(err, 'Could not check the delivery')}<div class="actions"><button class="btn" id="back">Back</button><button class="btn primary" id="retry">Try again</button></div>`
    $('#back').addEventListener('click', () => { draftStore.set(s.id, { ...draftStore.get(s.id), step: 'photo' }); route() })
    $('#retry').addEventListener('click', () => route())
    return
  }
  const disputed = preview.decision === 'DISPUTE'
  const warnings = preview.checks.filter(c => c.result === 'WARNING')
  view().innerHTML = `
    ${stepper('confirm')}
    <div class="outcome ${disputed ? 'bad' : 'ok'}" style="margin-bottom:16px"><div class="icon">${disputed ? '!' : '✓'}</div><div>
      <h2>${disputed ? 'Cannot be confirmed as a clean receipt' : 'Ready to confirm'}</h2>
      <p>${disputed
        ? 'Confirming records this delivery as <strong>DISPUTED</strong> and sends it, with your photo and answers, to the district pharmacist. Keep the stock in quarantine; do not issue it.'
        : 'Everything checked so far passes. The seal number you typed is compared with the dispatch record when you confirm; if it differs, the delivery is recorded as <strong>DISPUTED</strong> instead.'}</p>
      ${disputed ? `<ul>${preview.checks.filter(c => c.mandatory && c.result !== 'PASS' && !c.deferred).map(c => `<li>${esc(c.label)}: ${esc(c.reason)}</li>`).join('')}</ul>` : ''}
      ${warnings.length ? `<p class="small"><strong>Note:</strong> ${warnings.map(c => esc(c.reason)).join(' · ')}</p>` : ''}
    </div></div>
    <section class="panel"><div class="panel-head"><h2>Verification summary for ${esc(s.id)}</h2></div>
      <div class="panel-body">
        ${checkList(preview.checks)}
        <p class="hint">${esc(preview.limits)}</p>
        <div id="confirmError"></div>
        <div class="actions end">
          <button class="btn" type="button" id="back">Back</button>
          <button class="btn ${disputed ? 'danger' : 'primary'} large" type="button" id="confirm">${disputed ? 'Record delivery as disputed' : 'Confirm receipt'}</button>
        </div>
      </div></section>`
  $('#back').addEventListener('click', () => { draftStore.set(s.id, { ...draftStore.get(s.id), step: 'photo' }); route() })
  $('#confirm').addEventListener('click', async (e) => {
    const btn = e.currentTarget
    setBusy(btn, true, 'Submitting to the ledger…')
    $('#confirmError').innerHTML = ''
    try {
      const res = await api('POST', `/api/shipments/${s.id}/receipt`, body, { idem: draftStore.get(s.id).idem })
      draftStore.del(s.id)
      receiveResult(res, true)
    } catch (err) {
      setBusy(btn, false)
      let advice = ''
      if (err.code === 'LEDGER_UNAVAILABLE' || err.code === 'OFFLINE') advice = ' Your answers and photo are kept on this device; press the button again when the service is back.'
      $('#confirmError').innerHTML = errorBox(new Error(err.message + advice), SCAN_TITLES[err.code] || 'Receipt not saved')
      if (err.code === 'LEDGER_UNCONFIRMED') btn.disabled = true
      if (err.status === 409 || err.code === 'LEDGER_UNCONFIRMED') $('#confirmError').insertAdjacentHTML('beforeend', `<p><a href="#/shipments/${esc(s.id)}">Open the shipment record</a></p>`)
    }
  })
}

function receiveResult (s, justNow = false) {
  view().classList.add('narrow')
  const r = s.receipt
  const v = r && r.verification
  const reasons = r ? v.reasonText : (s.dispute ? s.dispute.reasons : [])
  let box
  if (s.state === 'RECEIVED') {
    box = `<div class="outcome ok"><div class="icon">✓</div><div><h2>Received: all mandatory checks passed</h2><p>${esc(s.id)} was received at ${esc(s.destination.name)} with a matching label, intact seal, matching seal number, full quantity and a stored photo. Stock can be put away.</p></div></div>`
  } else if (['DISPUTED', 'INVESTIGATED'].includes(s.state)) {
    box = `<div class="outcome bad"><div class="icon">!</div><div><h2>Disputed: not a clean receipt</h2><p>${esc(s.id)} did not pass every check. <strong>Next:</strong> keep the stock in quarantine and do not issue it. The district pharmacist has it in the investigation queue with your photo and answers.</p>
      ${reasons && reasons.length ? `<ul>${reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div></div>`
  } else {
    box = `<div class="outcome neutral"><div class="icon">i</div><div><h2>${esc(s.stateLabel)}</h2><p>This shipment is not awaiting receipt.</p></div></div>`
  }
  view().innerHTML = `
    ${justNow ? '' : '<h1 style="margin-bottom:12px">Delivery status</h1>'}
    ${box}
    ${r ? `<p class="tl-ledger" style="margin:10px 0 16px">✓ Submitted and confirmed on the ledger in block ${esc(r.blockNumber)}</p>` : ''}
    ${comparisonBlock(s)}
    <div class="actions" style="margin-top:16px"><a class="btn primary" href="#/shipments/${esc(s.id)}">View full record</a><a class="btn" href="#/receive">Receive another delivery</a></div>`
  if (justNow) history.replaceState(null, '', `#/receive/${s.id}`)
}


/* ===================================================================== expected vs observed */

/** The heart of the demo: what MedTrace expected, what the clinic independently observed, what it concluded. */
function comparisonBlock (s) {
  const r = s.receipt
  if (!r || !r.verification.checks) return ''
  const v = r.verification
  const check = (id) => v.checks.find(c => c.id === id)
  const row = (what, expected, observed, c) => {
    const [cls, mark, word] = RESULT_UI[c ? c.result : 'NOT_CHECKED']
    return `<tr class="${cls}"><th scope="row">${what}</th><td data-label="Expected">${expected}</td><td data-label="Observed">${observed}</td><td data-label="Conclusion" class="concl"><span class="mark" aria-hidden="true">${mark}</span> ${word}</td></tr>`
  }
  const cond = CONDITIONS.find(c => c[0] === r.condition)
  const scanned = r.packages.filter(p => p.scanned).length
  const cc = s.coldChain
  const rows = [
    row('Package label', `Signed label for <span class="mono">${esc(s.id)}</span> → ${esc(s.destination.name)}`, `${scanned} of ${r.packages.length} scanned, signature valid`, check('labels')),
    ...r.packages.map(p => row(`Seal number${r.packages.length > 1 ? `, package ${p.packageNo}` : ''}`, p.expectedSealNumber ? `<span class="mono">${esc(p.expectedSealNumber)}</span> <span class="muted small">(dispatch record, hidden until submitted)</span>` : '<span class="muted">none recorded</span>', p.observedSealNumber ? `<span class="mono">${esc(p.observedSealNumber)}</span>` : '<span class="muted">not entered</span>', check(`seal-number-${p.packageNo}`))),
    ...r.packages.map(p => row(`Seal condition${r.packages.length > 1 ? `, package ${p.packageNo}` : ''}`, 'Intact', esc(p.seal.charAt(0) + p.seal.slice(1).toLowerCase()), check(`seal-${p.packageNo}`))),
    row('Batch / lot', `<span class="mono">${esc(s.batch)}</span>`, r.batchMatches ? 'Same batch on the package' : 'A different batch on the package', check('batch')),
    row('Quantity', fmt.qty(s.quantity, s.unit), `${fmt.qty(r.quantityReceived, s.unit)} counted`, check('quantity')),
    row('Condition', 'Good', esc(cond ? cond[1] : r.condition), check('condition')),
    ...(cc ? [row('Temperature', `${cc.range.minC}–${cc.range.maxC} °C`, cc.status === 'NO_DATA' ? 'No logger data' : cc.status === 'EXCURSION' ? `${cc.totalExcursionMinutes} min outside, peak ${cc.peakC} °C${cc.log && cc.log.source === 'SIMULATED' ? ' (simulated logger)' : ''}` : `All ${cc.count} readings in range${cc.log && cc.log.source === 'SIMULATED' ? ' (simulated logger)' : ''}`, check('cold-chain'))] : []),
    row('Photo evidence', 'Photo of package and seal', 'Stored; hash re-checked', check('evidence'))
  ]
  const clean = v.result === 'VERIFIED'
  return `<section class="panel compare"><div class="panel-head"><h2>Expected vs observed</h2>${badge(clean ? 'VERIFIED' : 'DISPUTED', clean ? 'Received' : 'Disputed')}</div>
    <div class="table-wrap"><table class="cmp">
      <thead><tr><th>Check</th><th>What MedTrace expected</th><th>What the clinic observed</th><th>Conclusion</th></tr></thead>
      <tbody>${rows.join('')}</tbody></table></div>
    <div class="panel-body conclusion ${clean ? 'ok' : 'bad'}">
      <strong>${clean ? 'Why it was received' : 'Why it was disputed'}:</strong>
      ${clean ? 'every mandatory check passed, so the custody contract recorded the delivery as RECEIVED.'
        : `${esc(v.reasonText.join('; '))}. A failed mandatory check cannot become a clean receipt: the contract recorded it as DISPUTED and sent it to the auditor, with the photo and these answers preserved.`}
      <div class="small muted" style="margin-top:6px">Recorded ${fmt.date(r.at)} by ${esc(r.receivedByName)}, ${esc(r.facilityName)} · confirmed on the ledger in block ${esc(r.blockNumber)}. ${esc(v.limits || '')}</div>
    </div></section>`
}

const JOURNEY_LABEL = { CREATED: 'Registered', DISPATCHED: 'Dispatched', IN_TRANSIT: 'In transit', RECEIPT_PENDING: 'Awaiting receipt', RECEIVED: 'Received', DISPUTED: 'Disputed', INVESTIGATED: 'Investigated', DECISION: 'Decision', ACCEPTED: 'Accepted', REJECTED: 'Rejected' }

function journey (s) {
  const disputed = ['DISPUTED', 'INVESTIGATED', 'ACCEPTED', 'REJECTED'].includes(s.state)
  const path = ['CREATED', 'DISPATCHED', 'IN_TRANSIT', 'RECEIPT_PENDING', ...(disputed ? ['DISPUTED', 'INVESTIGATED', ['ACCEPTED', 'REJECTED'].includes(s.state) ? s.state : 'DECISION'] : ['RECEIVED'])]
  const reached = new Set(s.events.map(e => e.toState))
  return `<ol class="journey" aria-label="Custody progress">${path.map(st => {
    const cls = st === s.state ? 'current' : reached.has(st) ? 'done' : ''
    const bad = ['DISPUTED', 'REJECTED'].includes(st) && reached.has(st) ? ' bad' : ''
    return `<li class="${cls}${bad}" ${st === s.state ? 'aria-current="step"' : ''}>${esc(JOURNEY_LABEL[st])}</li>`
  }).join('')}</ol>`
}

/** Plain-language "what happens next, and who does it" for the current role. */
function nextStep (s) {
  const role = session.user.role
  const mine = role === 'clinic'
  const dest = s.destination.name
  switch (s.state) {
    case 'CREATED': return role === 'dispatcher' ? 'Next: seal each package and record dispatch below.' : 'Waiting for MSD to seal and dispatch it.'
    case 'DISPATCHED': return role === 'dispatcher' ? 'Next: hand it over to transport below.' : 'Sealed at MSD, waiting for transport.'
    case 'IN_TRANSIT': return mine ? 'Next: when it arrives, press Receive a delivery and scan its label before opening it.' : `On its way to ${esc(dest)}. The clinic verifies it on arrival.`
    case 'RECEIPT_PENDING': return mine ? `Next: <a href="#/receive/${esc(s.id)}">finish the receipt</a>.` : `Arrived at ${esc(dest)}; the clinic is checking it.`
    case 'RECEIVED': return 'Complete: every mandatory check passed at receipt.'
    case 'DISPUTED': return role === 'auditor' ? 'Next: investigate. Compare expected and observed below, open the photo, verify against the ledger, then record your findings.' : mine ? 'Keep the stock in quarantine and do not issue it. The district pharmacist is investigating.' : 'Under investigation by the district pharmacist, who may contact MSD.'
    case 'INVESTIGATED': return role === 'auditor' ? 'Next: decide whether the stock is accepted or rejected.' : 'Investigation recorded; waiting for the decision.'
    case 'ACCEPTED': return 'Closed: the auditor accepted the stock after investigation.'
    case 'REJECTED': return 'Closed: the auditor rejected the stock after investigation.'
    default: return ''
  }
}

/* ===================================================================== shipment / audit page */

function eventTone (e) {
  if (e.toState === 'RECEIVED' || e.toState === 'ACCEPTED') return 'ok'
  if (e.toState === 'DISPUTED' || e.toState === 'REJECTED') return 'bad'
  if (e.toState === 'INVESTIGATED' || e.toState === 'RECEIPT_PENDING') return 'warn'
  return 'info'
}

function eventDetail (e) {
  const d = e.details || {}
  if (d.recoveredFromLedger) return '<span class="warn-text">Recovered from the ledger during reconciliation. Off-chain details (seal numbers, photos, notes) were not available.</span>'
  const note = e.recoveredAt ? ' <span class="warn-text">· completed by reconciliation after an interruption</span>' : ''
  return eventText(e, d) + note
}

function eventText (e, d) {
  switch (e.action) {
    case 'CREATE': return `Manifest: ${esc(d.manifest.commodity)} · batch ${esc(d.manifest.batch)} · ${d.manifest.quantity} units · ${d.manifest.packages} package(s)`
    case 'DISPATCH': return `Seals applied: ${d.seals.map(x => `package ${x.packageNo}: <span class="mono">${esc(x.sealNumber)}</span>`).join(', ')}`
    case 'DEPART': return `Vehicle <span class="mono">${esc(d.vehicle)}</span>${d.driver ? ` · driver ${esc(d.driver)}` : ''}`
    case 'ARRIVE': return `Package ${esc(d.scannedPackage)} label verified at ${esc(e.actor.facilityName || d.facilityCode)}`
    case 'RECEIVE': return `Verification: <strong>${esc(d.verification)}</strong> · seal ${esc(d.seal.toLowerCase())} · condition ${esc(d.condition.toLowerCase().replace(/_/g, ' '))} · ${d.quantityReceived} received${d.reasons.length ? ` · ${d.reasons.map(esc).join(', ')}` : ''}`
    case 'DISPUTE': return esc(d.reason)
    case 'INVESTIGATE': return esc(d.findings)
    case 'ACCEPT': case 'REJECT': return esc(d.notes || '')
    default: return ''
  }
}

function checkRow (label, ok, value) {
  const cls = ok === null ? 'na' : ok ? 'ok' : 'bad'
  const mark = ok === null ? '–' : ok ? '✓' : '✗'
  return `<div class="check ${cls}"><span class="mark">${mark}</span><span class="label">${esc(label)}</span><span class="value">${value}</span></div>`
}

function receiptPanel (s) {
  const r = s.receipt
  const tech = !isClinic()
  const scansOk = s.scans.filter(x => x.result === 'VERIFIED').length
  const scansBad = s.scans.filter(x => !['VERIFIED', 'LOOKUP'].includes(x.result))
  if (!r) {
    return `<section class="panel"><div class="panel-head"><h2>Receipt verification</h2></div><div class="panel-body">
      ${checkRow('QR label verification', scansOk ? true : null, scansOk ? `${scansOk} verified scan(s)` : 'Not scanned yet')}
      ${scansBad.length ? checkRow('Rejected scan attempts', false, `${scansBad.length} (see scan log)`) : ''}
      <p class="muted small" style="margin-bottom:0">${s.state === 'RECEIPT_PENDING' ? 'Arrived at the facility; receipt not yet confirmed.' : s.dispute ? 'No receipt was recorded; the delivery was disputed before receipt.' : ['RECEIVED', 'ACCEPTED', 'REJECTED'].includes(s.state) ? 'Receipt details were not available (step recovered from the ledger).' : 'Not yet received.'}</p>
    </div></section>`
  }
  const v = r.verification
  const clean = v.result === 'VERIFIED'
  const ev = r.evidence
  return `<section class="panel"><div class="panel-head"><h2>Receipt verification</h2>${badge(clean ? 'VERIFIED' : 'DISPUTED', clean ? 'All mandatory checks passed' : `${v.reasons.length} problem(s)`)}</div>
    <div class="panel-body">
      ${v.checks ? `<details class="allchecks"><summary>All ${v.checks.length} checks with reasons</summary>${checkList(v.checks)}</details>` : ''}
      ${tech ? `<div class="small" style="margin-top:10px">${r.packages.map(p => `Package ${p.packageNo}: seal ${esc(p.seal.toLowerCase())}${p.observedSealNumber ? `, read <span class="mono">${esc(p.observedSealNumber)}</span>` : ''}${p.expectedSealNumber ? `, dispatched <span class="mono">${esc(p.expectedSealNumber)}</span>` : ''}`).join('<br>')}${scansBad.length ? `<br>${scansBad.length} rejected scan attempt(s), see scan log` : ''}</div>` : ''}
      ${r.notes ? `<p class="small" style="margin:10px 0 0"><strong>Notes:</strong> ${esc(r.notes)}</p>` : ''}
      <p class="small muted" style="margin:10px 0 0">Recorded ${fmt.date(r.at)} by ${esc(r.receivedByName)}, ${esc(r.facilityName)}. ${esc(v.limits || '')}</p>
    </div>
    <div class="panel-head" style="border-top:1px solid var(--border)"><h2>Evidence photo</h2>${tech ? `<span class="muted small">${ev.storage === 'kubo' ? 'Pinned on IPFS node' : 'Local IPFS-compatible store'}</span>` : ''}</div>
    <div class="panel-body">
      ${ev.url ? `<a href="${esc(ev.url)}" target="_blank" rel="noopener noreferrer"><img class="evidence-img" src="${esc(ev.url)}" alt="Receipt photo for ${esc(s.id)}"></a>
      <p class="hint">Access-controlled link, valid for a few minutes. Every view re-checks the photo against its hash.</p>` : ''}
      ${tech ? `<dl class="facts" style="margin-top:12px">
        <dt>IPFS CID</dt><dd class="mono-wrap">${esc(ev.cid)}</dd>
        <dt>SHA-256</dt><dd class="mono-wrap">${esc(ev.sha256)}</dd>
        <dt>Size</dt><dd>${fmt.bytes(ev.size)} · ${esc(ev.mimeType)}</dd>
        <dt>Receipt transaction</dt><dd class="mono-wrap">${esc(r.txHash)} <span class="muted">(block ${r.blockNumber})</span></dd>
      </dl>` : ''}
    </div></section>`
}

function tempChart (cc) {
  const rs = cc.log.readings
  const W = 640
  const H = 160
  const pad = 28
  const lo = Math.min(cc.range.minC - 2, ...rs.map(r => r.c))
  const hi = Math.max(cc.range.maxC + 2, ...rs.map(r => r.c))
  const t0 = new Date(rs[0].at).getTime()
  const t1 = new Date(rs[rs.length - 1].at).getTime()
  const x = (t) => pad + (new Date(t).getTime() - t0) / Math.max(1, t1 - t0) * (W - pad - 8)
  const y = (c) => 8 + (hi - c) / (hi - lo) * (H - 8 - 20)
  const pts = rs.map(r => `${x(r.at).toFixed(1)},${y(r.c).toFixed(1)}`).join(' ')
  const exc = cc.excursions.map(e => `<rect x="${x(e.start).toFixed(1)}" y="8" width="${Math.max(2, x(e.end) - x(e.start)).toFixed(1)}" height="${H - 28}" class="exc"/>`).join('')
  return `<svg class="tchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Temperature readings with the permitted ${cc.range.minC} to ${cc.range.maxC} °C range">
    <rect x="${pad}" y="${y(cc.range.maxC).toFixed(1)}" width="${W - pad - 8}" height="${(y(cc.range.minC) - y(cc.range.maxC)).toFixed(1)}" class="band"/>
    ${exc}
    <text x="2" y="${(y(cc.range.maxC) + 4).toFixed(1)}" class="axis">${cc.range.maxC}°</text>
    <text x="2" y="${(y(cc.range.minC) + 4).toFixed(1)}" class="axis">${cc.range.minC}°</text>
    <polyline points="${pts}" class="line"/>
    <text x="${pad}" y="${H - 4}" class="axis">${esc(fmt.date(rs[0].at))}</text>
    <text x="${W - 8}" y="${H - 4}" class="axis" text-anchor="end">${esc(fmt.date(rs[rs.length - 1].at))}</text>
  </svg>`
}

function coldChainPanel (s) {
  const cc = s.coldChain
  if (!cc) return ''
  const tech = !isClinic()
  const sim = cc.log && cc.log.source === 'SIMULATED'
  const head = `<div class="panel-head"><h2>Cold chain · ${cc.range.minC}–${cc.range.maxC} °C</h2>${sim ? badge('WARN', 'Simulated readings') : ''}</div>`
  if (cc.status === 'NO_DATA') {
    return `<section class="panel">${head}<div class="panel-body"><div class="note-box">No temperature log has been attached. The temperature in transit is <strong>not verified</strong>.</div></div></section>`
  }
  const status = cc.status === 'EXCURSION'
    ? `<div class="outcome warn"><div class="icon">!</div><div><h2>Temperature excursion: needs pharmacist review</h2><p>Outside ${cc.range.minC}–${cc.range.maxC} °C for ${cc.totalExcursionMinutes} min in total (peak ${cc.peakC} °C). This flags the stock for review; it does not by itself mean the medicine is unusable.</p>
        <ul>${cc.excursions.map(e => `<li>${fmt.date(e.start)} to ${fmt.date(e.end)}: ${e.minutes} min ${e.direction === 'HIGH' ? 'above' : 'below'} range, ${e.direction === 'HIGH' ? 'max' : 'min'} ${e.peakC} °C (${e.readings} readings)</li>`).join('')}</ul></div></div>`
    : `<div class="outcome ok"><div class="icon">✓</div><div><h2>All ${cc.count} readings within range</h2><p>${cc.minC} to ${cc.maxC} °C recorded.</p></div></div>`
  return `<section class="panel">${head}<div class="panel-body">
    ${status}
    ${tempChart(cc)}
    <p class="hint">${sim ? '<strong>SIMULATED</strong> logger data generated for the demonstration, not a real sensor. ' : ''}${cc.count} readings ${fmt.date(cc.from)} to ${fmt.date(cc.to)} · excursions shorter than ${cc.toleranceMinutes} min are ignored · log attached by ${esc(cc.log.uploadedBy)} ${fmt.date(cc.log.uploadedAt)}</p>
    ${tech ? `<dl class="facts small"><dt>Device</dt><dd>${esc(cc.log.deviceId || '—')}</dd><dt>Log CID</dt><dd class="mono-wrap"><a href="${esc(cc.log.url)}" target="_blank" rel="noopener noreferrer">${esc(cc.log.cid)}</a></dd><dt>SHA-256</dt><dd class="mono-wrap">${esc(cc.log.sha256)}</dd></dl>
      <p class="hint">The log is stored content-addressed with the receipt evidence; its hash is recorded off-chain (the contract stores only the receipt outcome).</p>` : ''}
  </div></section>`
}

function riskPanel (risk, method) {
  if (!risk) return ''
  return `<section class="panel"><div class="panel-head"><h2>Review priority</h2><span class="prio p-${risk.level}">${risk.score} · ${risk.level.toLowerCase()}</span></div><div class="panel-body">
    ${risk.factors.length ? `<table class="small"><tbody>${risk.factors.map(f => `<tr><td>+${f.points}</td><td>${esc(f.text)}<div class="muted">${esc(f.detail || '')}</div></td></tr>`).join('')}</tbody></table>` : '<p class="small" style="margin-top:0">No rule matched: no recorded problems for this shipment.</p>'}
    ${risk.missing.length ? `<p class="small"><strong>Missing information (not scored):</strong> ${risk.missing.map(esc).join('; ')}</p>` : ''}
    <p class="hint">${esc(method)}</p>
  </div></section>`
}

async function renderShipment (id, flash) {
  const s = await api('GET', `/api/shipments/${id}`)
  const tech = !isClinic()
  const v = s.verification
  const tone = { VERIFIED: 'ok', ACCEPTED: 'ok', DISPUTED: 'bad', REJECTED: 'bad', UNDER_INVESTIGATION: 'warn', PENDING: 'neutral' }[v.code]
  let risk = null
  let method = ''
  if (tech) {
    try {
      const ex = await api('GET', '/api/exceptions')
      risk = ex.shipments[s.id]
      method = ex.method
    } catch (e) { /* priority panel is optional */ }
  }
  const rec = s.reconciliation
  view().innerHTML = `
    <div class="page-head">
      <div>
        <div class="muted small"><a href="#/">${isClinic() ? 'Deliveries' : 'Shipments'}</a> /</div>
        <h1 class="mono">${esc(s.id)}</h1>
        <p>${esc(s.commodity.name)} → ${esc(s.destination.name)}</p>
      </div>
      <div class="actions no-print">
        ${tech ? `<a class="btn" href="#/shipments/${esc(s.id)}/labels">Package labels</a>` : ''}
        ${isClinic() && s.state === 'RECEIPT_PENDING' ? `<a class="btn primary" href="#/receive/${esc(s.id)}">Continue receipt</a>` : ''}
        <button class="btn" type="button" onclick="window.print()">Print</button>
      </div>
    </div>
    ${flash || ''}
    ${rec && rec.status !== 'RECOVERED' ? `<div class="outcome warn" style="margin-bottom:16px"><div class="icon">!</div><div><h2>Reconciliation required</h2><p>${esc(rec.note || '')}</p>
      ${tech ? '<div class="actions" style="margin-top:8px"><button class="btn small" type="button" id="reconcile">Reconcile with ledger</button></div>' : '<p class="small">MSD or the auditor has been notified on their dashboard.</p>'}</div></div>` : ''}
    ${rec && rec.status === 'RECOVERED' ? `<div class="note-box" style="margin-bottom:16px">${esc(rec.note)}</div>` : ''}
    <div class="outcome ${tone}" style="margin-bottom:16px"><div class="icon" aria-hidden="true">${tone === 'ok' ? '✓' : tone === 'bad' ? '!' : 'i'}</div>
      <div class="grow"><h2>${esc(v.label)}</h2>
      ${journey(s)}
      <p class="next">${nextStep(s)}</p>
      ${s.dispute ? `<ul>${(s.dispute.reasons || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${s.dispute && s.dispute.findings ? `<p><strong>Investigation:</strong> ${esc(s.dispute.findings)}</p>` : ''}
      ${s.dispute && s.dispute.decision ? `<p><strong>Decision:</strong> ${esc(s.dispute.decision === 'ACCEPT' ? 'Accepted' : 'Rejected')} by ${esc(s.dispute.decidedBy)}${s.dispute.decisionNotes ? `: ${esc(s.dispute.decisionNotes)}` : ''}</p>` : ''}
      </div></div>
    <div id="actionsPanel"></div>
    ${comparisonBlock(s)}
    <div class="grid-2">
      <div class="stack">
        <section class="panel"><div class="panel-head"><h2>Shipment</h2></div><div class="panel-body">
          <dl class="facts">
            <dt>MedTrace ID</dt><dd class="mono">${esc(s.id)}</dd>
            <dt>MSD / eLMIS ref</dt><dd><span class="mono">${esc(s.externalRef.orderCode)}</span> · line ${s.externalRef.lineNo}<div class="muted small mono-wrap">${esc(s.externalRef.shipmentId)}</div></dd>
            <dt>Source</dt><dd>${esc(s.source.name)}</dd>
            <dt>Donor / funding</dt><dd>${esc(s.donor ? s.donor.name : '—')}</dd>
            <dt>Programme</dt><dd>${esc(s.programme || '—')}</dd>
            <dt>Destination</dt><dd>${esc(s.destination.name)} <span class="muted small">(${esc(s.destination.code)})</span></dd>
            <dt>Commodity</dt><dd>${esc(s.commodity.name)} <span class="muted small">(${esc(s.commodity.code)})</span></dd>
            <dt>Batch / lot</dt><dd class="mono">${esc(s.batch)}</dd>
            <dt>Expiry</dt><dd>${fmt.day(s.expiry)}</dd>
            <dt>Quantity</dt><dd>${fmt.qty(s.quantity, s.unit)}</dd>
            <dt>Storage</dt><dd>${s.coldChain ? `${s.coldChain.range.minC}–${s.coldChain.range.maxC} °C` : 'No temperature requirement'}</dd>
            <dt>Packages</dt><dd>${s.packages.map(p => `#${p.packageNo}${p.sealNumber && p.sealNumber !== 'recorded' ? ` seal <span class="mono">${esc(p.sealNumber)}</span>` : ''}`).join(' · ')}</dd>
          </dl>
        </div></section>
        <section class="panel"><div class="panel-head"><h2>Custody timeline</h2><span class="muted small">${s.events.length} ledger event(s)</span></div><div class="panel-body">
          <ol class="timeline">${s.events.map(e => `
            <li class="${eventTone(e)}">
              <div class="tl-head"><strong>${esc(ACTION_LABEL[e.action] || e.action)}</strong>${badge(e.toState, STATE_TEXT[e.toState] || e.toState)}</div>
              <div class="tl-meta">${fmt.date(e.at)} · ${esc(e.actor.name)}${e.actor.facilityName || ROLE_LABEL[e.actor.role] ? `, ${esc(e.actor.facilityName || ROLE_LABEL[e.actor.role])}` : ''}</div>
              <div class="tl-detail">${eventDetail(e)}</div>
              <div class="tl-ledger">✓ Confirmed on the ledger · block ${esc(e.chain.blockNumber)}</div>
              ${tech ? `<details class="tl-tech"><summary>Technical details</summary>tx ${esc(e.chain.txHash)}<br>signed by ${esc(e.chain.signer)}</details>` : ''}
            </li>`).join('')}</ol>
        </div></section>
      </div>
      <div class="stack">
        ${riskPanel(risk, method)}
        ${receiptPanel(s)}
        ${coldChainPanel(s)}
        ${tech ? `<section class="panel"><div class="panel-head"><h2>Ledger verification</h2><button class="btn small" type="button" id="verifyLedger">Verify against ledger</button></div>
          <div class="panel-body" id="ledgerResult"><p class="muted small" style="margin:0">Re-reads the shipment from the blockchain and compares state, events, manifest hash and evidence hashes with this record, then re-hashes the stored files.${s.lastLedgerCheck ? ` Last checked ${fmt.date(s.lastLedgerCheck.at)}: <strong>${esc(s.lastLedgerCheck.status.toLowerCase())}</strong>.` : ''}</p>
          <dl class="facts small" style="margin-top:10px"><dt>Ledger key</dt><dd class="mono-wrap">${esc(s.ledgerKey)}</dd><dt>Manifest hash</dt><dd class="mono-wrap">${esc(s.manifestHash)}</dd></dl></div></section>` : ''}
        ${s.integration ? `<section class="panel"><div class="panel-head"><h2>eLMIS proof of delivery</h2></div><div class="panel-body small">
          ${s.integration.reference ? `Submitted ${fmt.date(s.integration.podSubmittedAt)} · reference <span class="mono">${esc(s.integration.reference)}</span> (mock eLMIS, not a live connection)` : `Not submitted: ${esc(s.integration.podError)}`}</div></section>` : ''}
        <section class="panel"><div class="panel-head"><h2>Label scan log</h2></div><div class="panel-body flush">
          ${s.scans.length ? `<div class="table-wrap"><table><thead><tr><th>Time</th><th>By</th><th>Result</th></tr></thead><tbody>${s.scans.map(x => `
            <tr><td class="small">${fmt.date(x.at)}</td><td class="small">${esc(x.by)}${x.facility ? `<div class="muted">${esc(x.facility)}</div>` : ''}</td>
            <td class="small">${badge(x.result === 'VERIFIED' || x.result === 'LOOKUP' ? 'VERIFIED' : 'DISPUTED', x.result.replace(/_/g, ' ').toLowerCase())}<div class="muted">${esc(x.message)}</div></td></tr>`).join('')}</tbody></table></div>`
            : '<div class="empty">No scans yet.</div>'}
        </div></section>
      </div>
    </div>`
  renderActions(s)
  const reconcileBtn = $('#reconcile')
  if (reconcileBtn) {
    reconcileBtn.addEventListener('click', async () => {
      setBusy(reconcileBtn, true, 'Checking ledger…')
      try {
        const { report } = await api('POST', `/api/shipments/${s.id}/reconcile`)
        const parts = [report.applied.length && `completed ${report.applied.join(', ')}`, report.recovered.length && `recovered ${report.recovered.join(', ')} from the ledger`, report.failed.length && `${report.failed.join(', ')} never reached the ledger and can be retried`, report.pending.length && `${report.pending.join(', ')} still awaiting confirmation`, report.problems.length && report.problems.join('; ')].filter(Boolean)
        await renderShipment(s.id, `<div class="note-box" style="margin-bottom:16px"><strong>Reconciliation:</strong> ${esc(parts.join('; ') || 'record already matches the ledger')}.</div>`)
      } catch (err) {
        setBusy(reconcileBtn, false)
        reconcileBtn.insertAdjacentHTML('afterend', errorBox(err, 'Reconciliation failed'))
      }
    })
  }
  const verifyBtn = $('#verifyLedger')
  if (verifyBtn) {
    verifyBtn.addEventListener('click', async () => {
      setBusy(verifyBtn, true, 'Checking…')
      try {
        const res = await api('GET', `/api/shipments/${s.id}/ledger`)
        const look = { CONSISTENT: ['ok', '✓', 'Verified against the ledger: the record matches'], INCONSISTENT: ['bad', '!', 'Record does NOT match the ledger'], PENDING: ['warn', '…', 'Ledger update still awaiting confirmation: not judged yet'] }[res.status]
        $('#ledgerResult').innerHTML = `
          <div class="outcome ${look[0]}" style="margin-bottom:10px"><div class="icon">${look[1]}</div><div><h2>${look[2]}</h2><p class="small">Checked ${fmt.date(res.checkedAt)}</p></div></div>
          ${res.checks.map(c => checkRow(c.name, res.status === 'PENDING' && !c.ok ? null : c.ok, `<span class="mono-wrap">${esc(c.detail)}</span>`)).join('')}`
      } catch (err) {
        $('#ledgerResult').innerHTML = errorBox(err, 'Ledger check failed')
      } finally {
        setBusy(verifyBtn, false)
      }
    })
  }
}

function renderActions (s) {
  const acts = s.allowedActions
  const panel = $('#actionsPanel')
  const forms = []
  if (acts.includes('DISPATCH')) {
    forms.push(`<form data-act="dispatch"><h3>Dispatch and seal</h3><p class="muted small">Apply a numbered tamper seal to each package. Leave blank to generate seal numbers. Seal numbers are not printed on the label: the clinic reads them off the seal.</p>
      ${s.packages.map((p, i) => `<label class="field"><span>Seal number, package ${p.packageNo}</span><input type="text" name="seal${i}" placeholder="auto" maxlength="40"></label>`).join('')}
      <button class="btn primary" type="submit">Record dispatch</button></form>`)
  }
  if (session.user.role === 'dispatcher' && s.coldChain && !s.coldChain.log && ['DISPATCHED', 'IN_TRANSIT', 'RECEIPT_PENDING'].includes(s.state) && session.demoMode) {
    forms.push(`<form data-act="temperature/simulate"><h3>Temperature log <span class="badge s-WARN">demo</span></h3><p class="muted small">No real data logger is connected. Generate a clearly labelled SIMULATED log for this ${s.coldChain.range.minC}–${s.coldChain.range.maxC} °C item. A log cannot be replaced once attached.</p>
      <div class="actions"><button class="btn" type="submit" name="profile" value="normal">Simulate: in range</button><button class="btn" type="submit" name="profile" value="excursion">Simulate: excursion</button></div></form>`)
  }
  if (acts.includes('DEPART')) {
    forms.push(`<form data-act="depart"><h3>Hand over to transport</h3>
      <label class="field"><span>Vehicle registration</span><input type="text" name="vehicle" required placeholder="T 482 DKL" maxlength="20"></label>
      <label class="field"><span>Driver <span class="muted">(optional)</span></span><input type="text" name="driver" maxlength="80"></label>
      <button class="btn primary" type="submit">Mark in transit</button></form>`)
  }
  if (acts.includes('INVESTIGATE')) {
    forms.push(`<form data-act="investigate"><h3>Record investigation</h3>
      <label class="field"><span>Findings</span><textarea name="findings" rows="3" required maxlength="1000" placeholder="Who was interviewed, what was found, photos reviewed…"></textarea></label>
      <button class="btn primary" type="submit">Save findings</button></form>`)
  }
  if (acts.includes('ACCEPT') || acts.includes('REJECT')) {
    forms.push(`<form data-act="resolve"><h3>Decision</h3>
      <label class="field"><span>Notes</span><textarea name="notes" rows="2" maxlength="1000" placeholder="e.g. Accept 480 units; return damaged ampoules to MSD"></textarea></label>
      <div class="actions"><button class="btn primary" type="submit" name="decision" value="ACCEPT">Accept stock</button><button class="btn danger" type="submit" name="decision" value="REJECT">Reject stock</button></div></form>`)
  }
  if (acts.includes('DISPUTE') && session.user.role === 'auditor') {
    forms.push(`<form data-act="dispute"><h3>Raise dispute</h3>
      <label class="field"><span>Reason</span><textarea name="reason" rows="2" required maxlength="500"></textarea></label>
      <button class="btn danger" type="submit">Mark as disputed</button></form>`)
  }
  if (!forms.length) return
  panel.innerHTML = `<section class="panel no-print" style="margin-bottom:16px"><div class="panel-head"><h2>Next action</h2></div>
    <div class="panel-body"><div id="actError"></div><div class="grid-2">${forms.join('')}</div></div></section>`
  $$('form[data-act]', panel).forEach(form => {
    // Same key for every retry of this form, so a resubmission after a network error is applied once.
    const idem = newKey()
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      const btn = e.submitter
      const fd = new FormData(form)
      const act = form.dataset.act
      let body = {}
      if (act === 'dispatch') body = { sealNumbers: s.packages.map((p, i) => fd.get(`seal${i}`)) }
      if (act === 'depart') body = { vehicle: fd.get('vehicle'), driver: fd.get('driver') }
      if (act === 'investigate') body = { findings: fd.get('findings') }
      if (act === 'resolve') body = { decision: btn.value, notes: fd.get('notes') }
      if (act === 'dispute') body = { reason: fd.get('reason') }
      if (act === 'temperature/simulate') body = { profile: btn.value }
      $$('button', form).forEach(b => { b.disabled = true })
      setBusy(btn, true, 'Submitting to the ledger…')
      try {
        const res = await api('POST', `/api/shipments/${s.id}/${act}`, body, { idem: act === 'resolve' ? `${idem}-${btn.value}` : idem })
        const last = res.events[res.events.length - 1]
        const what = act === 'temperature/simulate' ? 'Simulated temperature log attached (stored off-chain, hash-checked).' : `${esc(ACTION_LABEL[last.action] || last.action)}: submitted and <strong>confirmed on the ledger</strong> in block ${esc(last.chain.blockNumber)}.`
        await renderShipment(s.id, `<div class="callout ok" role="status">${what}</div>`)
      } catch (err) {
        $('#actError').innerHTML = errorBox(err, SCAN_TITLES[err.code])
        setBusy(btn, false)
        $$('button', form).forEach(b => { b.disabled = err.code === 'LEDGER_UNCONFIRMED' })
      }
    })
  })
}

/* ===================================================================== labels */

// The label never shows the seal number: the clinic must read it off the physical seal.
function labelCard (s, pkg, svg, { forged = false, code, physicalSeal } = {}) {
  return `<div class="label-card ${forged ? 'forged' : ''}">
    <div class="qr">${svg}</div>
    <div>
      <div class="lbl-title">MEDTRACE · PACKAGE ${pkg.packageNo} OF ${s.packageCount}</div>
      <dl>
        <dt>Shipment</dt><dd>${esc(s.id)}</dd>
        <dt>Item</dt><dd>${esc(s.commodity.name)}</dd>
        <dt>Batch</dt><dd>${esc(s.batch)}</dd>
        <dt>Expiry</dt><dd>${fmt.day(s.expiry)}</dd>
        <dt>Deliver to</dt><dd>${esc(s.destination.name)}</dd>
        ${s.coldChain ? `<dt>Store at</dt><dd>${s.coldChain.range.minC}–${s.coldChain.range.maxC} °C</dd>` : ''}
      </dl>
    </div>
    <div class="code">${esc(code || pkg.code)}</div>
    ${physicalSeal ? `<div class="seal-tag" title="Stands in for the physical tamper seal in the demo">DEMO · seal on this package reads <strong>${esc(physicalSeal)}</strong></div>` : ''}
  </div>`
}

async function renderLabels (id) {
  const s = await api('GET', `/api/shipments/${id}`)
  if (isClinic()) throw new Error('Labels are printed by MSD dispatch.')
  const svgs = await Promise.all(s.packages.map(p => api('GET', `/api/shipments/${id}/packages/${p.packageNo}/qr.svg`, undefined, { text: true })))
  view().innerHTML = `
    <div class="page-head no-print"><div><div class="muted small"><a href="#/shipments/${esc(s.id)}">${esc(s.id)}</a> /</div><h1>Package labels</h1><p>Print and attach one label to each package before sealing.</p></div>
      <button class="btn primary" type="button" onclick="window.print()">Print labels</button></div>
    <div class="labels">${s.packages.map((p, i) => labelCard(s, p, svgs[i])).join('')}</div>`
}

async function renderDemoKit () {
  if (isClinic()) throw new Error('The demo kit is available to dispatch and auditor accounts.')
  const kit = await api('GET', '/api/demo-kit')
  const a = kit.scenarios.find(x => x.key === 'A')
  view().innerHTML = `
    <div class="page-head no-print"><div><h1>Demo label kit</h1><p>Print this page (or show it on a second screen) and scan the labels with the clinic account. Real labels carry no seal number; here a dashed tag stands in for the physical seal on each package.</p></div>
      <button class="btn primary" type="button" onclick="window.print()">Print kit</button></div>
    ${kit.scenarios.map(sc => `
      <section class="kit-scenario">
        <h2>${esc(sc.scenario)} · <a class="mono" href="#/shipments/${esc(sc.shipment.id)}">${esc(sc.shipment.id)}</a> ${badge(sc.shipment.state, sc.shipment.stateLabel)}</h2>
        <p>${esc(sc.instructions)}</p>
        <div class="labels">${sc.shipment.packages.map((p, i) => labelCard(sc.shipment, p, sc.qr[i], { physicalSeal: (sc.physicalSeals && sc.physicalSeals[i]) || (p.sealNumber && p.sealNumber !== 'recorded' ? p.sealNumber : null) })).join('')}</div>
      </section>`).join('')}
    ${kit.forged && a ? `<section class="kit-scenario">
      <h2>Forged label (wrong QR)</h2>
      <p>A copy of scenario A's label with one character of the signature changed. Scanning it is refused as altered or counterfeit and logged.</p>
      <div class="labels">${labelCard(a.shipment, a.shipment.packages[0], kit.forged.qr, { forged: true, code: kit.forged.code })}</div>
    </section>` : ''}`
}

/* ===================================================================== eLMIS import */

async function renderImport () {
  const pending = await api('GET', '/api/integrations/elmis/pending')
  view().innerHTML = `
    <div class="page-head"><div><h1>Import from eLMIS</h1><p>Shipments released by MSD in eLMIS (mock connector). Each line item becomes one sealed MedTrace consignment.</p></div></div>
    <div id="importError"></div>
    <section class="panel"><div class="panel-body flush">${pending.length ? `<div class="table-wrap"><table>
      <thead><tr><th>eLMIS order</th><th>Destination</th><th>Lines</th><th>Shipped</th><th></th></tr></thead>
      <tbody>${pending.map(p => `<tr><td class="mono small">${esc(p.orderCode)}</td><td>${esc(p.destination)}</td><td class="small">${p.lines.map(esc).join('<br>')}</td>
        <td class="small">${fmt.date(p.shippedDate)}</td><td><button class="btn small primary" data-id="${esc(p.externalId)}">Import</button></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">Everything released in eLMIS has been imported.</div>'}</div></section>`
  $$('button[data-id]').forEach(btn => btn.addEventListener('click', async () => {
    setBusy(btn, true, 'Importing…')
    try {
      const created = await api('POST', '/api/integrations/elmis/import', { externalId: btn.dataset.id })
      location.hash = created.length === 1 ? `#/shipments/${created[0].id}` : '#/'
    } catch (err) {
      $('#importError').innerHTML = errorBox(err, 'Import failed')
      setBusy(btn, false)
    }
  }))
}

/* ===================================================================== boot */

window.addEventListener('hashchange', route)
$('#logout').addEventListener('click', () => signOut())
setInterval(checkHealth, 10000)
checkHealth().finally(route)
