const fs = require('fs')
const path = require('path')

/**
 * eLMIS source contract. A production connector (e.g. an HTTP client for the national
 * eLMIS/OpenLMIS API) implements the same three methods and is passed to
 * createElmisIntegration() instead of this mock; nothing else changes.
 *
 *   listShipments(): Promise<ElmisShipment[]>
 *   getShipment(id): Promise<ElmisShipment | null>
 *   submitProofOfDelivery(pod): Promise<{ accepted: boolean, reference: string }>
 */
class MockElmisSource {
  constructor (store, file = path.join(__dirname, 'mock-shipments.json')) {
    this.store = store
    this.dataset = JSON.parse(fs.readFileSync(file, 'utf8'))
  }

  facilities () {
    return this.dataset.facilities
  }

  async listShipments () {
    return this.dataset.shipments
  }

  async getShipment (id) {
    return this.dataset.shipments.find(s => s.id === id) || null
  }

  async submitProofOfDelivery (pod) {
    const entry = {
      reference: `MOCK-POD-${this.store.data.integrationOutbox.length + 1}`,
      submittedAt: new Date().toISOString(),
      pod
    }
    this.store.data.integrationOutbox.push(entry)
    this.store.save()
    return { accepted: true, reference: entry.reference }
  }
}

module.exports = { MockElmisSource }
