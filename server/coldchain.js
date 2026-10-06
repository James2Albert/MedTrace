/**
 * Cold-chain temperature logs. A log is a list of { at, c } readings from a data logger
 * travelling with the shipment. The permitted range comes from the shipment (set from the
 * eLMIS product's storage condition), never from a universal hard-coded threshold.
 *
 * An excursion is a continuous run of out-of-range readings lasting at least the configured
 * tolerance. It flags the shipment for pharmacist review; it does not declare the stock unsafe.
 */

const MAX_READINGS = 2000
const SOURCES = ['LOGGER', 'SIMULATED']

class ColdChainError extends Error {
  constructor (message) {
    super(message)
    this.status = 400
    this.code = 'TEMPERATURE_LOG_INVALID'
  }
}

/** Validates and normalises an uploaded log. */
function normaliseLog ({ source, deviceId, readings } = {}) {
  if (!SOURCES.includes(source)) throw new ColdChainError(`source must be one of ${SOURCES.join(', ')}`)
  if (!Array.isArray(readings) || readings.length < 2) throw new ColdChainError('At least two readings are required')
  if (readings.length > MAX_READINGS) throw new ColdChainError(`At most ${MAX_READINGS} readings per log`)
  const out = readings.map((r, i) => {
    const at = new Date(r && r.at)
    const c = Number(r && r.c)
    if (Number.isNaN(at.getTime())) throw new ColdChainError(`readings[${i}].at is not a valid time`)
    if (!Number.isFinite(c) || c < -80 || c > 80) throw new ColdChainError(`readings[${i}].c must be a temperature in °C`)
    return { at: at.toISOString(), c: Math.round(c * 10) / 10 }
  })
  for (let i = 1; i < out.length; i++) {
    if (out[i].at <= out[i - 1].at) throw new ColdChainError('Readings must be in time order without duplicates')
  }
  return { source, deviceId: deviceId ? String(deviceId).slice(0, 60) : null, readings: out }
}

/**
 * @returns { status: NO_DATA | IN_RANGE | EXCURSION, range, count, minC, maxC, peakC, excursions[], totalExcursionMinutes, simulated }
 * Each excursion: { start, end, minutes, direction: HIGH|LOW, peakC, readings }.
 * The duration of a run is measured from its first out-of-range reading to the first reading back
 * in range (or the last reading, if it never came back).
 */
function analyse (log, range, toleranceMinutes = 15) {
  if (!range) return null
  if (!log || !log.readings || log.readings.length === 0) return { status: 'NO_DATA', range, count: 0, excursions: [], totalExcursionMinutes: 0 }
  const rs = log.readings
  const out = (r) => r.c > range.maxC ? 'HIGH' : r.c < range.minC ? 'LOW' : null
  const runs = []
  let run = null
  rs.forEach((r, i) => {
    const dir = out(r)
    if (dir && (!run || run.direction !== dir)) {
      if (run) { run.end = r.at; runs.push(run) }
      run = { start: r.at, end: r.at, direction: dir, peakC: r.c, readings: [r] }
    } else if (dir) {
      run.readings.push(r)
      run.peakC = dir === 'HIGH' ? Math.max(run.peakC, r.c) : Math.min(run.peakC, r.c)
    } else if (run) {
      run.end = r.at
      runs.push(run)
      run = null
    }
    if (run && i === rs.length - 1) { run.end = r.at; runs.push(run) }
  })
  const excursions = runs
    .map(x => ({ ...x, minutes: Math.round((new Date(x.end) - new Date(x.start)) / 60000) }))
    .filter(x => x.minutes >= toleranceMinutes && x.minutes > 0)
    .map(x => ({ start: x.start, end: x.end, minutes: x.minutes, direction: x.direction, peakC: x.peakC, readings: x.readings.length }))
  const temps = rs.map(r => r.c)
  const peak = excursions.reduce((p, x) => (p === null || Math.abs(x.peakC - (range.minC + range.maxC) / 2) > Math.abs(p - (range.minC + range.maxC) / 2)) ? x.peakC : p, null)
  return {
    status: excursions.length ? 'EXCURSION' : 'IN_RANGE',
    range,
    toleranceMinutes,
    count: rs.length,
    from: rs[0].at,
    to: rs[rs.length - 1].at,
    minC: Math.min(...temps),
    maxC: Math.max(...temps),
    peakC: peak,
    excursions,
    totalExcursionMinutes: excursions.reduce((n, x) => n + x.minutes, 0),
    simulated: log.source === 'SIMULATED'
  }
}

/**
 * SIMULATED logger feed for demonstrations only: deterministic readings every 10 minutes over
 * `hours`, ending at `end`. Profile 'normal' stays inside the range; 'excursion' rises above
 * the maximum for about 90 minutes in the middle of the journey.
 */
function simulateReadings ({ profile, range, end = new Date(), hours = 8, stepMinutes = 10 }) {
  if (!['normal', 'excursion'].includes(profile)) throw new ColdChainError('profile must be normal or excursion')
  const n = Math.floor(hours * 60 / stepMinutes) + 1
  const start = new Date(end).getTime() - (n - 1) * stepMinutes * 60000
  const mid = (range.minC + range.maxC) / 2
  const readings = []
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1)
    let c = mid + Math.sin(i * 0.7) * (range.maxC - range.minC) * 0.18
    if (profile === 'excursion' && t >= 0.4 && t < 0.4 + 90 / (hours * 60)) c = range.maxC + 2.5 + Math.sin(i) * 0.8
    readings.push({ at: new Date(start + i * stepMinutes * 60000).toISOString(), c: Math.round(c * 10) / 10 })
  }
  return readings
}

module.exports = { normaliseLog, analyse, simulateReadings, ColdChainError, MAX_READINGS }
