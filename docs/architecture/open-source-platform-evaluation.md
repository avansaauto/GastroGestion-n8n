# Evaluación de plataforma open source para SENDA OPS

Fecha: 31 de octubre de 2026.  
Alcance: decisión de arquitectura. No se modificó API, base, interfaz, RPC ni n8n. No se ejecutó la prueba de ERPNext ni se conectó ningún candidato a Supabase.

La recomendación es una sola. SENDA se termina más rápido si el motor operativo sigue siendo la aplicación React/Node y Supabase, y los proyectos open source se usan como referencia o como librería. ERPNext no reemplaza ese motor. La prueba de concepto de la sección 6 existe para observar, en un entorno descartable, el punto que ya documenta ERPNext: anular una compra recalcula el costo de los movimientos posteriores. Ese comportamiento contradice el CPP que ya está instalado en SENDA.

## 1. Estado de SENDA actual

El repositorio real es el monorepo `senda-ops`, versión 0.1.0, con workspaces `apps/api` y `apps/web`. Node 18 o superior.

| Pieza | Qué es hoy |
|---|---|
| Web | React 18, Vite, React Router. Pantallas reales: inventario, facturas, recetas, login y elección de sucursal. |
| API | Express. `GET /api/health`, `/api/invoices` y `/api` de operaciones. |
| Datos | Supabase Postgres, proyecto SENDA. La lógica de stock y costo vive en funciones `SECURITY DEFINER`, no en el cliente. |
| Automatización | n8n despacha la lectura de facturas. Gemini es el proveedor de extracción. |
| Ventas | Fudo no entra por la API. n8n llama `register_sale_consumption`. SENDA guarda el vínculo receta–producto Fudo. |

La pantalla Resumen y la pantalla Integraciones siguen diciendo que Supabase, n8n y Fudo están pendientes. Eso es un texto de interfaz viejo. En operación, la base, la lectura de facturas y el consumo de ventas ya existen.

### Capacidades

Estados: **funcional** (usada o verificada en SENDA, con pruebas en el repo), **parcial**, **pendiente**, **reemplazable** (conviene sustituirla más adelante, sin tocar el motor).

| Capacidad | Estado | Evidencia en el repo y en SENDA |
|---|---|---|
| Login, organización y sucursal | Funcional | `LoginPage`, `LocationGatePage`, `organization_members`, `senda_actor_is_purchase_member`. En SENDA hay una organización y dos sucursales: Barrio Chino y SENDA - Pruebas. |
| Permisos de operador | Parcial | Las RPC exigen membresía. No hay pantalla de roles ni matriz de permisos. Configuración es un placeholder. |
| Factura: carga, lectura, revisión, vínculo y guardado | Funcional | Rutas de `/api/invoices`, módulo `invoice-intelligence`, webhook n8n, confirmación de una sola vez. |
| Recepción parcial y costo de compra | Funcional | `senda_receive_purchase_document_line`. El importe inventariable es el neto de la línea. El IVA no entra al costo. |
| CPP por sucursal e insumo | Funcional | `proposed-senda-cpp.sql` aplicado. `verify-senda-cpp.sql` terminó sin `CPP_VERIFY_FAILED`. El caso 10 kg / 8 kg / 10 kg da $13,66666667 por gramo, que es $13.666,67/kg y $2.733,33 cada 200 g en centavos. |
| Anulación de factura | Funcional, con límites conocidos | `senda_delete_purchase_invoice`. Si hay un consumo posterior, no anula y no reescribe ese consumo. Las 13 filas viejas de historial no tienen stock anterior: esas facturas no se anulan solas. |
| Stock, unidades g/ml/unidad, mínimo y ajuste | Funcional | Inventario en la web. Ajuste por `senda_adjust_inventory_quantity`. Una merma de hoy es un ajuste con motivo, no un documento propio. |
| Costo inicial de stock ya existente | Parcial | Si hay cantidad y el promedio es null, la recepción responde `UNVALUED_STOCK` y no escribe. La API todavía muestra el error genérico de recepción. El alta manual del costo sigue disponible. |
| Recetas y costo teórico | Funcional | Alta, edición, precio por sucursal y `estimateRecipeCost`, que multiplica `average_unit_cost`. No explotan solas una venta. |
| Fudo | Parcial | Vínculo de producto y categoría en RPC y en la ficha de receta. La explosión de la venta y el descuento de stock los hace n8n contra `register_sale_consumption`. La pantalla Ventas y consumos está vacía. |
| Proveedores, órdenes de compra, márgenes, alertas, KPI | Pendiente | El emisor de la factura es un texto. El mínimo de stock se guarda y no dispara avisos. No hay margen de venta. |
| Cola de lectura de facturas | Reemplazable | El despacho a n8n y el almacén de jobs de la API ya funcionan. Una cola en Redis puede sustituir esa pieza interna el día que vuelva a ser el cuello de botella. No sustituye a n8n. |

