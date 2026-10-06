/**
 * Translation between eLMIS (OpenLMIS v3-style) payloads and MedTrace's canonical
 * consignment model. This is the only place that knows eLMIS field names; the custody
 * core and the contract never see them.
 */

class MappingError extends Error {
  constructor (message) {
    super(message)
    this.status = 422
    this.code = 'ELMIS_PAYLOAD_INVALID'
  }
}

function required (value, field) {
  if (value === undefined || value === null || value === '') throw new MappingError(`eLMIS payload missing ${field}`)
  return value
}

/** Temperature requirement from the product's storage condition, e.g. { minC: 2, maxC: 8 }. */
function storageRange (line, index) {
  const st = line.orderable && line.orderable.storage
  if (!st) return null
  const minC = Number(st.minC)
  const maxC = Number(st.maxC)
  if (!Number.isFinite(minC) || !Number.isFinite(maxC) || minC >= maxC) throw new MappingError(`lineItems[${index}].orderable.storage needs numeric minC < maxC`)
  const range = { minC, maxC }
  if (st.toleranceMinutes !== undefined) range.toleranceMinutes = Math.max(0, Number(st.toleranceMinutes) || 0)
  return range
}

/**
 * One eLMIS shipment can carry several line items. MedTrace tracks each line item as its
 * own sealed consignment (one commodity, one lot), so a shipment maps to 1..n consignments.
 */
function fromElmisShipment (payload) {
  const order = required(payload.order, 'order')
  const lines = required(payload.lineItems, 'lineItems')
  if (!Array.isArray(lines) || lines.length === 0) throw new MappingError('eLMIS shipment has no line items')

  return lines.map((line, index) => {
    const quantity = Number(required(line.quantityShipped, `lineItems[${index}].quantityShipped`))
    if (!Number.isInteger(quantity) || quantity <= 0) throw new MappingError(`lineItems[${index}].quantityShipped must be a positive integer`)
    const packages = Number(line.packages || 1)
    if (!Number.isInteger(packages) || packages < 1 || packages > 20) throw new MappingError(`lineItems[${index}].packages must be 1-20`)
    return {
      externalRef: {
        system: 'eLMIS',
        shipmentId: required(payload.id, 'id'),
        lineNo: index + 1,
        orderCode: required(order.orderCode, 'order.orderCode'),
        proofOfDeliveryId: payload.proofOfDeliveryId || null
      },
      source: { code: required(order.supplyingFacility && order.supplyingFacility.code, 'order.supplyingFacility.code'), name: order.supplyingFacility.name },
      donor: order.fundingSource ? { code: order.fundingSource.code, name: order.fundingSource.name } : null,
      programme: order.program ? order.program.name : null,
      destinationFacilityCode: required(order.receivingFacility && order.receivingFacility.code, 'order.receivingFacility.code'),
      commodity: {
        code: required(line.orderable && line.orderable.productCode, `lineItems[${index}].orderable.productCode`),
        name: required(line.orderable.fullProductName, `lineItems[${index}].orderable.fullProductName`)
      },
      unit: line.orderable.dispensingUnit || 'unit',
      batch: required(line.lot && line.lot.lotCode, `lineItems[${index}].lot.lotCode`),
      expiry: line.lot.expirationDate || null,
      quantity,
      packages,
      coldChain: storageRange(line, index),
      shippedDate: payload.shippedDate || null
    }
  })
}

const POD_STATUS = {
  RECEIVED: 'CONFIRMED',
  ACCEPTED: 'CONFIRMED',
  REJECTED: 'CONFIRMED',
  DISPUTED: 'INITIATED',
  INVESTIGATED: 'INITIATED'
}

/** MedTrace receipt -> eLMIS proof-of-delivery line (one per consignment). */
function toProofOfDelivery (shipment) {
  const receipt = shipment.receipt
  const accepted = shipment.state === 'RECEIVED' || shipment.state === 'ACCEPTED'
  const received = receipt ? receipt.quantityReceived : 0
  return {
    proofOfDeliveryId: shipment.externalRef.proofOfDeliveryId,
    shipmentId: shipment.externalRef.shipmentId,
    orderCode: shipment.externalRef.orderCode,
    status: POD_STATUS[shipment.state] || 'INITIATED',
    receivedBy: receipt ? receipt.receivedByName : null,
    receivedDate: receipt ? receipt.at : null,
    lineItem: {
      lineNo: shipment.externalRef.lineNo,
      productCode: shipment.commodity.code,
      lotCode: shipment.batch,
      quantityShipped: shipment.quantity,
      quantityAccepted: accepted ? received : 0,
      quantityRejected: shipment.state === 'REJECTED' ? received : (accepted ? shipment.quantity - received : 0),
      rejectionReasons: receipt ? receipt.verification.reasons : []
    },
    medtrace: {
      consignmentId: shipment.id,
      custodyState: shipment.state,
      evidenceCid: receipt ? receipt.evidence.cid : null,
      ledgerTx: receipt ? receipt.txHash : null
    }
  }
}

module.exports = { fromElmisShipment, toProofOfDelivery, MappingError }
