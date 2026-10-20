import type pg from 'pg'
import { rows } from './db.ts'

/**
 * One step of a multi-step answer.
 *
 * `filter` steps exist to remove rows and must say why. `enrich` steps (a join that adds columns)
 * must keep every row and must not multiply them: if one drops a row, the join narrowed the question
 * without anyone deciding to, and the ledger flags it.
 */
export interface Step {
  name: string
  kind: 'filter' | 'enrich'
  /** Why a row leaves at this step. Printed whenever a row does; required so a drop always has a reason. */
  reason: string
  /** SQL reading the previous step's rows from the relation named `prev`. */
  sql: (prev: string) => string
}

export interface LedgerLine {
  step: string
  entered: number
  kept: number
  dropped: number
  /** Keys present after the step that were not present before it. Always 0 for an honest step. */
  arrived: number
  reason: string
  flag?: 'enrich step dropped rows' | 'fan-out' | 'keys arrived'
}

export interface Ledger<T> {
  rows: T[]
  lines: LedgerLine[]
  /** Printed every time, including when nothing was dropped. */
  text: string
  /** Steps whose behaviour broke their declaration. Empty means every step did what it said. */
  flags: LedgerLine[]
}

/**
 * Run `base` (what one row is: `unit`, keyed by `key`) through `steps`, recording entered / kept /
 * dropped / reason for every step. Each step materialises into a temp table inside one transaction,
 * so every count describes exactly the rows the next step reads.
 */
export async function runLedger<T>(
  client: pg.PoolClient,
  unit: { name: string; key: string; base: string },
  steps: Step[]
): Promise<Ledger<T>> {
  const count = async (rel: string) =>
    (await rows<{ n: number; keys: number }>(client, `SELECT count(*)::int AS n, count(DISTINCT ${unit.key})::int AS keys FROM ${rel}`))[0]!
  await client.query('BEGIN')
  try {
    await client.query(`CREATE TEMP TABLE ledger_0 ON COMMIT DROP AS ${unit.base}`)
    const start = await count('ledger_0')
    const lines: LedgerLine[] = []
    for (const [i, step] of steps.entries()) {
      const prev = `ledger_${i}`, next = `ledger_${i + 1}`
      await client.query(`CREATE TEMP TABLE ${next} ON COMMIT DROP AS ${step.sql(prev)}`)
      const before = await count(prev), after = await count(next)
      // Which keys, not how many: a step that swaps three accounts for three others nets to zero.
      const diff = async (a: string, b: string) =>
        (await rows<{ n: number }>(client, `SELECT count(*)::int AS n FROM (SELECT ${unit.key} FROM ${a} EXCEPT SELECT ${unit.key} FROM ${b}) d`))[0]!.n
      const dropped = await diff(prev, next), arrived = await diff(next, prev)
      const line: LedgerLine = {
        step: step.name,
        entered: before.keys,
        kept: after.keys,
        dropped,
        arrived,
        reason: dropped > 0 ? step.reason : 'nothing dropped',
      }
      if (arrived > 0) line.flag = 'keys arrived'
      else if (after.n !== after.keys) line.flag = 'fan-out'
      else if (step.kind === 'enrich' && line.dropped > 0) line.flag = 'enrich step dropped rows'
      lines.push(line)
    }
    const result = await rows<T>(client, `SELECT * FROM ledger_${steps.length} ORDER BY ${unit.key}`)
    await client.query('COMMIT')
    const dropped = lines.reduce((n, l) => n + l.dropped, 0)
    const arrived = lines.reduce((n, l) => n + l.arrived, 0)
    const final = lines.at(-1)?.kept ?? start.keys
    const width = Math.max(...lines.map((l) => l.step.length))
    const text = [
      `  one row per ${unit.name} (${unit.key}); ${start.keys} entered`,
      ...lines.map(
        (l) =>
          `  ${l.step.padEnd(width)}  entered ${String(l.entered).padStart(4)}  kept ${String(l.kept).padStart(4)}` +
          `  dropped ${String(l.dropped).padStart(4)}  ${l.reason}${l.arrived ? `, ${l.arrived} arrived` : ''}${l.flag ? `   <-- ${l.flag}` : ''}`
      ),
      `  total: ${start.keys} entered = ${final} kept + ${dropped} dropped` +
        (arrived === 0 ? '' : `   <-- DOES NOT RECONCILE: ${arrived} kept keys never entered`),
    ].join('\n')
    return { rows: result, lines, text, flags: lines.filter((l) => l.flag) }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  }
}
