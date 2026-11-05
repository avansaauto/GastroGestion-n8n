/**
 * Ejecución administrativa del void excepcional MAYORISTANET 0012-00611278.
 *
 * - Usa ÚNICAMENTE el cliente service_role del backend (getSupabaseAdmin).
 * - Nunca expone SUPABASE_SERVICE_ROLE_KEY en logs ni en la respuesta.
 * - No es un endpoint HTTP ni código de navegador.
 *
 * Uso (desde apps/api, con .env cargado):
 *   npx tsx src/scripts/runExceptionalMayoristanetVoid.ts --dry-run
 *   npx tsx src/scripts/runExceptionalMayoristanetVoid.ts --confirm
 *
 * --confirm exige además:
 *   MAYORISTANET_VOID_CONFIRM=VOID_MAYORISTANET_0012-00611278
 * y el actor:
 *   MAYORISTANET_VOID_ACTOR_USER_ID=<uuid>  (default: a30637ba-0d16-4b28-9467-a923ff3dd62d)
 *
 * NO aplica el SQL del RPC: el RPC debe existir ya en Supabase (aplicación manual previa).
 * Este script solo invoca el RPC.
 */
import 'dotenv/config'
import { getSupabaseAdmin, isSupabaseAdminConfigured } from '../lib/supabase.js'

const RPC = 'senda_exceptional_void_mayoristanet_ef01f3a8'
const CONFIRM_TOKEN = 'VOID_MAYORISTANET_0012-00611278'
const DEFAULT_ACTOR = 'a30637ba-0d16-4b28-9467-a923ff3dd62d'
const DOCUMENT_ID = 'ef01f3a8-0953-4d02-9849-cceee251f4f5'

function usage(): string {
  return [
    'Uso:',
    '  npx tsx src/scripts/runExceptionalMayoristanetVoid.ts --dry-run',
    '  npx tsx src/scripts/runExceptionalMayoristanetVoid.ts --confirm',
    '',
    'Requiere SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY en apps/api/.env (solo backend).',
    `--confirm requiere MAYORISTANET_VOID_CONFIRM=${CONFIRM_TOKEN}`,
    'Opcional: MAYORISTANET_VOID_ACTOR_USER_ID=<uuid>',
  ].join('\n')
}

function redact(value: unknown): unknown {
  if (value == null) return value
  const raw = JSON.stringify(value)
  // Nunca filtrar secretos conocidos hacia stdout por accidente.
  if (/service_role|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\./i.test(raw)) {
    return { redacted: true, reason: 'possible_secret_in_payload' }
  }
  return value
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2))
  if (args.has('--help') || args.has('-h') || args.size === 0) {
    console.log(usage())
    return
  }
  const dryRun = args.has('--dry-run')
  const confirm = args.has('--confirm')
  if (dryRun === confirm) {
    throw new Error(`Elegí exactamente uno: --dry-run o --confirm.\n${usage()}`)
  }
  if (!isSupabaseAdminConfigured()) {
    throw new Error(
      'Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY. Solo backend; no usar anon key ni browser.',
    )
  }

  const actor =
    process.env.MAYORISTANET_VOID_ACTOR_USER_ID?.trim() || DEFAULT_ACTOR

  const payload: Record<string, unknown> = {
    actor_user_id: actor,
  }
  if (dryRun) {
    payload.dry_run = true
  } else {
    const envConfirm = process.env.MAYORISTANET_VOID_CONFIRM?.trim()
    if (envConfirm !== CONFIRM_TOKEN) {
      throw new Error(
        `Confirmación rechazada. Exportá MAYORISTANET_VOID_CONFIRM=${CONFIRM_TOKEN}`,
      )
    }
    payload.confirm = CONFIRM_TOKEN
  }

  console.log(
    JSON.stringify({
      rpc: RPC,
      mode: dryRun ? 'dry_run' : 'confirm',
      document_id: DOCUMENT_ID,
      actor_user_id: actor,
      service_role: 'used_in_process_only',
    }),
  )

  const admin = getSupabaseAdmin()
  const { data, error } = await admin.rpc(RPC, { p: payload })

  if (error) {
    console.error(
      JSON.stringify({
        ok: false,
        code: error.code ?? null,
        message: error.message ?? null,
        // details/hint pueden filtrar internos; no incluir service key.
        details: error.details ? String(error.details).slice(0, 300) : null,
      }),
    )
    process.exitCode = 1
    return
  }

  console.log(JSON.stringify({ ok: true, result: redact(data) }, null, 2))
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  console.error(JSON.stringify({ ok: false, message }))
  process.exitCode = 1
})
