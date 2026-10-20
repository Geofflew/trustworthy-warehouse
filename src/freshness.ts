import { rows, type Db } from './db.ts'

/**
 * Every source declares where its freshness lives. The content column is a fact the SOURCE writes
 * (an invoice date), never a stamp our copy writes. A source with no such column must say why, and
 * the type makes that sentence mandatory: `contentColumn: null` without `noContentReason` does not
 * compile.
 */
export type Source = {
  table: string
  /** Our pipeline's copy stamp. Moves every time the copy runs, whatever the rows say. */
  loadedAtColumn: string
  staleAfterHours: number
} & (
  | { contentColumn: string; frozenAfterDays: number }
  | { contentColumn: null; noContentReason: string }
)

export const SOURCES: Source[] = [
  // Billed monthly, so a month and a half without an invoice is the first sign of trouble.
  { table: 'bronze.invoices', loadedAtColumn: '_loaded_at', staleAfterHours: 36, contentColumn: 'issued_on', frozenAfterDays: 45 },
  // The integration touches every live connection daily.
  { table: 'bronze.usage_connections', loadedAtColumn: '_loaded_at', staleAfterHours: 36, contentColumn: 'last_seen_at', frozenAfterDays: 7 },
  {
    table: 'bronze.plans',
    loadedAtColumn: '_loaded_at',
    staleAfterHours: 24 * 400,
    contentColumn: null,
    noContentReason: 'reference list of plan names, edited by hand a few times a year; nothing in it records when',
  },
]

export interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

const ageDays = (newest: Date | null, asOf: Date): number | null =>
  newest === null ? null : Math.round((asOf.getTime() - newest.getTime()) / 86_400_000)

/** Is the copy still running? Reads only our load stamp. */
export async function staleCheck(db: Db, s: Source, asOf: Date): Promise<CheckResult> {
  const [r] = await rows<{ newest: Date | null }>(db, `SELECT max(${s.loadedAtColumn}) AS newest FROM ${s.table}`)
  const hours = r!.newest === null ? null : Math.round((asOf.getTime() - r!.newest.getTime()) / 3_600_000)
  return {
    name: `${s.table}.stale`,
    ok: hours !== null && hours <= s.staleAfterHours,
    detail: `newest ${s.loadedAtColumn} is ${hours ?? 'never'} hours old, limit ${s.staleAfterHours}`,
  }
}

/**
 * Is the source still producing? Reads the declared content column and ignores values after `asOf`:
 * a scheduled invoice dated two years out would otherwise make a dead feed read as fresh.
 */
export async function frozenCheck(db: Db, s: Source, asOf: Date): Promise<CheckResult | null> {
  if (s.contentColumn === null) return null
  const c = s.contentColumn
  const [r] = await rows<{ newest: Date | null; future: number }>(db, `
    SELECT max(${c}::timestamptz) FILTER (WHERE ${c}::timestamptz <= $1) AS newest,
           count(*) FILTER (WHERE ${c}::timestamptz > $1)::int AS future
    FROM ${s.table}`, [asOf])
  const age = ageDays(r!.newest, asOf)
  return {
    name: `${s.table}.frozen`,
    ok: age !== null && age <= s.frozenAfterDays,
    detail:
      `newest ${c} is ${age ?? 'never'} days old, limit ${s.frozenAfterDays}` +
      (r!.future ? ` (${r!.future} future-dated row${r!.future === 1 ? '' : 's'} ignored)` : ''),
  }
}

/**
 * The rejected design: no declaration, take the newest of every date or timestamp column (future
 * values already cut). On a copied table the column that moves most is the copy stamp, so this
 * measures the pipeline and calls a dead source fresh.
 */
export async function naiveFreshness(db: Db, table: string, asOf: Date): Promise<{ column: string; ageDays: number }> {
  const cols = await rows<{ column_name: string }>(db, `
    SELECT column_name FROM information_schema.columns
    WHERE table_schema || '.' || table_name = $1 AND data_type IN ('date', 'timestamp with time zone')`, [table])
  const newest = await rows<{ column: string; newest: Date }>(db,
    cols.map((c) => `SELECT '${c.column_name}' AS column, max(${c.column_name}::timestamptz) FILTER (WHERE ${c.column_name}::timestamptz <= $1) AS newest FROM ${table}`).join(' UNION ALL ') +
      ' ORDER BY newest DESC NULLS LAST LIMIT 1', [asOf])
  return { column: newest[0]!.column, ageDays: ageDays(newest[0]!.newest, asOf)! }
}

/** Runtime twin of the type rule, for sources declared outside TypeScript (JSON, YAML). */
export function validateSource(s: Source): void {
  if (s.contentColumn === null && !('noContentReason' in s && s.noContentReason.trim()))
    throw new Error(`${s.table}: contentColumn is null with no written reason`)
}