Lo que no se debe tirar es el tramo que ya diferencia a SENDA: factura argentina leída con IA, recepción en gramos o mililitros, CPP que no inventa costo ni reescribe ventas, y el contrato de consumo que usa Fudo.

## 2. Comparación de candidatos

Modos de uso, y solo esos:

- **Servicio:** proceso aparte, se habla por API. El código no entra al repo de SENDA.
- **Paquete:** librería que se instala en Node.
- **Extensión:** app propia dentro del framework del candidato.
- **Referencia:** se estudia el comportamiento. No se copia código.

Fuentes revisadas el 31 de octubre de 2026. No se copió código de ninguno.

### ERPNext / Frappe

- Licencia: ERPNext es GPL-3.0 (`license.txt` en `develop`). Frappe es MIT (`LICENSE` en `develop`).
- Uso comercial: se puede vender un servicio que llama a un ERPNext alojado aparte. GPL-3 obliga a entregar el código de la obra GPL a quien recibe el binario. No es AGPL: el uso solo por red no dispara esa entrega. Copiar archivos de ERPNext dentro de SENDA sí mezcla la obra GPL con el producto. Una app que importa código de ERPNext queda en esa zona. La forma limpia, si algún día hiciera falta, es servicio por REST, nunca un vendoring.
- Tecnología: Python, MariaDB, Redis, workers, sitio Frappe. Docker de evaluación oficial: `frappe/frappe_docker`, archivo `pwd.yml`, puerto 8080, usuario `Administrator`, clave `admin`. Ese compose es descartable y no admite apps propias.
- Módulos útiles: compras, recepciones, stock, almacenes, BOM, asientos, empresas.
- API: REST de documentos. El patrón vigente es `Authorization: token clave:secreto` y `/api/resource/<DocType>`.
- Multiempresa: una Company es una entidad legal con sus propios libros. Una sucursal del mismo restaurante es un almacén, un centro de costo o una dimensión, no otra Company. Documentado en Company.
- Compras e inventario: el promedio móvil oficial es el mismo álgebra que el CPP: `(cantidad × promedio + cantidad recibida × precio) / cantidad nueva`. Las salidas no mueven el promedio.
- Anulación: cancelar una recepción enviada invierte el ledger y llama a `repost_future_sle_and_gle`. La documentación de promedio móvil dice que una anulación o un comprobante retroactivo obliga a recalcular cantidad, tasa y valor de todos los Stock Ledger Entries posteriores, y también el mayor contable. Eso es lo contrario de la regla ya instalada en SENDA.
- Recetas: el BOM es de manufactura. Sirve para una lista de ingredientes y un costo, no para el flujo Fudo ni para una carta de restaurante.
- Argentina: Company tiene país y moneda. La lectura de facturas AFIP, el IVA fuera del costo y Fudo no están en el núcleo revisado.
- Mantenimiento: proyecto activo, con guía de valuación publicada y código de ledger en `develop`. Operarlo implica actualizaciones de bench o de imagen, backups de MariaDB y cuidado con las personalizaciones.
- Despliegue: alto. Segundo runtime, segunda base, segundos usuarios, segundas copias de seguridad.
- Modo que corresponde: referencia, más la prueba de la sección 6. No servicio de producción y no extensión.

