#!/usr/bin/env node
/**
 * Arranca Postgres embebido (base senda_cpp_test), aplica fixture+CPP+RPC y
 * ejecuta test-senda-exceptional-void-mayoristanet.sql. No toca SENDA.
 *
 * Uso:
 *   node sql/run-test-exceptional-void-mayoristanet.mjs
 *
 * Instala embedded-postgres en /tmp si hace falta (no lo agrega a package.json).
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const apiRoot = join(__dirname, '..')
const cacheDir = '/tmp/senda-embedded-postgres-mayoristanet'
const moduleDir = join(cacheDir, 'node_modules')

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')}\n${r.stderr || r.stdout}`)
  }
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
  const epMod = await import(
    pathToFileURL(join(moduleDir, 'embedded-postgres/dist/index.js')).href
  )
  const EmbeddedPostgres = epMod.default ?? epMod
  const require = createRequire(join(cacheDir, 'package.json'))
  const { Client } = require('pg')

  const dataDir = join(cacheDir, 'data')
  const port = 55432
  const db = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
  })

  console.log('Starting embedded Postgres…')
  await db.initialise()
  await db.start()
  await db.createDatabase('senda_cpp_test')

  const client = new Client({
    host: '127.0.0.1',
    port,
    user: 'postgres',
    password: 'postgres',
    database: 'senda_cpp_test',
  })
  await client.connect()

  try {
    await execSql(client, 'fixture', sqlFile('test-senda-cpp-fixture.sql'))
    // Helpers de test-senda-cpp.sql (cpp_test_product / expect) sin correr todo el suite CPP.
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
    await execSql(
      client,
      'exceptional rpc',
      sqlFile('proposed-senda-exceptional-void-mayoristanet-ef01f3a8.sql'),
    )
    await execSql(
      client,
      'security suite',
      sqlFile('test-senda-exceptional-void-mayoristanet.sql'),
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
