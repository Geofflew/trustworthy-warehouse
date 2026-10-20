import { readFileSync } from 'node:fs'
import pg from 'pg'

// .env is optional: DATABASE_URL may come from the shell instead.
try {
  process.loadEnvFile()
} catch {}

/** The warehouse's fixed "today". Every check takes it as an argument instead of reading the clock. */
// Dates stay strings and counts stay numbers, so output does not depend on the machine's time zone.
pg.types.setTypeParser(1082, (v) => v)
pg.types.setTypeParser(20, Number)
pg.types.setTypeParser(1700, Number)

export const AS_OF = '2025-06-30'
export const AS_OF_TS = new Date(`${AS_OF}T00:00:00Z`)

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5499/acme_warehouse'

export type Db = pg.Pool | pg.PoolClient

export function connect(): pg.Pool {
  // UTC so a date read as a timestamp means the same instant on every machine.
  return new pg.Pool({ connectionString: DATABASE_URL, max: 4, options: '-c TimeZone=UTC' })
}

/** Apply the schema. Idempotent, and it restores every view to its original definition. */
export async function setup(db: Db): Promise<void> {
  const sql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8').replaceAll('{{AS_OF}}', AS_OF)
  await db.query(sql)
}

export async function rows<T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query(sql, params)).rows as T[]
}
