/** Helpers para crear/reactivar insumos desde la revisión de factura. */

export type SuggestedBaseUnit = 'g' | 'ml' | 'unit'

const MASS_HINT =
  /\b(kg|kilo|gramos?|g\b|harina|azucar|azúcar|carne|pollo|pescado|queso|panceta|tomate|cebolla|papa|aceite|manteca|sal|pimienta|fideo|arroz|legumbre|lenteja|poroto)\b/i
const VOLUME_HINT =
  /\b(litro|litros|\bl\b|ml|mililitro|cerveza|vino|jugo|leche|agua|crema|salsa|vinagre|gaseosa|bidon|bidón)\b/i
const COUNT_HINT =
  /\b(unidad|unidades|\bu\b|pack|packs|caja|cajas|docena|huevo|huevos|bolsa|bolsas|pieza|piezas|lata|latas)\b/i
const PACKAGING_MASS_HINT =
  /\b(plancha|barra|horma|bloque|pieza|bolsa|lata|pack|caja)\b/i

const MASS_UNITS = new Set([
  'mg', 'miligramo', 'miligramos',
  'g', 'gr', 'grs', 'gramo', 'gramos',
  'kg', 'kilo', 'kilos', 'kilogramo', 'kilogramos',
])
const VOLUME_UNITS = new Set([
  'ml', 'mililitro', 'mililitros',
  'cl', 'centilitro', 'centilitros',
  'l', 'lt', 'lts', 'litro', 'litros',
])
const COUNT_UNITS = new Set([
  'u', 'un', 'uni', 'und', 'unid', 'unidad', 'unidades', 'unit',
  'docena', 'docenas',
])

function declaredUnitKey(unit: string | null | undefined): string {
  return (unit ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

/** Unidad base explícita (masa, volumen o conteo). No interpreta empaques. */
export function declaredInventoryBaseUnit(
  unit: string | null | undefined,
): SuggestedBaseUnit | null {
  const key = declaredUnitKey(unit)
  if (!key) return null
  if (MASS_UNITS.has(key)) return 'g'
  if (VOLUME_UNITS.has(key)) return 'ml'
  if (COUNT_UNITS.has(key)) return 'unit'
  return null
}

/** Propone unidad base priorizando el contenido físico declarado. */
export function suggestInventoryBaseUnit(
  description: string | null | undefined,
  invoiceUnit: string | null | undefined,
  contentUnit?: string | null,
): SuggestedBaseUnit {
  const fromContent = declaredInventoryBaseUnit(contentUnit)
  if (fromContent) return fromContent
  const fromInvoice = declaredInventoryBaseUnit(invoiceUnit)
  if (fromInvoice) return fromInvoice

  const unit = declaredUnitKey(invoiceUnit)
  const text = `${description ?? ''} ${invoiceUnit ?? ''}`
  // Empaques de mercadería con kg/g en la descripción → inventario en gramos.
  if (PACKAGING_MASS_HINT.test(unit) && MASS_HINT.test(text)) return 'g'
  if (VOLUME_HINT.test(text) && !MASS_HINT.test(text)) return 'ml'
  if (MASS_HINT.test(text)) return 'g'
  if (COUNT_HINT.test(text) && !MASS_HINT.test(text)) return 'unit'
  return 'g'
}

export function preloadInventoryName(commercialDescription: string | null | undefined) {
  const trimmed = (commercialDescription ?? '').trim()
  if (!trimmed) return ''
  // Conserva el texto comercial como punto de partida editable.
  return trimmed.length > 120 ? `${trimmed.slice(0, 117).trim()}…` : trimmed
}

export function parseConversionFactorInput(raw: string): number | null {
  const normalized = raw.trim().replace(',', '.')
  if (!normalized) return null
  const value = Number(normalized)
  if (!Number.isFinite(value) || value <= 0) return null
  return value
}
