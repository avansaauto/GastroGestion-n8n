# Lector inteligente de facturas

Núcleo backend sin endpoints ni persistencia. No consulta Supabase, inventario o n8n.

## Configuración local

Crear o completar `apps/api/.env`:

```dotenv
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.5-flash-lite
GEMINI_FALLBACK_MODEL=gemini-3.8-flash
```

`GEMINI_API_KEY` debe contener una clave propia del proyecto. No se debe agregar `.env` a Git.

## Analizar un archivo local

Desde `apps/api`:

```bash
npm run invoice:analyze -- /ruta/absoluta/factura.pdf
```

Para guardar el resultado normalizado:

```bash
npm run invoice:analyze -- /ruta/absoluta/factura.pdf --save
```

La salida opcional se escribe con permisos de usuario en
`apps/api/.local/invoice-analysis/`, una carpeta ignorada por Git. El documento
original no se copia ni se guarda.

Formatos permitidos: PDF, JPG, JPEG, PNG y WebP. Máximo: 10 MB.

El resumen de consola no imprime el contenido base64, la respuesta cruda ni la API key.
El resultado debe compararse manualmente con el comprobante original.
