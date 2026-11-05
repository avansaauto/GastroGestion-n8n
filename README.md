# SENDA OPS

Base independiente para la plataforma de automatización de operaciones gastronómicas.

## Requisitos

- Node.js 20+
- npm

## Inicio local

```bash
npm install
npm run dev
```

- Frontend: http://localhost:5173
- API: http://localhost:3001
- Health check: http://localhost:3001/api/health

Sin variables de Supabase, el frontend funciona en modo vista previa y no realiza consultas ni escrituras.

## Variables de entorno

```bash
cp apps/web/.env.example apps/web/.env
cp apps/api/.env.example apps/api/.env
```

No se deben usar claves `service_role` en `apps/web`. Las lecturas autenticadas de organizaciones,
locales y productos pendientes usan la anon key más el JWT del usuario y respetan RLS. La clave
administrativa no es necesaria para estos endpoints.

Endpoints autenticados:

- `GET /api/organizations`
- `GET /api/organizations/:organizationId/locations`
- `GET /api/locations/:locationId/pending-products?status=pending`

## Documentación

- [Persistencia de facturas de inventario](docs/invoice-persistence.md) — propuesta. No ejecutar SQL.
- Migración definitiva de facturas (**no ejecutar todavía**): `apps/api/sql/migrate-invoice-persistence.sql`
- Verificación de facturas (solo lectura): `apps/api/sql/verify-invoice-persistence.sql`
- Migración definitiva de recepción (**no ejecutar todavía**): `apps/api/sql/migrate-inventory-reception.sql`
- Verificación de recepción (solo lectura): `apps/api/sql/verify-inventory-reception.sql`

## Validación

```bash
npm run typecheck
npm run build
npm test
```