### InvenTree

- Licencia: MIT. Se puede usar y vender, conservando el aviso de copyright. No se copia el proyecto entero al repo; si se usara, sería servicio.
- Tecnología: Django, API REST propia (`/api/` y esquema en la instalación), plugins.
- Módulos: partes, stock por lote, órdenes de compra, BOM, precios de proveedor e historial de compras. El precio de una parte es un rango cacheado (mínimo y máximo de varias fuentes), no un CPP único por sucursal que se actualiza en la recepción y queda quieto en la venta.
- Multiempresa: hay compañía interna que recibe la orden. No es el par organización/sucursal de un grupo gastronómico con RLS.
- Anulación y auditoría: el stock es trazable por ítem y orden. No implementa la regla “si hay un consumo posterior, la compra no se anula y el costo de ese consumo no se toca”.
- Argentina y Fudo: no.
- Despliegue: medio. Otra aplicación Django al lado de Supabase, con el stock partido.
- Modo: referencia para permisos de precio y BOM. No motor.

### Grocy

- Licencia: MIT, copyright 2017-2026 en `LICENSE.md`.
- Tecnología: PHP. Una instancia, SQLite o base compatible. API REST; la interfaz web usa esa misma API. Hay demo pública y Swagger en `/api`.
- Módulos que sí son de cocina: recetas, “¿alcanza el stock?”, consumo de la receta, lista de compras, vencimientos, ubicaciones y usuarios.
- Multiempresa: no. Está pensado para una despensa o una cocina.
- CPP, facturas AFIP, anulación con historial de costo, Fudo: no.
- Despliegue: bajo, y aun así parte el stock si se lo pone en producción.
- Modo: referencia de interacción para consumo, merma y faltantes. No servicio.

### TastyIgniter

- Licencia: MIT en `LICENSE.md` de la rama 4.x. El nombre es marca registrada. El marketplace de temas y extensiones tiene licencias comerciales aparte: esas extensiones no se redistribuyen como si fueran MIT.
- Tecnología: Laravel. Pedidos online y reservas.
- Módulos: carta, pedido, local. No es un motor de inventario, CPP ni facturas de proveedor.
- Fudo ya cubre la venta del salón. Sumar otro frente de pedidos no acorta SENDA.
- Modo: fuera de alcance. No referencia para el motor operativo.

### Activepieces

- Licencia: núcleo MIT. El directorio `packages/ee` y el código enterprise del server tienen licencia comercial. Usarlos en producción exige suscripción. GitHub marca el repo como licencia distinta de un MIT puro.
- Tecnología: TypeScript, flujos, piezas publicadas en npm. Docker para self-host.
- Rol: automatización, el mismo lugar que ya ocupa n8n en la lectura de facturas y en el consumo Fudo.
- Modo: no reemplazar n8n. Cambiar de motor de flujos reescribe integraciones que ya están en producción.

### BullMQ

- Licencia: MIT (`taskforcesh/bullmq`, `LICENSE`). BullMQ Pro es otro paquete, de pago, y no hace falta.
- Tecnología: librería Node sobre Redis.
- Rol: cola de trabajos con reintentos. Encaja en la API el día que el despacho de facturas vuelva a perder trabajos. No modela stock, recetas ni empresas.
- Modo: paquete, más adelante, solo la edición MIT. Hoy no es el cuello de botella que hay que abrir.

## 3. Las dos arquitecturas

### A. React/Node delante y ERPNext como motor

SENDA conservaría la pantalla, Gemini y Fudo, y pasaría stock, compras y costo a ERPNext.

