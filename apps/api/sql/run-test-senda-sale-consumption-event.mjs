#!/usr/bin/env node
/**
 * Postgres embebido (senda_cpp_test): fixture + CPP + sale-event + suite integral.
 * No toca SENDA. Uso: node sql/run-test-senda-sale-consumption-event.mjs
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const cacheDir = '/tmp/senda-embedded-postgres-sale-event'
const moduleDir = join(cacheDir, 'node_modules')

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}\n${r.stderr || r.stdout}`)
  return r.stdout
}

function ensureDeps() {
  mkdirSync(cacheDir, { recursive: true })
  if (!existsSync(join(moduleDir, 'embedded-postgres')) || !existsSync(join(moduleDir, 'pg'))) {
    sh('npm', ['install', '--prefix', cacheDir, 'embedded-postgres@18.6.0-beta.19', 'pg@8.16.3'], {
      cwd: cacheDir,
    })
  }
}

function sqlFile(name) {
  return readFileSync(join(__dirname, name), 'utf8')
}

async function execSql(client, label, sql) {
  process.stdout.write(`→ ${label}… `)
  try {
    await client.query(sql)
    console.log('ok')
  } catch (err) {
    console.log('FAIL')
    throw new Error(`${label}: ${err.message}`)
  }
}

async function main() {
  ensureDeps()
  const epMod = await import(pathToFileURL(join(moduleDir, 'embedded-postgres/dist/index.js')).href)
  const EmbeddedPostgres = epMod.default ?? epMod
  const require = createRequire(join(cacheDir, 'package.json'))
  const { Client } = require('pg')

  const db = new EmbeddedPostgres({
    databaseDir: join(cacheDir, 'data'),
    user: 'postgres',
    password: 'postgres',
    port: 55433,
    persistent: false,
  })

  console.log('Starting embedded Postgres…')
  await db.initialise()
  await db.start()
  await db.createDatabase('senda_cpp_test')

  const client = new Client({
    host: '127.0.0.1',
    port: 55433,
    user: 'postgres',
    password: 'postgres',
    database: 'senda_cpp_test',
  })
  await client.connect()

  try {
    await execSql(client, 'fixture', sqlFile('test-senda-cpp-fixture.sql'))
    await execSql(
      client,
      'test helpers',
      `
      create or replace function public.cpp_test_product(p_org uuid, p_name text)
      returns uuid language plpgsql as $f$
      declare v_id uuid := gen_random_uuid();
      begin
        insert into public.inventory_products (id, organization_id, name, active)
        values (v_id, p_org, p_name, true);
        return v_id;
      end $f$;

      create or replace function public.cpp_test_open(
        p_org uuid, p_location uuid, p_product uuid, p_physical numeric, p_amount numeric, p_day date
      ) returns table (doc uuid, line uuid)
      language plpgsql as $f$
      declare v_doc uuid := gen_random_uuid(); v_line uuid := gen_random_uuid();
      begin
        insert into public.purchase_documents (
          id, location_id, organization_id, status, currency, document_date,
          issuer_name, document_number
        ) values (
          v_doc, p_location, p_org, 'reviewed', 'ARS', p_day, 'FIXTURE', 'SALE-TEST'
        );
        insert into public.purchase_document_lines (
          id, purchase_document_id, inventory_eligibility, mapping_status, classification,
          quantity_kind, reviewed_amount, original_amount, inventory_product_id,
          inventory_physical_quantity
        ) values (
          v_line, v_doc, 'eligible', 'mapped', 'ingredient',
          'unit', p_amount, p_amount, p_product, p_physical
        );
        doc := v_doc; line := v_line; return next;
      end $f$;

      create or replace function public.cpp_test_state(p_product uuid)
      returns table (qty numeric, avg numeric, last_cost numeric, li uuid)
      language sql stable as $f$
        select iv.quantity_on_hand, iv.average_unit_cost, iv.last_purchase_unit_cost, li.id
        from public.location_inventory li
        join public.inventory_valuations iv on iv.location_inventory_id = li.id
        where li.inventory_product_id = p_product;
      $f$;

      create or replace function public.cpp_test_expect(p_ok boolean, p_name text)
      returns void language plpgsql as $f$
      begin
        if p_ok is not true then
          raise exception 'CPP_TEST_FAILED: %', p_name;
        end if;
      end $f$;
      `,
    )
    await execSql(client, 'proposed-senda-cpp', sqlFile('proposed-senda-cpp.sql'))
    // Mínimo para políticas RLS del evento (en SENDA ya existen).
    await execSql(
      client,
      'org members stub',
      `
      create schema if not exists auth;
      create or replace function auth.uid() returns uuid
        language sql stable as $f$ select null::uuid $f$;
      create table if not exists public.organization_members (
        organization_id uuid not null,
        user_id uuid not null,
        status text not null default 'active'
      );
      `,
    )
    await execSql(
      client,
      'sale-consumption-event',
      sqlFile('proposed-senda-sale-consumption-event.sql'),
    )
    await execSql(client, 'integral suite', sqlFile('test-senda-sale-consumption-event.sql'))
    await execSql(
      client,
      'fudo 41068/148651 rehearsal',
      sqlFile('test-senda-sale-consumption-event-fudo-41068.sql'),
    )
    console.log('ALL TESTS PASSED')
  } finally {
    await client.end().catch(() => {})
    await db.stop().catch(() => {})
  }
}

main().catch((err) => {
  console.error(err.message || err)
  process.exitCode = 1
})
