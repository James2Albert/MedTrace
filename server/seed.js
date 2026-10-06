/**
 * DEMO FIXTURES. Resets the ledger contracts, database and evidence store, then creates demo
 * accounts and moves mock eLMIS shipments through the real custody service (same checks,
 * same ledger writes as production). Refuses to run unless demo mode is on.
 */
const fs = require('fs')
const { hashPin } = require('./auth')
const { simulateReadings } = require('./coldchain')

// Demo accounts. PINs are printed in the terminal by `npm run demo`; never shown in the UI.
const DEMO_USERS = [
  { username: 'msd.dispatch', pin: '1111', name: 'Neema Mushi', role: 'dispatcher', facilityCode: 'MSD-DSM-ZONE', title: 'Dispatch officer, MSD Dar es Salaam' },
  { username: 'chanika.clinic', pin: '2222', name: 'Fatma Said', role: 'clinic', facilityCode: 'HFR-105611', title: 'Pharmacy technician, Chanika Health Centre' },
  { username: 'mzinga.clinic', pin: '3333', name: 'Joseph Mrema', role: 'clinic', facilityCode: 'HFR-104287', title: 'Clinical officer, Mzinga Dispensary' },
  { username: 'district.auditor', pin: '4444', name: 'Grace Mollel', role: 'auditor', facilityCode: null, title: 'District pharmacist (auditor)' }
]

/**
 * Scenarios, in shipment-ID order (SHP-<year>-00001 ...). `transit` scenarios are dispatched
 * and handed to transport; `physicalSeals` is what the seal on the package actually reads
 * (shown in the demo kit). For B it differs from the dispatch record: the seal was replaced.
 */
const DEMO_SCENARIOS = [
  {
    key: 'A',
    externalId: '6a0f5c1e-3b47-4f0e-9d2a-1c8e7b5a9001',
    scenario: 'A: normal delivery',
    transit: true,
    seals: ['MSD-S240117'],
    physicalSeals: ['MSD-S240117'],
    instructions: 'Sign in as chanika.clinic. Scan this label, confirm batch and full quantity (240), mark the seal intact and type the number on the seal, take a photo, confirm. Expected: all checks pass, RECEIVED.'
  },
  {
    key: 'B',
    externalId: '6a0f5c1e-3b47-4f0e-9d2a-1c8e7b5a9002',
    scenario: 'B: seal replaced in transit',
    transit: true,
    seals: ['MSD-S240118'],
    physicalSeals: ['MSD-S240181'],
    instructions: 'Sign in as chanika.clinic. The seal looks intact but reads MSD-S240181: type exactly that. Everything else matches. Expected: seal number check FAILS, no clean receipt, DISPUTED; the auditor then investigates and decides.'
  },
  {
    key: 'WRONG_FACILITY',
    externalId: '6a0f5c1e-3b47-4f0e-9d2a-1c8e7b5a9003',
    scenario: 'Wrong facility',
    transit: true,
    seals: ['MSD-S240119'],
    physicalSeals: ['MSD-S240119'],
    instructions: 'Addressed to Mzinga Dispensary. Scanning it as chanika.clinic is refused and logged; scanning it as mzinga.clinic works.'
  },
  {
    key: 'DISPATCH',
    externalId: '6a0f5c1e-3b47-4f0e-9d2a-1c8e7b5a9004',
    scenario: 'Awaiting dispatch',
    transit: false,
    instructions: 'Two packages, not yet released. Scanning as chanika.clinic is refused until msd.dispatch records Dispatch and Depart on the shipment page.'
  },
  {
    key: 'COLD_OK',
    externalId: '6a0f5c1e-3b47-4f0e-9d2a-1c8e7b5a9006',
    scenario: 'Cold chain: in range (SIMULATED logger)',
    transit: true,
    seals: ['MSD-S240120'],
    physicalSeals: ['MSD-S240120'],
    temperatureProfile: 'normal',
    instructions: 'Td vaccine, 2–8 °C. The simulated logger stayed in range. Receive normally. Expected: temperature check passes, RECEIVED.'
  },
  {
    key: 'COLD_EXCURSION',
    externalId: '6a0f5c1e-3b47-4f0e-9d2a-1c8e7b5a9007',
    scenario: 'Cold chain: excursion (SIMULATED logger)',
    transit: true,
    seals: ['MSD-S240121'],
    physicalSeals: ['MSD-S240121'],
    temperatureProfile: 'excursion',
    instructions: 'MR vaccine, 2–8 °C. The simulated logger shows about 90 min above 8 °C. Seal and goods are fine. Expected: temperature check FAILS, DISPUTED for pharmacist review (not declared unusable).'
  },
  {
    key: 'GUIDED_A',
    externalId: '6a0f5c1e-3b47-4f0e-9d2a-1c8e7b5a9008',
    scenario: 'Guided A: legitimate delivery, from dispatch to receipt',
    transit: false,
    plannedSeals: ['MSD-S250007'],
    instructions: 'As msd.dispatch: record dispatch with seal MSD-S250007, then hand over to transport. As chanika.clinic: scan the label, count 30 tins, seal intact reading MSD-S250007, photo, confirm. Expected: RECEIVED.'
  }
]

