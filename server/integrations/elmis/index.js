const { fromElmisShipment, toProofOfDelivery } = require('./mapper')

/**
 * MSD/eLMIS integration adapter. It depends on the custody service, never the other
 * way round: the custody core only sees canonical consignments and emits events.
 */
function createElmisIntegration ({ source, custody, store }) {
  const importedRefs = () => new Set(store.data.shipments.map(s => `${s.externalRef.shipmentId}#${s.externalRef.lineNo}`))

  async function listPending () {
    const imported = importedRefs()
    const shipments = await source.listShipments()
    return shipments
      .filter(s => s.lineItems.some((_, i) => !imported.has(`${s.id}#${i + 1}`)))
      .map(s => ({
        externalId: s.id,
        orderCode: s.order.orderCode,
        destination: s.order.receivingFacility.name,
        shippedDate: s.shippedDate,
        lines: s.lineItems.map(l => `${l.orderable.fullProductName} × ${l.quantityShipped}`)
      }))
  }

  async function ingest (payload, user) {
    const consignments = fromElmisShipment(payload)
    const imported = importedRefs()
    const created = []
    for (const consignment of consignments) {
      if (imported.has(`${consignment.externalRef.shipmentId}#${consignment.externalRef.lineNo}`)) continue
      created.push(await custody.createShipment(user, consignment))
    }
    return created
  }

  async function importById (externalId, user) {
    const payload = await source.getShipment(externalId)
    if (!payload) {
      const err = new Error(`eLMIS shipment ${externalId} not found`)
      err.status = 404
      throw err
    }
    return ingest(payload, user)
  }

  function statusFor (externalId) {
    const consignments = store.data.shipments.filter(s => s.externalRef.shipmentId === externalId)
    if (!consignments.length) return null
    return {
      externalId,
      consignments: consignments.map(toProofOfDelivery)
    }
  }

  // Push proof-of-delivery back to eLMIS whenever a consignment reaches an outcome.
  // Integration failures are recorded but never roll back custody.
  custody.on('outcome', async (shipment) => {
    try {
      const result = await source.submitProofOfDelivery(toProofOfDelivery(shipment))
      shipment.integration = { podSubmittedAt: new Date().toISOString(), reference: result.reference, state: shipment.state }
    } catch (e) {
      shipment.integration = { podError: e.message, state: shipment.state }
    }
    store.save()
  })

  return { listPending, ingest, importById, statusFor }
}

module.exports = { createElmisIntegration }
