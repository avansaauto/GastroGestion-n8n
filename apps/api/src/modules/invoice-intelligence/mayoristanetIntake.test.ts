import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { suggestPresentationPhysical } from '../../http/invoiceUnits.js'
import { analyzeExtractedInvoice } from './analyze.js'
import { recoverCommercialPresentation } from './normalize.js'

const header = JSON.parse(
  readFileSync(new URL('./fixtures/mayoristanet-0012-00610241.json', import.meta.url), 'utf8'),
) as Record<string, unknown>

/**
 * Forma observada cuando Gemini deja unit en null y el contenido físico sí está declarado.
 * La Paulina 2×3,5 kg, Doña Aurora 8,88 kg facturados, azúcar 10×1 kg, leche 12×1 L,
 * pan rallado 2×5 kg, pimienta 1×1 kg.
 */
const liveLines = [
  {
    description_original: 'Queso Mozzarella P/Fetear La Paulina Barra',
    name: 'Queso Mozzarella P/Fetear La Paulina Barra',
    supplier_sku: 'F01360',
    quantity: 2,
    unit: null,
    content_per_unit: 3.5,
    content_unit: 'kg',
    unit_price: 26287.08,
    amount: 52574.16,
    category: 'Quesos',
    is_summary: false,
  },
  {
    description_original: 'Queso Mozzarella Doña Aurora Plancha',
    name: 'Queso Mozzarella Doña Aurora Plancha',
    quantity: 1,
    unit: null,
    content_per_unit: 8.8,
    content_unit: 'kg',
    billed_weight: 8.88,
    billed_weight_unit: 'kg',
    unit_price: 8213.95,
    amount: 72972.75,
    category: 'Quesos',
    is_summary: false,
  },
  {
    description_original: 'Azucar Blanca Ledesma Pack',
    name: 'Azucar Blanca Ledesma Pack',
    quantity: 1,
    unit: 'pack',
    package_count: 1,
    units_per_package: 10,
    content_per_unit: 1,
    content_unit: 'kg',
    unit_price: 12159.77,
    amount: 12159.77,
    is_summary: false,
  },
  {
    description_original: 'Leche Entera Larga Vida Tregar Pack',
    name: 'Leche Entera Larga Vida Tregar Pack',
    quantity: 1,
    unit: 'pack',
    package_count: 1,
    units_per_package: 12,
    content_per_unit: 1,
    content_unit: 'lt',
    unit_price: 16319.71,
    amount: 16319.71,
    is_summary: false,
  },
  {
    description_original: 'Pan Rallado Exclusivo Bolsa',
    name: 'Pan Rallado Exclusivo Bolsa',
    quantity: 2,
    unit: null,
    content_per_unit: 5,
    content_unit: 'kg',
    unit_price: 2500,
    amount: 5000,
    is_summary: false,
  },
  {
    description_original: 'Pimienta Negra Molida Marfeli Bolsa',
    name: 'Pimienta Negra Molida Marfeli Bolsa',
    quantity: 1,
    unit: null,
    content_per_unit: 1,
    content_unit: 'kg',
    unit_price: 4100,
    amount: 4100,
    is_summary: false,
  },
]

function lineByName(result: ReturnType<typeof analyzeExtractedInvoice>, name: string) {
  const line = result.document.lines.find((item) => item.name.includes(name))
  if (!line) throw new Error(`falta ${name}`)
  return line
}

describe('MAYORISTANET 0012-00610241 — unidades nulas y recepción', () => {
  const result = analyzeExtractedInvoice({ ...header, lines: liveLines })

  it('recupera una sola presentación comercial y no inventa otra', () => {
    expect(recoverCommercialPresentation('Queso La Paulina Barra', null)).toBe('barra')
    expect(recoverCommercialPresentation('Pan Rallado Bolsa', null)).toBe('bolsa')
    expect(recoverCommercialPresentation('Barra y bolsa', null)).toBeNull()
    expect(recoverCommercialPresentation('Mercadería suelta', null)).toBeNull()
    expect(recoverCommercialPresentation('Ya trae unidad', 'kg')).toBe('kg')
  })

  it('La Paulina, azúcar, leche, pan rallado y pimienta quedan en gramos o mililitros', () => {
    const paulina = lineByName(result, 'La Paulina')
    expect(paulina.unit).toBe('barra')
    expect(paulina.quantity).toBe(2)
    expect(paulina.inventoryPhysicalQuantity).toBe(7000)
    expect(suggestPresentationPhysical(paulina)).toMatchObject({ physicalQuantity: 7000, physicalUnit: 'g' })

    const azucar = lineByName(result, 'Azucar')
    expect(azucar.inventoryPhysicalQuantity).toBe(10000)
    expect(suggestPresentationPhysical(azucar)?.physicalUnit).toBe('g')

    const leche = lineByName(result, 'Leche')
    expect(leche.contentUnit).toBe('l')
    expect(leche.inventoryPhysicalQuantity).toBe(12000)
    expect(suggestPresentationPhysical(leche)).toMatchObject({ physicalQuantity: 12000, physicalUnit: 'ml' })

    const pan = lineByName(result, 'Pan Rallado')
    expect(pan.unit).toBe('bolsa')
    expect(pan.inventoryPhysicalQuantity).toBe(10000)
    expect(suggestPresentationPhysical(pan)).toMatchObject({ physicalQuantity: 10000, physicalUnit: 'g' })

    const pimienta = lineByName(result, 'Pimienta')
    expect(pimienta.unit).toBe('bolsa')
    expect(pimienta.inventoryPhysicalQuantity).toBe(1000)
    expect(suggestPresentationPhysical(pimienta)?.physicalUnit).toBe('g')
  })

  it('Doña Aurora propone 8.880 g y toma el importe facturado como costo', () => {
    const aurora = lineByName(result, 'Doña Aurora')
    expect(aurora.unit).toBe('plancha')
    expect(aurora.quantity).toBe(1)
    expect(aurora.unitPrice).toBe(8213.95)
    expect(aurora.amount).toBe(72972.75)
    expect(aurora.billedWeight).toBe(8.88)
    expect(aurora.inventoryPhysicalQuantity).toBe(8880)
    const interpretation = result.interpretation.lines.find((line) => line.lineId === aurora.id)
    expect(interpretation?.status).toBe('confirmed')
    expect(interpretation?.physical.priceBasis).toBe('weight')
    expect(interpretation?.physical.proposedQuantity).toBe(8880)
    expect(interpretation?.physical.unit).toBe('g')
    expect(interpretation?.economic.netAcquisitionAmount).toBe(72972.75)
    expect(result.interpretation.blocksReception).toBe(false)
    expect(aurora.inventoryEligibility).toBe('eligible')
  })

  it('sin contenido declarado no inventa una cantidad física', () => {
    const analyzed = analyzeExtractedInvoice({
      ...header,
      lines: [{
        description_original: 'Mercadería suelta',
        name: 'Mercadería suelta',
        quantity: 3,
        unit: null,
        unit_price: 100,
        amount: 300,
        is_summary: false,
      }],
    })
    const line = analyzed.document.lines[0]
    expect(line?.unit).toBeNull()
    expect(suggestPresentationPhysical(line!)).toBeNull()
    expect(line?.inventoryPhysicalQuantity).toBe(3)
  })
})
