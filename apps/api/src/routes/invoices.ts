import { Router, type Request, type RequestHandler, type Response } from 'express'
import multer from 'multer'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js'
import { createInvoiceAnalyzeRateLimit } from '../middleware/invoiceRateLimit.js'
import { sha256Hex } from '../http/fileHash.js'
import { toInvoiceAnalysisApiResult } from '../http/invoiceAnalysisResponse.js'
import {
  integrityConfigFromEnv,
  issueInvoiceIntegrityToken,
  type InvoiceIntegritySigner,
} from '../http/invoiceIntegrity.js'
import { InvoiceQueryError } from '../http/invoiceQueryError.js'
import {
  invoiceQuery as defaultInvoiceQuery,
  type InvoiceQueryPort,
} from '../http/invoiceQuery.js'
import {
  invoiceMap as defaultInvoiceMap,
  type InvoiceMapPort,
} from '../http/invoiceMap.js'
import {
  invoiceReceive as defaultInvoiceReceive,
  type InvoiceReceivePort,
} from '../http/invoiceReceive.js'
import {
  invoiceCancel as defaultInvoiceCancel,
  type InvoiceCancelPort,
} from '../http/invoiceCancel.js'
import {
  invoiceDelete as defaultInvoiceDelete,
  type InvoiceDeletePort,
} from '../http/invoiceDelete.js'
import { createSupabaseConfirmIntentStore, inspectConfirmRecovery } from '../http/confirmIntent.js'
import {
  completeSavedInvoice,
  invoiceConfirmIntake as defaultInvoiceConfirmIntake,
  type ConfirmIntakeLineInput,
  type InvoiceConfirmIntakePort,
} from '../http/invoiceConfirmIntake.js'
import { InvoiceSaveError } from '../http/invoiceSaveError.js'
import { savePurchaseInvoice } from '../http/invoiceSave.js'
import {
  InvoiceAnalysisJobError,
  createInvoiceAnalysisJob,
  readInvoiceAnalysisJob,
  submitInvoiceAnalysisResult,
} from '../http/invoiceAnalysisJob.js'
import {
  dispatchFailureName,
  dispatchInvoiceAnalysisJob,
  n8nInvoiceWebhookFromEnv,
  type N8nInvoiceWebhookConfig,
} from '../http/invoiceAnalysisDispatch.js'
import {
  createFileInvoiceAnalysisJobStore,
  defaultInvoiceAnalysisJobsDirectory,
} from '../http/invoiceAnalysisJobStore.js'
import {
  ExtractionPayloadError,
  validateExtractedInvoice,
} from '../http/validateExtraction.js'
import {
  InvoiceAiProviderError,
  InvoiceUploadError,
  MAX_LOCAL_INVOICE_BYTES,
  createGeminiInvoiceProviderFromEnv,
  createInvoiceReader,
  inspectInvoiceBuffer,
  type InvoiceAiProvider,
} from '../modules/invoice-intelligence/index.js'
import { getSupabaseAdmin, isSupabaseAdminConfigured } from '../lib/supabase.js'
import type { OperationsRepository } from '../services/operationsRepository.js'
import { operationsRepository } from '../services/operationsRepository.js'

export const INVOICE_ANALYZE_HTTP_TIMEOUT_MS = 250_000

export type { InvoiceIntegritySigner }

export type InvoiceRouterDependencies = {
  auth?: RequestHandler
  repository?: Pick<OperationsRepository, 'listOrganizations'>
  provider?: InvoiceAiProvider
  rateLimit?: RequestHandler
  maxFileBytes?: number
  maxRequests?: number
  rateWindowMs?: number
  integrity?: InvoiceIntegritySigner | null
  getAdmin?: () => SupabaseClient
  saveNow?: () => Date
  query?: InvoiceQueryPort
  map?: InvoiceMapPort
  receive?: InvoiceReceivePort
  cancel?: InvoiceCancelPort
  deleteInvoice?: InvoiceDeletePort
  confirmIntake?: InvoiceConfirmIntakePort
  analysisJobsDirectory?: string
  analysisJobsNow?: () => Date
  analysisJobTtlMs?: number
  callbackTokenTtlMs?: number
  n8nWebhook?: N8nInvoiceWebhookConfig | null
  onAnalysisCallbackToken?: (delivery: {
    jobId: string
    callbackToken: string
    expiresAt: string
  }) => void
}