Qué se gana: empresas, almacenes, ledger de stock, BOM, compras y contabilidad ya escritos, con una API madura.

Qué se paga:

- Migrar el stock vivo, las facturas y el CPP a MariaDB, y operar Frappe además de Supabase.
- Rehacer la recepción de facturas para que el neto en gramos entre como Purchase Receipt, sin IVA, con idempotencia y con `UNVALUED_STOCK`.
- Aceptar el recálculo de costos históricos, o pelear contra él en cada anulación. La documentación oficial dice que ese recálculo es el comportamiento del promedio móvil.
- Seguir escribiendo Fudo, la lectura AFIP y la carta. Nada de eso viene en ERPNext.
- Dos sistemas de usuarios, dos backups y una superficie de API keys.
- Para vender el servicio alojado, ERPNext puede quedar como proceso separado. Para entregar una instalación al cliente, las modificaciones GPL se acompañan de su código. Meter ERPNext dentro del repositorio de SENDA cierra esa puerta.

Esfuerzo: alto, de meses, antes de volver al punto en el que SENDA ya está. Infraestructura: MariaDB, Redis, workers Python, más el Node y el Postgres actuales. Escalabilidad de ERPNext sobra para un grupo de sucursales; el límite real es el equipo que lo opera.

### B. React/Node/Supabase como motor, y open source solo donde ahorra código

SENDA conserva facturas, CPP, recetas y Fudo. Los candidatos se consultan para diseñar lo que falta. La única librería prevista es BullMQ MIT, y solo cuando la cola de facturas lo justifique.

Qué se gana: no se reescribe lo que ya pasó la verificación en SENDA. El próximo trabajo es de producto (mermas como acción clara, alertas de mínimo, margen) sobre tablas y RPC que ya existen.

Qué no se gana: contabilidad general, órdenes de compra, ni un ERP de fabricación. Esas piezas no están en el camino crítico de un grupo gastronómico que ya carga facturas y recetas.

Esfuerzo: el de completar pantallas y reglas chicas. Infraestructura: la actual. Supabase, la API, la web y n8n. Redis aparece recién con BullMQ. Seguridad: sigue el modelo ya usado, membresía en las RPC y service role fuera del navegador. Venta: el producto es SENDA, sin obligación de publicar el código por el hecho de alojarlo.

### Decisión

Se adopta B. A queda descartada como arquitectura de producción. ERPNext se prueba una vez, en Docker descartable, para dejar escrito el resultado de la anulación. Si esa prueba confirma el recálculo de movimientos posteriores, no se reabre la migración.

## 4. Matriz de acciones

El motor de todas las filas es SENDA, salvo la cola futura. “Trabajo imprescindible” es lo que falta para cerrar el módulo, no una integración nueva.

