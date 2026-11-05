import 'dotenv/config'
import {
  createGeminiInvoiceProviderFromEnv,
  createInvoiceReader,
  formatInvoiceAnalysisSummary,
  readLocalInvoice,
  saveLocalAnalysisResult,
} from '../modules/invoice-intelligence/index.js'

function usage(): string {
  return [
    'Uso:',
    '  npm run invoice:analyze -- /ruta/factura.pdf [--save]',
    '',
    'Formatos: PDF, JPG, JPEG, PNG o WebP. Tamaño máximo: 10 MB.',
    '--save guarda el JSON en apps/api/.local/invoice-analysis/ (ignorado por Git).',
  ].join('\n')
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage())
    return
  }
  const save = args.includes('--save')
  const unsupportedOptions = args.filter((arg) => arg.startsWith('-') && arg !== '--save')
  if (unsupportedOptions.length > 0) {
    throw new Error(`Opción no reconocida: ${unsupportedOptions[0]}\n${usage()}`)
  }
  const filePath = args.find((arg) => !arg.startsWith('-'))
  if (!filePath) throw new Error(`Falta indicar la ruta de una factura.\n${usage()}`)
  if (!process.env.GEMINI_API_KEY?.trim()) {
    throw new Error(
      'Falta GEMINI_API_KEY. Configurala en apps/api/.env; no se realizó ninguna llamada.',
    )
  }

  const input = await readLocalInvoice(filePath)
  const provider = createGeminiInvoiceProviderFromEnv()
  const result = await createInvoiceReader(provider).analyze(input)

  console.log(formatInvoiceAnalysisSummary(result))
  if (save) {
    const outputPath = await saveLocalAnalysisResult(result, input.filename ?? 'invoice')
    console.log(`Resultado JSON guardado localmente en: ${outputPath}`)
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Error desconocido.'
  console.error(`No se pudo analizar la factura: ${message}`)
  process.exitCode = 1
})