// The two guided stories on the demo hub (/#/demo). Other scenarios are listed as extras.
const GUIDES = {
  GUIDED_A: {
    title: 'Scenario A: a legitimate delivery',
    story: 'MSD releases 30 tins of iron-folic acid tablets for Chanika Health Centre. Dispatch seals the package; the clinic checks it independently on arrival.'
  },
  B: {
    title: 'Scenario B: a suspicious delivery',
    story: 'A box of oxytocin arrives at Chanika looking normal, but its tamper seal was swapped in transit. The clinic types the number it actually sees; MedTrace compares it with the dispatch record.'
  }
}

async function seed (services, { writeArtifacts = true, log = console.log } = {}) {
  const { config, store, chain, wallets, evidence, elmis, elmisSource, custody } = services
  if (!config.demoMode) throw new Error('Demo reset is only allowed in demo mode (MEDTRACE_DEMO_MODE=1). It wipes the database.')

  const status = await chain.status()
  if (!status.connected) throw new Error(`Blockchain node not reachable at ${chain.rpcUrl}. Start it with: npm run chain`)

  log('Deploying contracts...')
  const deployed = await chain.deploy({ writeArtifacts })
  log(`  MedTraceCustody        ${deployed.custody.address}`)
  log(`  MedicalSupplyDonation  ${deployed.donation.address} (legacy donor UI)`)

  store.reset()
  fs.rmSync(evidence.dir, { recursive: true, force: true })
  fs.mkdirSync(evidence.dir, { recursive: true })
  store.data.meta.chain = {
    rpcUrl: chain.rpcUrl,
    custodyAddress: deployed.custody.address,
    donationAddress: deployed.donation.address,
    relayer: chain.relayer.address,
    deployedAt: new Date().toISOString()
  }

  store.data.facilities = elmisSource.facilities()
  DEMO_USERS.forEach((u, i) => {
    const walletIndex = i + 1
    store.data.users.push({
      id: `u${walletIndex}`,
      username: u.username,
      pinHash: hashPin(u.pin),
      name: u.name,
      title: u.title,
      role: u.role,
      facilityCode: u.facilityCode,
      walletIndex,
      address: wallets.forIndex(walletIndex).address
    })
  })
  store.save()

  log('Registering embedded wallets as ledger actors...')
  for (const user of store.data.users) {
    await chain.setActor(user.address, user.role, user.role === 'clinic' ? user.facilityCode : null, true)
  }

  const dispatcher = store.data.users.find(u => u.role === 'dispatcher')
  log('Importing shipments from eLMIS (mock)...')
  const demo = []
  for (const item of DEMO_SCENARIOS) {
    const [shipment] = await elmis.importById(item.externalId, dispatcher)
    if (item.transit) {
      await custody.dispatch(dispatcher, shipment.id, { sealNumbers: item.seals })
      if (item.temperatureProfile) {
        await custody.attachTemperatureLog(dispatcher, shipment.id, {
          source: 'SIMULATED',
          deviceId: `SIM-${item.temperatureProfile}`,
          readings: simulateReadings({ profile: item.temperatureProfile, range: shipment.coldChain })
        })
      }
      await custody.depart(dispatcher, shipment.id, { vehicle: 'T 482 DKL', driver: 'Said Ally' })
    }
    demo.push({ ...item, shipment })
  }
  store.data.meta.demo = demo.map(d => ({
    key: d.key,
    scenario: d.scenario,
    instructions: d.instructions,
    physicalSeals: d.physicalSeals || null,
    plannedSeals: d.plannedSeals || null,
    guide: GUIDES[d.key] || null,
    shipmentId: d.shipment.id
  }))
  store.save()

  log('\nDemo shipments:')
  for (const d of demo) {
    log(`  ${d.shipment.id}  ${d.shipment.state.padEnd(10)}  ${d.scenario}`)
    d.shipment.packages.forEach((p, i) => log(`      package ${p.packageNo}: ${p.code}${d.physicalSeals ? `   seal on package reads ${d.physicalSeals[i]}` : ''}`))
  }
  log('\nDemo accounts (staff ID / PIN), demo mode only:')
  DEMO_USERS.forEach(u => log(`  ${u.username.padEnd(17)} ${u.pin}   ${u.title}`))
  return { deployed, demo }
}

module.exports = { seed, DEMO_USERS, DEMO_SCENARIOS, GUIDES }