| Área | Acción del usuario | Automatización | Motor | Entrada → salida | Estado SENDA | Open source | Trabajo imprescindible |
|---|---|---|---|---|---|---|---|
| Compras | Cargar la factura del proveedor | n8n + Gemini leen el PDF | SENDA | Archivo → factura en revisión | Funcional | Ninguno como motor. ERPNext Purchase Receipt es referencia de comprobante, no destino | Maestro de proveedores cuando haga falta buscar el emisor. Hoy el emisor es texto de la factura |
| Facturas | Revisar, vincular, guardar, anular | Confirmación única y RPC de baja | SENDA | Líneas revisadas → documento y, si se recibe, stock | Funcional | No | Mapear `UNVALUED_STOCK` a un mensaje claro en la API, en un cambio posterior y acotado |
| Stock | Recibir una línea | Recepción parcial con el neto | SENDA | Cantidad e importe → movimiento, saldo y CPP | Funcional | Fórmula publicada de ERPNext, ya equivalente | No recibir en SENDA real como prueba. Los siete insumos activos de Barrio Chino ya tienen saldo y costo |
| Ajustes | Corregir el saldo | `senda_adjust_inventory_quantity` | SENDA | Delta y motivo → saldo. El CPP no se mueve | Funcional | Referencia: Stock Reconciliation de ERPNext, sin adoptarla | Dejar el ajuste como corrección. No usarlo para disfrazar una compra |
| Mermas | Registrar una pérdida | El mismo ajuste, con motivo de merma | SENDA | Cantidad negativa → saldo. El costo histórico no se reescribe | Parcial | Grocy, solo como referencia de la acción “consumir / tirar” | Una acción de merma en inventario, encima del ajuste que ya existe. Sin módulo nuevo |
| CPP | Ver el costo del insumo | Promedio en la recepción. La venta no lo cambia | SENDA | Recepciones → `average_unit_cost` | Funcional en SENDA | ERPNext Moving Average, como contraste de anulación | Aceptar los promedios actuales como apertura. No reconstruir historia. No meter IVA en esta etapa |
| Recetas | Armar la ficha y ver el costo | `estimateRecipeCost` | SENDA | Ingredientes y promedio → costo de la línea | Funcional | Grocy para la interacción de consumo. BOM de ERPNext como lista de materiales, no como app | Conectar la venta Fudo a la receta ya vinculada, sin mudar las recetas |
| Ventas | Ver qué venta consumió qué | n8n llama `register_sale_consumption` | SENDA + n8n | Venta Fudo → movimiento negativo | Parcial | TastyIgniter no aplica: Fudo es el frente de venta | Pantalla de ventas y consumos sobre los movimientos que ya se escriben |
| Márgenes | Comparar precio de venta y costo | Ninguna | SENDA | Precio por sucursal y CPP → margen | Pendiente | InvenTree separa precio de venta y costo. Sirve de modelo de datos, no de servicio | Calcular el margen en la ficha que ya tiene precio y costo. Sin ERP |
| Alertas | Enterarse de un mínimo | Ninguna | SENDA | `minimum_stock` y saldo → aviso | Pendiente | Grocy y su lista de faltantes, como referencia | Aviso dentro de inventario cuando el saldo cruza el mínimo ya guardado |
| Integraciones | Operar Fudo, n8n y Gemini | Flujos actuales | n8n, fuera del repo | Credencial y evento → RPC | Funcional en operación. La pantalla miente | Activepieces duplicaría n8n. BullMQ MIT, después, solo para la cola interna | Corregir el texto de Integraciones. No migrar flujos |
| Multiempresa | Entrar a la sucursal correcta | Gate de sucursal y membresía | SENDA | Usuario → organización y sucursal | Funcional para un grupo | Company/Warehouse de ERPNext solo si apareciera otra razón social con libros propios | No crear una Company por sucursal. Barrio Chino y Pruebas siguen siendo sucursales de la misma organización |

## 5. Qué conservar, qué sustituir, qué integrar

Conservar, porque ya está probado y es el producto:

- Web de facturas, inventario y recetas.
- RPC de recepción, CPP, ajuste, baja de factura y consumo de venta.
- n8n y Gemini para leer facturas.
- El contrato de Fudo: SENDA no explota la venta; recibe la cantidad ya calculada en `register_sale_consumption`.
- Unidades base gramo, mililitro y unidad. IVA fuera del costo hasta una decisión aparte.
- La regla de anulación: con un movimiento posterior que no sea otra compra, la factura sigue activa y los costos viejos no se tocan.

Sustituir, más adelante y en cambios chicos:

- El placeholder de Resumen y el de Integraciones, que describen un sistema desconectado.
- El almacén interno de jobs de análisis, por BullMQ MIT, cuando un job perdido vuelva a ser el problema. Hace falta Redis. No se agrega ahora.
- El mensaje genérico de recepción cuando la base responde `UNVALUED_STOCK`.

Integrar solo como lectura, sin correr el proyecto:

