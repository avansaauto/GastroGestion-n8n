export type ParsedVoucherIdentity = {
  issuerTaxIdNormalized: string | null
  voucherType: string | null
  pointOfSale: string | null
  voucherNumber: string | null
}

export type CompleteVoucherIdentity = {
  issuerTaxIdNormalized: string
  voucherType: string
  pointOfSale: string
  voucherNumber: string
}

const CUIT_RE = /^\d{11}$/
const VOUCHER_TYPE_RE = /^[A-E]$/
const POINT_OF_SALE_RE = /^\d{4,5}$/
const VOUCHER_NUMBER_RE = /^\d{8}$/
const WITH_LETTER_RE = /^([A-E])-?(\d{4,5})-?(\d{8})$/
const WITHOUT_LETTER_RE = /^(\d{4,5})-(\d{8})$/

function digitsOnly(value: string | null | undefined): string | null {
  if (!value) return null
  const digits = value.replace(/\D/g, '')
  return digits.length > 0 ? digits : null
}

export function parseArgentineVoucher(
  documentNumber: string | null | undefined,
  documentType: string | null | undefined = null,
): Pick<ParsedVoucherIdentity, 'voucherType' | 'pointOfSale' | 'voucherNumber'> {
  if (!documentNumber) {
    return { voucherType: null, pointOfSale: null, voucherNumber: null }
  }
  const compact = documentNumber.trim().toUpperCase().replace(/\s+/g, '')
  const withLetter = compact.match(WITH_LETTER_RE)
  if (withLetter) {
    return {
      voucherType: withLetter[1],
      pointOfSale: withLetter[2],
      voucherNumber: withLetter[3],
    }
  }
  const withoutLetter = compact.match(WITHOUT_LETTER_RE)
  if (withoutLetter) {
    const typeMatch = documentType?.trim().toUpperCase().match(/\b([A-E])\b/)
    return {
      voucherType: typeMatch?.[1] ?? null,
      pointOfSale: withoutLetter[1],
      voucherNumber: withoutLetter[2],
    }
  }
  return { voucherType: null, pointOfSale: null, voucherNumber: null }
}

export function parseVoucherIdentity(input: {
  taxId?: string | null
  documentNumber?: string | null
  documentType?: string | null
}): ParsedVoucherIdentity {
  const parsed = parseArgentineVoucher(input.documentNumber, input.documentType)
  return {
    issuerTaxIdNormalized: digitsOnly(input.taxId),
    ...parsed,
  }
}

export function parseExplicitVoucherIdentity(input: {
  taxId?: string | null
  voucherType?: string | null
  pointOfSale?: string | null
  voucherNumber?: string | null
}): ParsedVoucherIdentity {
  const typeRaw = input.voucherType?.trim().toUpperCase() ?? ''
  const pos = input.pointOfSale?.trim() ?? ''
  const number = input.voucherNumber?.trim() ?? ''
  const letter = typeRaw.match(/\b([A-E])\b/)?.[1] ?? null
  const documentNumber = pos && number
    ? (letter ? `${letter}-${pos}-${number}` : `${pos}-${number}`)
    : null
  return parseVoucherIdentity({
    taxId: input.taxId,
    documentNumber,
    documentType: typeRaw || null,
  })
}

export function isCompleteVoucherIdentity(
  identity: ParsedVoucherIdentity,
): identity is CompleteVoucherIdentity {
  return Boolean(
    identity.issuerTaxIdNormalized
    && CUIT_RE.test(identity.issuerTaxIdNormalized)
    && identity.voucherType
    && VOUCHER_TYPE_RE.test(identity.voucherType)
    && identity.pointOfSale
    && POINT_OF_SALE_RE.test(identity.pointOfSale)
    && identity.voucherNumber
    && VOUCHER_NUMBER_RE.test(identity.voucherNumber),
  )
}