function jsonError(
  response: Response,
  status: number,
  code: string,
  error: string,
) {
  response.status(status).json({ error, code })
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const name = 'name' in error ? String(error.name) : ''
  const message = 'message' in error ? String(error.message) : ''
  if (name === 'TimeoutError' || name === 'AbortError') return true
  return error instanceof InvoiceAiProviderError
    && error.code === 'PROVIDER_UNAVAILABLE'
    && /timeout|timed out|aborted/i.test(error.message)
}

function logAnalyzeProviderError(
  stage: 'provider_init' | 'extract',
  error: InvoiceAiProviderError,
) {
  console.error(JSON.stringify({
    operation: 'invoice_analyze',
    stage,
    code: error.code,
    httpStatus: error.meta.httpStatus ?? null,
    providerStatus: error.meta.providerStatus ?? null,
    model: error.meta.model ?? null,
  }))
}

function mapProviderError(response: Response, error: InvoiceAiProviderError) {
  if (isTimeoutError(error)) {
    jsonError(response, 504, 'PROVIDER_TIMEOUT', 'El análisis de la factura superó el tiempo de espera.')
    return
  }
  switch (error.code) {
    case 'NOT_CONFIGURED':
      jsonError(response, 503, 'PROVIDER_NOT_CONFIGURED', 'El análisis de facturas no está configurado.')
      return
    case 'INVALID_INPUT':
      jsonError(response, 422, 'UNSUPPORTED_DOCUMENT', 'El documento no es compatible.')
      return
    case 'INVALID_RESPONSE':
      jsonError(
        response,
        502,
        'PROVIDER_INVALID_RESPONSE',
        'El proveedor devolvió una respuesta incompleta o inválida.',
      )
      return
    case 'AUTHENTICATION_FAILED':
    case 'REQUEST_REJECTED':
      jsonError(response, 502, 'PROVIDER_REJECTED', 'El proveedor rechazó el análisis.')
      return
    default:
      jsonError(response, 503, 'PROVIDER_UNAVAILABLE', 'El proveedor de análisis no está disponible.')
  }
}

function handleUpload(upload: RequestHandler): RequestHandler {
  return (request, response, next) => {
    upload(request, response, (error: unknown) => {
      if (!error) {
        next()
        return
      }
      if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
          jsonError(response, 413, 'FILE_TOO_LARGE', 'El archivo supera el máximo permitido de 10 MB.')
          return
        }
        if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
          jsonError(response, 400, 'TOO_MANY_FILES', 'Solo se admite un archivo por solicitud.')
          return
        }
      }
      jsonError(response, 400, 'INVALID_UPLOAD', 'No se pudo leer el archivo.')
    })
  }
}