- ERPNext, para el ledger y para la prueba de anulación.
- Grocy, para el lenguaje de cocina de consumo, merma y faltantes.
- InvenTree, para el día en que el costo deba ocultarse por rol.

No integrar como sistema: ERPNext, InvenTree, Grocy, TastyIgniter ni Activepieces. Ninguno reduce el código propio del tramo que SENDA ya cerró. Lo aumentan, porque hay que traducir facturas, unidades, Fudo y la regla de anulación.

## 6. Prueba de concepto reproducible

Objetivo: ver si ERPNext puede ser motor de CPP. No es el inicio de una migración.

Entorno: una máquina con Docker, distinta de la base SENDA. No usar credenciales, URL ni service role de Supabase. No instalar la prueba dentro de `senda-ops`. El compose oficial no acepta apps propias y está pensado para tirarse.

```sh
git clone https://github.com/frappe/frappe_docker
cd frappe_docker
docker compose -f pwd.yml up -d
```

Esperar a que el contenedor `create-site` termine. Abrir `http://localhost:8080` con `Administrator` / `admin`. En el usuario, crear API key y API secret. Todas las llamadas llevan `Authorization: token <key>:<secret>` y `Content-Type: application/json`.

Datos, en gramos, para poder compararlos con SENDA:

1. Crear el ítem `SENDA-POC-HARINA`. `is_stock_item = 1`, UOM `Gram`, `valuation_method = Moving Average`. No cargar un costo estándar que tape el de la compra.
2. Usar un almacén de tienda, por ejemplo el Stores que crea el sitio. Anotar el nombre exacto.
3. Purchase Receipt de 10000 g a importe 120000. Enviar el documento (`docstatus` de envío, no dejarlo en borrador).
4. Consultar `Bin` del ítem y el almacén. El `valuation_rate` esperado es 12.
5. Stock Entry de salida, 8000 g, propósito Material Issue. El promedio debe seguir en 12 y la cantidad en 2000.
6. Segunda Purchase Receipt, 10000 g a importe 140000. Cantidad 12000. Promedio esperado 13,66666667 por gramo, o 13666,67 por kilo si se multiplica por 1000 y se redondea a centavos.
7. Otra salida de 200 g, como merma. El promedio no debe moverse. El costo de esos 200 g, a centavos, es 2733,33.
8. Intentar cancelar la primera recepción. Leer después `Stock Ledger Entry` filtrado por `item_code`, ordenado por `posting_date` y `posting_time`.
9. Leer `Bin` para la valuación actual.

Criterio de cierre, en este orden:

- Si alguna salida posterior cambió de `valuation_rate` o de `stock_value_difference`, la prueba falla para SENDA. Es el resultado que describe la documentación de promedio móvil y de `repost_future_sle_and_gle`. Con ese resultado, ERPNext no es el motor.
- Si la cancelación se rechaza y los Stock Ledger Entries quedan como estaban, el comportamiento se acerca a SENDA. Igual no migra: faltan factura AFIP, Fudo, unidades de receta y el bloqueo de stock sin costo. Habría que escribir eso igual, en Python.
- Si el promedio del paso 6 no es 13,66666667, anotar la tasa exacta que devolvió `Bin` antes de hablar de migración. La diferencia de redondeo no se “arregla” a mano en producción.

Al terminar: `docker compose -f pwd.yml down -v`. No hay paso de sincronización con SENDA.

Esta prueba no se ejecutó en esta evaluación. En este equipo el socket de Docker no está disponible para el usuario que corre el agente, y no corresponde levantarla contra la base real.

## 7. Riesgos de licencia y de migración

Licencias:

