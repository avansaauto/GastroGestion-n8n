import { INVOICE_PROMPT_VERSION } from './types.js'

export const INVOICE_EXTRACTION_PROMPT = `SENDA OPS — extracción de comprobantes (${INVOICE_PROMPT_VERSION})

Analizá el PDF o imagen y devolvé solamente JSON válido. Transcribí lo visible: no inventes CUIT,
cantidades, unidades, conversiones, precios ni impuestos.

Cabecera:
- supplier_name, supplier_tax_id, document_type, document_number, issue_date, currency
- subtotal, discounts, tax, other_taxes, total, taxes_included
- main_category: gastronomic_merchandise | service | administrative_expense | rent |
  professional_fees | equipment | logistics | tax | mixed | other
- public_service se interpreta como service. No uses el nombre del proveedor como único
  criterio: basate en cargos, consumos, unidades y el tipo de comprobante.
- Identificadores auxiliares, sin confundirlos con el comprobante:
  client_number, meter_number, due_date, payment_code, print_number
- document_number es el número de comprobante (p. ej. A-0064-00658503), no el número de
  cliente, medidor, CESP, código de pago ni número de impresión.
- issue_date es la fecha de emisión, no el vencimiento ni el próximo vencimiento estimado.
- Para servicios: service_type (gas | electricity | internet | maintenance | other),
  billing_period, billing_period_start, billing_period_end, actual_consumption y
  billed_consumption. Los consumos usan {"quantity": number, "unit": string}. No conviertas
  m3, m³ ni kWh en cantidades de mercadería ni en unidades de inventario.
- Si falta un dato, devolve null y advertí en warnings[]. No inventes valores.
- doubtful_fields[] y warnings[]

Líneas:
- description_original: texto tal como aparece
- name y supplier_sku
- quantity, unit, package_count, units_per_package, content_per_unit, content_unit
- billed_weight, billed_weight_unit (peso/volumen facturado real, p. ej. columna Cant. KG)
- unit_price, amount, tax_rate, discount, category, usage_type
- is_summary

Reglas:
1. Marcá is_summary=true para subtotal, total, IVA y otros resúmenes fiscales.
2. Fletes, servicios e impuestos deben conservarse como líneas, no como productos.
3. Si un pack no indica su contenido, units_per_package debe ser null.
4. En documentos mixtos conservá todas las líneas y main_category=mixed.
5. No decidas altas de productos ni movimientos de inventario.
6. No uses valores por defecto para completar datos ausentes.
7. En facturas de servicios, quantity/unit de un cargo de consumo (m³, kWh) es consumo,
   no cantidad física de mercadería. Conservá impuestos, tasas y descuentos sin duplicar
   importes en el total.
8. Si la factura muestra peso facturado real (Cant. KG, Kg netos, peso), cargalo en
   billed_weight + billed_weight_unit (usualmente kg). Ese valor tiene prioridad sobre
   el peso aproximado de la descripción (p. ej. "x 1,5 Kg Aprox").
9. content_per_unit / content_unit = contenido de la presentación comercial (barra x 3,5 kg,
   bolsa x 5 kg, pack 10 x 1 kg). Para multipacks usá units_per_package + content_per_unit.

Formato:
{
  "supplier_name": string | null,
  "supplier_tax_id": string | null,
  "document_type": string | null,
  "document_number": string | null,
  "issue_date": "YYYY-MM-DD" | null,
  "currency": string | null,
  "subtotal": number | null,
  "discounts": number | null,
  "tax": number | null,
  "other_taxes": number | null,
  "total": number | null,
  "taxes_included": boolean,
  "main_category": string,
  "service_type": string | null,
  "billing_period": string | null,
  "billing_period_start": "YYYY-MM-DD" | null,
  "billing_period_end": "YYYY-MM-DD" | null,
  "actual_consumption": {"quantity": number, "unit": string} | null,
  "billed_consumption": {"quantity": number, "unit": string} | null,
  "client_number": string | null,
  "meter_number": string | null,
  "due_date": "YYYY-MM-DD" | null,
  "payment_code": string | null,
  "print_number": string | null,
  "doubtful_fields": string[],
  "warnings": string[],
  "lines": [{
    "description_original": string,
    "name": string | null,
    "supplier_sku": string | null,
    "quantity": number | null,
    "unit": string | null,
    "package_count": number | null,
    "units_per_package": number | null,
    "content_per_unit": number | null,
    "content_unit": string | null,
    "billed_weight": number | null,
    "billed_weight_unit": string | null,
    "unit_price": number | null,
    "amount": number | null,
    "tax_rate": number | null,
    "discount": number | null,
    "category": string | null,
    "usage_type": string | null,
    "is_summary": boolean
  }]
}`
