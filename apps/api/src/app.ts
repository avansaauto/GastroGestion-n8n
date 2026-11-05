import cors from 'cors'
import express, { type RequestHandler } from 'express'
import helmet from 'helmet'
import morgan from 'morgan'
import { corsAllowedOrigins } from './http/runtimeConfig.js'
import { isSupabaseConfigured } from './lib/supabase.js'
import type { InvoiceAiProvider } from './modules/invoice-intelligence/index.js'
import { createFudoCatalogRouter } from './routes/fudoCatalog.js'
import { createInvoicesRouter, type InvoiceRouterDependencies } from './routes/invoices.js'
import { createOperationsRouter } from './routes/operations.js'
import type { OperationsRepository } from './services/operationsRepository.js'

export type AppDependencies = {
  operationsAuth?: RequestHandler
  operationsRepository?: OperationsRepository
  invoices?: InvoiceRouterDependencies
  invoiceProvider?: InvoiceAiProvider
}

export function createApp(dependencies: AppDependencies = {}) {
  const app = express()
  const allowedOrigins = corsAllowedOrigins()

  app.use(helmet())
  app.use(cors({ origin: allowedOrigins }))
  app.use(morgan('dev'))
  app.use(express.json({ limit: '1mb' }))

  app.get('/api/health', (_request, response) => {
    response.json({
      status: 'ok',
      service: 'senda-ops-api',
      supabase: isSupabaseConfigured() ? 'configured' : 'pending',
    })
  })

  app.use('/api', createFudoCatalogRouter())
  app.use('/api/invoices', createInvoicesRouter({
    ...dependencies.invoices,
    provider: dependencies.invoiceProvider ?? dependencies.invoices?.provider,
  }))
  app.use(
    '/api',
    createOperationsRouter(dependencies.operationsAuth, dependencies.operationsRepository),
  )

  app.use('/api', (_request, response) => {
    response.status(404).json({ error: 'Endpoint no disponible.' })
  })

  return app
}