- No copiar archivos de ERPNext al repositorio. GPL-3. Frappe MIT no autoriza a relicenciar ERPNext.
- Un servicio que solo llama a la API de un ERPNext alojado por SENDA es viable para vender SaaS. Entregar al cliente una imagen con ERPNext modificado obliga a ofrecer el código de esa obra GPL.
- InvenTree, Grocy, TastyIgniter núcleo y BullMQ son MIT: se pueden usar en un producto comercial si se conserva el aviso. No hace falta venderlos embebidos.
- TastyIgniter: las extensiones del marketplace no heredan el MIT del núcleo. No revenderlas.
- Activepieces: no desplegar código de `packages/ee` sin licencia. Además duplica n8n.
- BullMQ Pro no se usa. La edición MIT alcanza para una cola.

Migración, si alguien retomara la opción A pese a esta decisión:

- Dos fuentes de verdad de stock durante el corte.
- Los siete insumos activos de Barrio Chino entrarían a ERPNext con el último precio como si fuera promedio histórico. El mismo límite que SENDA ya aceptó, más el recálculo al anular.
- Carne picada de Barrio Chino tiene saldo 0 y movimientos que suman 9300 g. No se “arregla” migrando.
- Las facturas ya leídas, los vínculos Fudo y las recetas habría que reescribirlos o mantener Supabase igual. El ahorro de código no aparece.
- Operación: actualizaciones de Frappe, Redis, MariaDB y el sitio, además de Supabase.

Riesgo de quedarse en B, dicho para que no quede escondido: SENDA no tiene contabilidad, órdenes de compra ni impuestos electrónicos de venta. Cuando eso sea el producto, se evalúa de nuevo un contable externo. No se adelanta un ERP para llegar antes a márgenes y alertas.

## 8. Primer módulo que conviene cerrar

El primer módulo comercializable es el que SENDA ya tiene a medio publicar: **Compras, stock y CPP**.

No se adopta un módulo open source en su lugar. El núcleo ya está en producción: factura, recepción, promedio, ajuste y anulación segura. Lo que lo vuelve un módulo entregable, en este orden, sin cambiar de motor:

1. Dejar de usar insumos reales como banco de pruebas. La evidencia del CPP es la ya corrida en base descartable y la verificación leída en SENDA.
2. Mensaje claro cuando una recepción cae en stock sin costo.
3. Merma como acción visible sobre el ajuste actual.
4. Aviso de stock bajo el mínimo que ya está guardado.
5. Margen en la receta, con el precio por sucursal y el CPP, todavía sin IVA.
6. Pantalla de ventas y consumos que lea los movimientos que n8n ya genera.

BullMQ queda segundo, y solo si la cola de facturas vuelve a fallar. ERPNext queda en la prueba de Docker y en la documentación de valuación, no en el camino de entrega.

## Fuentes

- ERPNext GPL-3.0: https://github.com/frappe/erpnext/blob/develop/license.txt
- Frappe MIT: https://github.com/frappe/frappe/blob/develop/LICENSE
- Promedio móvil y recálculo: https://docs.frappe.io/erpnext/fifo-and-moving-average
- Anulación y ledger: https://docs.frappe.io/erpnext/how-transactions-affect-the-ledger y https://docs.frappe.io/erpnext/accounting-of-inventory-stock
- Company y sucursal: https://docs.frappe.io/erpnext/company
- Docker descartable: https://github.com/frappe/erpnext (sección Try on your environment, `frappe_docker` / `pwd.yml`)
- InvenTree MIT y precios: https://github.com/inventree/InvenTree/blob/master/LICENSE y https://docs.inventree.org/en/latest/part/pricing/
- Grocy MIT y API: https://github.com/grocy/grocy/blob/master/LICENSE.md y https://grocy.info/
- TastyIgniter MIT: https://github.com/tastyigniter/TastyIgniter/blob/4.x/LICENSE.md y https://tastyigniter.com/license
- Activepieces núcleo MIT y enterprise comercial: https://www.activepieces.com/docs/about/license
- BullMQ MIT y Pro comercial: https://github.com/taskforcesh/bullmq/blob/master/LICENSE y https://docs.bullmq.io/bullmq-pro/introduction