export function createInvoicesRouter(dependencies: InvoiceRouterDependencies = {}) {
  const auth = dependencies.auth ?? requireAuth
  const repository = dependencies.repository ?? operationsRepository
  const maxFileBytes = dependencies.maxFileBytes ?? MAX_LOCAL_INVOICE_BYTES
  const rateLimit = dependencies.rateLimit ?? createInvoiceAnalyzeRateLimit({
    maxRequests: dependencies.maxRequests,
    windowMs: dependencies.rateWindowMs,
  })
  const analyzeUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      files: 1,
      fileSize: maxFileBytes,
      fields: 0,
    },
  }).single('file')
  const saveUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      files: 1,
      fileSize: maxFileBytes,
      fields: 16,
    },
  }).single('file')
  const analysisJobUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      files: 1,
      fileSize: maxFileBytes,
      fields: 8,
    },
  }).single('file')
  const analysisJobStore = createFileInvoiceAnalysisJobStore({
    directory: dependencies.analysisJobsDirectory ?? defaultInvoiceAnalysisJobsDirectory(),
    now: dependencies.analysisJobsNow,
    ttlMs: dependencies.analysisJobTtlMs,
    callbackTokenTtlMs: dependencies.callbackTokenTtlMs,
  })
  const n8nWebhook = dependencies.n8nWebhook === undefined
    ? n8nInvoiceWebhookFromEnv()
    : dependencies.n8nWebhook

  const query = dependencies.query ?? defaultInvoiceQuery
  const mapping = dependencies.map ?? defaultInvoiceMap
  const receive = dependencies.receive ?? defaultInvoiceReceive
  const cancel = dependencies.cancel ?? defaultInvoiceCancel
  const deleteInvoice = dependencies.deleteInvoice ?? defaultInvoiceDelete
  const confirmIntake = dependencies.confirmIntake ?? defaultInvoiceConfirmIntake
  const resolveAdmin = (): SupabaseClient | null => {
    if (dependencies.getAdmin) return dependencies.getAdmin()
    if (!isSupabaseAdminConfigured()) return null
    return getSupabaseAdmin()
  }

  const router = Router()

  router.get('/catalog/products', auth, async (request: Request, response: Response) => {
    try {
      const locationId = typeof request.query.locationId === 'string' ? request.query.locationId : ''
      const search = typeof request.query.q === 'string' ? request.query.q : undefined
      const data = await mapping.listCatalogProducts({
        userClient: (request as AuthenticatedRequest).supabase,
        locationId,
        search,
      })
      response.json({ data })
    } catch (error) {
      if (error instanceof InvoiceQueryError) {
        jsonError(response, error.status, error.code, error.message)
        return
      }
      jsonError(response, 500, 'LOOKUP_FAILED', 'No se pudieron consultar los productos.')
    }
  })

  router.get('/catalog/mapping-memories', auth, async (request: Request, response: Response) => {
    try {
      const locationId = typeof request.query.locationId === 'string' ? request.query.locationId : ''
      const issuerTaxId = typeof request.query.issuerTaxId === 'string' ? request.query.issuerTaxId : null
      const data = await mapping.listCatalogMappingMemories({
        userClient: (request as AuthenticatedRequest).supabase,
        locationId,
        issuerTaxId,
      })
      response.json({ data })
    } catch (error) {
      if (error instanceof InvoiceQueryError) {
        jsonError(response, error.status, error.code, error.message)
        return
      }
      jsonError(response, 500, 'LOOKUP_FAILED', 'No se pudieron consultar las vinculaciones anteriores.')
    }
  })

  router.get('/duplicates', auth, async (request: Request, response: Response) => {
    try {
      const q = request.query
      const data = await query.lookupDuplicateInvoice({
        userClient: (request as AuthenticatedRequest).supabase,
        locationId: typeof q.locationId === 'string' ? q.locationId : '',
        fileSha256: typeof q.fileSha256 === 'string' ? q.fileSha256 : null,
        issuerTaxId: typeof q.issuerTaxId === 'string' ? q.issuerTaxId : null,
        voucherType: typeof q.voucherType === 'string' ? q.voucherType : null,
        pointOfSale: typeof q.pointOfSale === 'string' ? q.pointOfSale : null,
        voucherNumber: typeof q.voucherNumber === 'string' ? q.voucherNumber : null,
      })
      response.json({ data })
    } catch (error) {
      if (error instanceof InvoiceQueryError) {
        jsonError(response, error.status, error.code, error.message)
        return
      }
      jsonError(response, 500, 'LOOKUP_FAILED', 'No se pudieron consultar las facturas.')
    }
  })

  router.get('/pending-receptions', auth, async (request: Request, response: Response) => {
    try {
      const q = request.query
      const page = await query.listPendingReceptions({
        userClient: (request as AuthenticatedRequest).supabase,
        locationId: typeof q.locationId === 'string' ? q.locationId : '',
        cursor: typeof q.cursor === 'string' ? q.cursor : null,
        limit: typeof q.limit === 'string' ? q.limit : undefined,
      })
      response.json({ data: page.items, nextCursor: page.nextCursor })
    } catch (error) {
      if (error instanceof InvoiceQueryError) {
        jsonError(response, error.status, error.code, error.message)
        return
      }
      jsonError(response, 500, 'LOOKUP_FAILED', 'No se pudieron consultar las recepciones pendientes.')
    }
  })

  router.get('/', auth, async (request: Request, response: Response) => {
    try {
      const q = request.query
      const data = await query.listSavedInvoices({
        userClient: (request as AuthenticatedRequest).supabase,
        locationId: typeof q.locationId === 'string' ? q.locationId : '',
      })
      response.json({ data })
    } catch (error) {
      if (error instanceof InvoiceQueryError) {
        jsonError(response, error.status, error.code, error.message)
        return
      }
      jsonError(response, 500, 'LOOKUP_FAILED', 'No se pudieron consultar las facturas.')
    }
  })

  router.get('/:id/products', auth, async (request: Request, response: Response) => {
    try {
      const search = typeof request.query.q === 'string' ? request.query.q : undefined
      const data = await mapping.listInvoiceProducts({
        userClient: (request as AuthenticatedRequest).supabase,
        documentId: String(request.params.id ?? ''),
        search,
      })
      response.json({ data })
    } catch (error) {
      if (error instanceof InvoiceQueryError) {
        jsonError(response, error.status, error.code, error.message)
        return
      }
      jsonError(response, 500, 'LOOKUP_FAILED', 'No se pudieron consultar los productos.')
    }
  })

  router.post('/:id/lines/:lineId/map', auth, async (request: Request, response: Response) => {
    const authenticated = request as AuthenticatedRequest
    const userId = authenticated.user?.id
    if (!userId) {
      jsonError(response, 401, 'UNAUTHENTICATED', 'No autenticado.')
      return
    }
    const admin = resolveAdmin()
    if (!admin) {
      jsonError(response, 503, 'SERVICE_ROLE_MISSING', 'Falta la clave de servicio para vincular.')
      return
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    const rawFactor = body.conversionFactor
    const conversionFactor = typeof rawFactor === 'number'
      ? rawFactor
      : typeof rawFactor === 'string' && rawFactor.trim()
        ? Number(rawFactor.replace(',', '.'))
        : null
    try {
      const data = await mapping.mapInvoiceLine({
        userClient: authenticated.supabase,
        adminClient: admin,
        userId,
        documentId: String(request.params.id ?? ''),
        lineId: String(request.params.lineId ?? ''),
        inventoryProductId: typeof body.inventoryProductId === 'string' ? body.inventoryProductId : '',
        conversionFactor: conversionFactor != null && Number.isFinite(conversionFactor) ? conversionFactor : null,
      })
      response.json({ data })
    } catch (error) {
      if (error instanceof InvoiceQueryError) {
        jsonError(response, error.status, error.code, error.message)
        return
      }
      jsonError(response, 500, 'MAP_FAILED', 'No se pudo vincular el producto.')
    }
  })

  router.post('/:id/cancel', auth, async (request: Request, response: Response) => {
    const authenticated = request as AuthenticatedRequest
    const userId = authenticated.user?.id
    if (!userId) {
      jsonError(response, 401, 'UNAUTHENTICATED', 'No autenticado.')
      return
    }
    const admin = resolveAdmin()
    if (!admin) {
      jsonError(response, 503, 'SERVICE_ROLE_MISSING', 'Falta la clave de servicio para anular facturas.')
      return
    }
    try {
      const data = await cancel.cancelPurchaseInvoice({
        userClient: authenticated.supabase,
        adminClient: admin,
        userId,
        documentId: String(request.params.id ?? ''),
      })
      response.json({ data })
    } catch (error) {
      if (error instanceof InvoiceQueryError) {
        jsonError(response, error.status, error.code, error.message)
        return
      }
      jsonError(response, 500, 'CANCEL_FAILED', 'No se pudo anular la factura.')
    }
  })

  router.delete('/:id', auth, async (request: Request, response: Response) => {
    const authenticated = request as AuthenticatedRequest
    const userId = authenticated.user?.id
    if (!userId) {
      jsonError(response, 401, 'UNAUTHENTICATED', 'No autenticado.')
      return
    }
    const admin = resolveAdmin()
    if (!admin) {
      jsonError(response, 503, 'SERVICE_ROLE_MISSING', 'Falta la clave de servicio para eliminar facturas.')
      return
    }
    try {
      const data = await deleteInvoice.deletePurchaseInvoice({
        userClient: authenticated.supabase,
        adminClient: admin,
        userId,
        documentId: String(request.params.id ?? ''),
      })
      response.json({ data })
    } catch (error) {
      if (error instanceof InvoiceQueryError) {
        jsonError(response, error.status, error.code, error.message)
        return
      }
      jsonError(response, 500, 'DELETE_FAILED', 'No se pudo eliminar la factura.')
    }
  })

  router.post('/:id/confirm-intake', auth, async (request: Request, response: Response) => {
    const authenticated = request as AuthenticatedRequest
    const userId = authenticated.user?.id
    if (!userId) {
      jsonError(response, 401, 'UNAUTHENTICATED', 'No autenticado.')
      return
    }
    const admin = resolveAdmin()
    if (!admin) {
      jsonError(response, 503, 'SERVICE_ROLE_MISSING', 'Falta la clave de servicio para confirmar la recepción.')
      return
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    const rawLines = Array.isArray(body.lines) ? body.lines : []
    try {
      const data = await confirmIntake.confirmPurchaseInvoiceIntake({
        userClient: authenticated.supabase,
        adminClient: admin,
        userId,
        documentId: String(request.params.id ?? ''),
        organizationId: typeof body.organizationId === 'string' ? body.organizationId : '',
        locationId: typeof body.locationId === 'string' ? body.locationId : '',
        confirmIdempotencyKey: typeof body.confirmIdempotencyKey === 'string'
          ? body.confirmIdempotencyKey
          : '',
        intentStore: createSupabaseConfirmIntentStore(admin),
        lines: rawLines.map((item) => {
          const row = item && typeof item === 'object' && !Array.isArray(item)
            ? item as Record<string, unknown>
            : {}
          const createRaw = row.create && typeof row.create === 'object' && !Array.isArray(row.create)
            ? row.create as Record<string, unknown>
            : null
          return {
            purchaseDocumentLineId: typeof row.purchaseDocumentLineId === 'string'
              ? row.purchaseDocumentLineId
              : '',
            action: typeof row.action === 'string'
              ? row.action as ConfirmIntakeLineInput['action']
              : 'pending',
            inventoryProductId: typeof row.inventoryProductId === 'string' ? row.inventoryProductId : null,
            create: createRaw
              ? {
                name: typeof createRaw.name === 'string' ? createRaw.name : '',
                baseUnit: typeof createRaw.baseUnit === 'string' ? createRaw.baseUnit : '',
                category: typeof createRaw.category === 'string' ? createRaw.category : null,
                minimumStock: typeof createRaw.minimumStock === 'number' ? createRaw.minimumStock : null,
              }
              : null,
            conversionFactor: typeof row.conversionFactor === 'number' ? row.conversionFactor : null,
            receiveQuantity: typeof row.receiveQuantity === 'number' ? row.receiveQuantity : null,
            receiveIdempotencyKey: typeof row.receiveIdempotencyKey === 'string'
              ? row.receiveIdempotencyKey
              : null,
          }
        }),
      })
      response.json({ data })
    } catch (error) {
      if (error instanceof InvoiceQueryError) {
        jsonError(response, error.status, error.code, error.message)
        return
      }
      jsonError(response, 500, 'CONFIRM_FAILED', 'No se pudo confirmar la recepción.')
    }
  })

  router.get('/:id/confirm-recovery', auth, async (request: Request, response: Response) => {
    const authenticated = request as AuthenticatedRequest
    const userId = authenticated.user?.id
    if (!userId) {
      jsonError(response, 401, 'UNAUTHENTICATED', 'No autenticado.')
      return
    }
    const admin = resolveAdmin()
    if (!admin) {
      jsonError(response, 503, 'SERVICE_ROLE_MISSING', 'Falta la clave de servicio para consultar el guardado.')
      return
    }
    try {
      const data = await inspectConfirmRecovery({
        userClient: authenticated.supabase,
        adminClient: admin,
        documentId: String(request.params.id ?? ''),
        organizationId: typeof request.query.organizationId === 'string' ? request.query.organizationId : '',
        locationId: typeof request.query.locationId === 'string' ? request.query.locationId : '',
      })
      response.json({ data })
    } catch (error) {
      if (error instanceof InvoiceQueryError) {
        jsonError(response, error.status, error.code, error.message)
        return
      }
      jsonError(response, 500, 'LOOKUP_FAILED', 'No se pudo consultar el guardado.')
    }
  })

  router.post('/:id/complete-save', auth, async (request: Request, response: Response) => {
    const authenticated = request as AuthenticatedRequest
    const userId = authenticated.user?.id
    if (!userId) {
      jsonError(response, 401, 'UNAUTHENTICATED', 'No autenticado.')
      return
    }
    const admin = resolveAdmin()
    if (!admin) {
      jsonError(response, 503, 'SERVICE_ROLE_MISSING', 'Falta la clave de servicio para completar el guardado.')
      return
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    try {
      const data = await completeSavedInvoice({
        userClient: authenticated.supabase,
        adminClient: admin,
        userId,
        documentId: String(request.params.id ?? ''),
        organizationId: typeof body.organizationId === 'string' ? body.organizationId : '',
        locationId: typeof body.locationId === 'string' ? body.locationId : '',
      })
      response.json({ data })
    } catch (error) {
      if (error instanceof InvoiceQueryError) {
        jsonError(response, error.status, error.code, error.message)
        return
      }
      jsonError(response, 500, 'CONFIRM_FAILED', 'No se pudo completar el guardado.')
    }
  })

  router.post('/:id/lines/:lineId/receive', auth, async (request: Request, response: Response) => {
    const authenticated = request as AuthenticatedRequest
    const userId = authenticated.user?.id
    if (!userId) {
      jsonError(response, 401, 'UNAUTHENTICATED', 'No autenticado.')
      return
    }
    const admin = resolveAdmin()
    if (!admin) {
      jsonError(response, 503, 'SERVICE_ROLE_MISSING', 'Falta la clave de servicio para recibir mercadería.')
      return
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    try {
      const data = await receive.receiveInvoiceLine({
        userClient: authenticated.supabase,
        adminClient: admin,
        userId,
        documentId: String(request.params.id ?? ''),
        lineId: String(request.params.lineId ?? ''),
        quantity: body.quantity,
        idempotencyKey: body.idempotencyKey,
      })
      response.json({ data })
    } catch (error) {
      if (error instanceof InvoiceQueryError) {
        jsonError(response, error.status, error.code, error.message)
        return
      }
      jsonError(response, 500, 'RECEIVE_FAILED', 'No se pudo registrar la recepción.')
    }
  })

  router.post(
    '/analysis-jobs',
    auth,
    rateLimit,
    handleUpload(analysisJobUpload),
    async (request: Request, response: Response) => {
      const authenticated = request as AuthenticatedRequest
      const body = request.body as Record<string, unknown>
      try {
        const created = await createInvoiceAnalysisJob({
          userId: authenticated.user?.id,
          userClient: authenticated.supabase,
          locationId: typeof body.locationId === 'string' ? body.locationId : '',
          file: request.file,
          maxFileBytes,
          store: analysisJobStore,
        })
        let status = created.job.status
        let callbackToken = created.callbackToken
        let expiresAt = created.job.callbackTokenExpiresAt
        let alreadyClaimed = false
        const reusedExistingJob = !callbackToken
        if (!callbackToken && created.job.status === 'queued' && created.job.delivery === 'not_sent') {
          const resumed = await analysisJobStore.resumeUnsentDispatch(created.job.id)
          if (resumed) {
            callbackToken = resumed.token
            expiresAt = resumed.job.callbackTokenExpiresAt
            status = resumed.job.status
            alreadyClaimed = true
          }
        }
        if (callbackToken) {
          dependencies.onAnalysisCallbackToken?.({
            jobId: created.job.id,
            callbackToken,
            expiresAt,
          })
          try {
            const dispatched = await dispatchInvoiceAnalysisJob({
              store: analysisJobStore,
              jobId: created.job.id,
              callbackToken,
              webhook: n8nWebhook,
              alreadyClaimed,
            })
            if (dispatched.job) status = dispatched.job.status
          } catch (error) {
            console.error(JSON.stringify({
              operation: 'n8n_invoice_dispatch',
              code: 'DISPATCH_FAILED',
              error: dispatchFailureName(error),
            }))
          }
        }
        response.status(202).json({
          data: {
            jobId: created.job.id,
            status,
            ...(reusedExistingJob && !alreadyClaimed ? { reused: true } : {}),
          },
        })
      } catch (error) {
        if (error instanceof InvoiceAnalysisJobError) {
          jsonError(response, error.status, error.code, error.message)
          return
        }
        if (error instanceof InvoiceUploadError) {
          const status = error.code === 'TOO_LARGE'
            ? 413
            : error.code === 'UNSUPPORTED_TYPE' || error.code === 'INVALID_SIGNATURE'
              ? 422
              : 400
          jsonError(response, status, error.code, error.message)
          return
        }
        jsonError(response, 500, 'JOB_CREATE_FAILED', 'No se pudo crear el trabajo de análisis.')
      }
    },
  )

  router.get('/analysis-jobs/:id', auth, async (request: Request, response: Response) => {
    const authenticated = request as AuthenticatedRequest
    try {
      const data = await readInvoiceAnalysisJob({
        userId: authenticated.user?.id,
        userClient: authenticated.supabase,
        jobId: String(request.params.id ?? ''),
        store: analysisJobStore,
      })
      response.json({ data })
    } catch (error) {
      if (error instanceof InvoiceAnalysisJobError) {
        jsonError(response, error.status, error.code, error.message)
        return
      }
      jsonError(response, 500, 'JOB_LOOKUP_FAILED', 'No se pudo consultar el trabajo de análisis.')
    }
  })

  router.post('/analysis-jobs/:id/result', async (request: Request, response: Response) => {
    const integrity = dependencies.integrity === undefined
      ? integrityConfigFromEnv()
      : dependencies.integrity
    try {
      const data = await submitInvoiceAnalysisResult({
        jobId: String(request.params.id ?? ''),
        authorizationHeader: request.header('authorization'),
        body: request.body,
        store: analysisJobStore,
        integrity,
      })
      response.json({ data })
    } catch (error) {
      if (error instanceof InvoiceAnalysisJobError) {
        jsonError(response, error.status, error.code, error.message)
        return
      }
      jsonError(response, 500, 'RESULT_FAILED', 'No se pudo registrar el resultado del análisis.')
    }
  })

  router.get('/:id/file', auth, async (request: Request, response: Response) => {
    try {
      const data = await query.getSavedInvoiceFile({
        userClient: (request as AuthenticatedRequest).supabase,
        adminClient: resolveAdmin(),
        id: String(request.params.id ?? ''),
      })
      response.json({ data })
    } catch (error) {
      if (error instanceof InvoiceQueryError) {
        jsonError(response, error.status, error.code, error.message)
        return
      }
      jsonError(response, 500, 'SIGNED_URL_FAILED', 'No se pudo generar el enlace al documento original.')
    }
  })

  router.get('/:id', auth, async (request: Request, response: Response) => {
    try {
      const data = await query.getSavedInvoice({
        userClient: (request as AuthenticatedRequest).supabase,
        adminClient: resolveAdmin(),
        id: String(request.params.id ?? ''),
      })
      response.json({ data })
    } catch (error) {
      if (error instanceof InvoiceQueryError) {
        jsonError(response, error.status, error.code, error.message)
        return
      }
      jsonError(response, 500, 'LOOKUP_FAILED', 'No se pudieron consultar las facturas.')
    }
  })

  router.post('/validate-extraction', auth, rateLimit, (request: Request, response: Response) => {
    try {
      const data = validateExtractedInvoice(request.body)
      response.json({ data })
    } catch (error) {
      if (error instanceof ExtractionPayloadError) {
        jsonError(response, error.status, error.code, error.message)
        return
      }
      if (error instanceof TypeError) {
        jsonError(response, 422, 'INVALID_EXTRACTION', error.message)
        return
      }
      jsonError(response, 500, 'VALIDATION_FAILED', 'No se pudo validar la extracción.')
    }
  })

  router.post(
    '/analyze',
    auth,
    async (request, response, next) => {
      try {
        const { supabase } = request as AuthenticatedRequest
        const organizations = await repository.listOrganizations(supabase)
        if (organizations.length === 0) {
          jsonError(response, 403, 'FORBIDDEN', 'No autorizado.')
          return
        }
        next()
      } catch {
        jsonError(response, 500, 'MEMBERSHIP_CHECK_FAILED', 'No se pudo verificar la membresía.')
      }
    },
    rateLimit,
    handleUpload(analyzeUpload),
    async (request: Request, response: Response) => {
      const file = request.file
      if (!file) {
        jsonError(response, 400, 'FILE_REQUIRED', 'Adjuntá un único PDF o imagen en el campo file.')
        return
      }

      let input
      try {
        input = inspectInvoiceBuffer(file.buffer, {
          filename: file.originalname,
          declaredMimeType: file.mimetype,
          maxBytes: maxFileBytes,
        })
      } catch (error) {
        if (error instanceof InvoiceUploadError) {
          const status = error.code === 'TOO_LARGE'
            ? 413
            : error.code === 'UNSUPPORTED_TYPE' || error.code === 'INVALID_SIGNATURE'
              ? 422
              : 400
          jsonError(response, status, error.code, error.message)
          return
        }
        jsonError(response, 400, 'INVALID_UPLOAD', 'No se pudo validar el archivo.')
        return
      }

      let provider: InvoiceAiProvider
      try {
        provider = dependencies.provider ?? createGeminiInvoiceProviderFromEnv()
      } catch (error) {
        if (error instanceof InvoiceAiProviderError) {
          logAnalyzeProviderError('provider_init', error)
          mapProviderError(response, error)
          return
        }
        jsonError(response, 503, 'PROVIDER_NOT_CONFIGURED', 'El análisis de facturas no está configurado.')
        return
      }

      try {
        const result = await createInvoiceReader(provider).analyze(input)
        const fileSha256 = sha256Hex(file.buffer)
        const unsigned = toInvoiceAnalysisApiResult(result, { fileSha256 })
        const integrity = dependencies.integrity === undefined
          ? integrityConfigFromEnv()
          : dependencies.integrity
        if (!integrity?.secret) {
          response.json({ data: unsigned })
          return
        }
        const userId = (request as AuthenticatedRequest).user?.id
        if (!userId) {
          jsonError(response, 401, 'UNAUTHENTICATED', 'No autenticado.')
          return
        }
        const signed = issueInvoiceIntegrityToken({
          userId,
          fileSha256,
          snapshot: unsigned,
          secret: integrity.secret,
          ttlSeconds: integrity.ttlSeconds,
          now: integrity.now?.(),
        })
        response.json({
          data: toInvoiceAnalysisApiResult(result, {
            fileSha256,
            integrity: {
              token: signed.token,
              snapshotSha256: signed.snapshotSha256,
              expiresAt: signed.expiresAt,
            },
          }),
        })
      } catch (error) {
        if (isTimeoutError(error)) {
          jsonError(response, 504, 'PROVIDER_TIMEOUT', 'El análisis de la factura superó el tiempo de espera.')
          return
        }
        if (error instanceof InvoiceAiProviderError) {
          logAnalyzeProviderError('extract', error)
          mapProviderError(response, error)
          return
        }
        console.error(JSON.stringify({
          operation: 'invoice_analyze',
          stage: 'extract',
          code: 'ANALYSIS_FAILED',
          errorName: error instanceof Error ? error.name : 'unknown',
        }))
        jsonError(response, 500, 'ANALYSIS_FAILED', 'No se pudo analizar la factura.')
      }
    },
  )

  router.post(
    '/',
    auth,
    rateLimit,
    handleUpload(saveUpload),
    async (request: Request, response: Response) => {
      const authenticated = request as AuthenticatedRequest
      const userId = authenticated.user?.id
      if (!userId) {
        jsonError(response, 401, 'UNAUTHENTICATED', 'No autenticado.')
        return
      }
      const file = request.file
      if (!file) {
        jsonError(response, 400, 'FILE_REQUIRED', 'Adjuntá un único PDF o imagen en el campo file.')
        return
      }

      const integrity = dependencies.integrity === undefined
        ? integrityConfigFromEnv()
        : dependencies.integrity
      if (!integrity?.secret) {
        jsonError(response, 503, 'SECRET_MISSING', 'Falta la clave de integridad para persistir.')
        return
      }
      if (!dependencies.getAdmin && !isSupabaseAdminConfigured()) {
        jsonError(response, 503, 'SERVICE_ROLE_MISSING', 'Falta la clave de servicio para persistir.')
        return
      }

      const body = request.body as Record<string, unknown>
      let confirmIntent: unknown
      if (body.confirmIntent != null && body.confirmIntent !== '') {
        try {
          confirmIntent = typeof body.confirmIntent === 'string'
            ? JSON.parse(body.confirmIntent)
            : body.confirmIntent
        } catch {
          jsonError(response, 400, 'INVALID_JSON', 'El plan de confirmación no es JSON válido.')
          return
        }
      }
      try {
        const data = await savePurchaseInvoice({
          userId,
          locationId: typeof body.locationId === 'string' ? body.locationId : '',
          fileBytes: file.buffer,
          filename: file.originalname,
          mimeType: file.mimetype,
          integrityToken: typeof body.integrityToken === 'string' ? body.integrityToken : null,
          originalSnapshot: body.originalSnapshot,
          corrections: body.corrections,
          commercialDecisions: body.commercialDecisions,
          acceptFiscalInconsistency: body.acceptFiscalInconsistency,
          confirmIntent: confirmIntent && typeof confirmIntent === 'object'
            ? confirmIntent as {
              confirmIdempotencyKey: string
              lines: Array<{
                sourceLineId: string
                action: string
                inventoryProductId?: string | null
                create?: {
                  name: string
                  baseUnit: string
                  category?: string | null
                  minimumStock?: number | null
                } | null
                conversionFactor?: number | null
                receiveQuantity?: number | null
                receiveIdempotencyKey?: string | null
              }>
            }
            : null,
          secret: integrity.secret,
          now: dependencies.saveNow?.() ?? integrity.now?.(),
          deps: {
            userClient: authenticated.supabase,
            adminClient: (dependencies.getAdmin ?? getSupabaseAdmin)(),
          },
        })
        response.json({ data })
      } catch (error) {
        if (error instanceof InvoiceSaveError) {
          jsonError(response, error.status, error.code, error.message)
          return
        }
        console.error(JSON.stringify({
          operation: 'senda_save_purchase_invoice',
          code: 'UNHANDLED',
          message: error instanceof Error ? error.name : 'unknown',
          details: null,
          hint: null,
        }))
        jsonError(response, 500, 'SAVE_FAILED', 'No se pudo guardar la factura.')
      }
    },
  )

  return router
}
