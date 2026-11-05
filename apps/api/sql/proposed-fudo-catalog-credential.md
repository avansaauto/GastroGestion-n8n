# Credencial de sync de catálogo Fudo

No ejecutar la migración ni insertar credenciales hasta autorización explícita.

## 1. Aplicar SQL

`apps/api/sql/proposed-fudo-product-catalog.sql` en el SQL Editor de Supabase.

Verificar con `apps/api/sql/verify-fudo-product-catalog.sql`.

## 2. Pepper

En el servidor de la API (nunca en el frontend ni en n8n como service_role):

```
INTEGRATION_AUTH_PEPPER=<secreto largo aleatorio>
```

## 3. Crear credencial por sucursal

Generar UUID + secreto (43–128 chars `[A-Za-z0-9_-]`).

El hash se calcula en el backend:

```
HMAC-SHA256(INTEGRATION_AUTH_PEPPER, secret) → hex de 64
```

Insertar (service_role / SQL Editor), una fila por sucursal:

```sql
insert into public.integration_credentials (
  id, secret_hash, organization_id, location_id, scopes, status, label
) values (
  '<uuid>',
  '<hmac hex>',
  '<organization_id>',
  '<location_id>',
  array['fudo.catalog.sync'],
  'active',
  'n8n catálogo Fudo'
);
```

No hardcodear OGHAM: cada local tiene su propia credencial.

## 4. n8n

Header:

```
Authorization: Bearer snd_<uuid>.<secret>
```

No enviar `organization_id` ni `location_id`. El destino sale de la credencial.
