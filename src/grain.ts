import { rows, type Db } from './db.ts'

// ── run-time guard: the result's declared grain must hold ───────────────────

export class FanOutError extends Error {
  constructor(
    readonly grain: string,
    readonly rowCount: number,
    readonly distinctKeys: number
  ) {
    super(`fan-out: declared one row per ${grain}, got ${rowCount} rows for ${distinctKeys} distinct ${grain}`)
  }
}

export interface GrainResult<T> {
  rows: T[]
  rowCount: number
  distinctKeys: number
  /** Set in annotate mode when the grain did not hold. */
  warning?: string
}

/**
 * Run `sql` as an answer whose rows are one per `grain` (a column, or a comma list for a composite
 * key). Both counts are taken by Postgres over the same subquery in the same statement, so they
 * describe exactly the rows returned. Refuses by default; `annotate` returns the rows with a warning
 * for a caller that wants to show the inflated answer next to the reason.
 */
export async function runAtGrain<T>(
  db: Db,
  sql: string,
  grain: string,
  mode: 'refuse' | 'annotate' = 'refuse'
): Promise<GrainResult<T>> {
  const key = grain.includes(',') ? `(${grain})` : grain
  const [counts] = await rows<{ row_count: number; distinct_keys: number }>(
    db,
    `SELECT count(*)::int AS row_count, count(DISTINCT ${key})::int AS distinct_keys FROM (${sql}) answer`
  )
  const { row_count: rowCount, distinct_keys: distinctKeys } = counts!
  const result: GrainResult<T> = { rows: await rows<T>(db, sql), rowCount, distinctKeys }
  if (rowCount !== distinctKeys) {
    const error = new FanOutError(grain, rowCount, distinctKeys)
    if (mode === 'refuse') throw error
    result.warning = error.message
  }
  return result
}

// ── declared-shape guard: an additive aggregate over a repeated relation ────
//
// The run-time guard cannot see this case: `SELECT account_id, sum(c.value) ... GROUP BY account_id`
// returns one row per account and passes, while every sum is multiplied by the account's deal count.
// So a declared description of the query (not its SQL) is checked against declared keys first.

export interface Model {
  /** Each relation's key: what one row of it is. A relation missing here is refused, never assumed safe. */
  keys: Record<string, string[]>
}

export interface QueryShape {
  /** Equality joins, as [`relation.column`, `relation.column`]. */
  joins: Array<[string, string]>
  groupBy: string[]
  aggregates: Array<{ fn: 'sum' | 'avg' | 'count' | 'count_distinct' | 'min' | 'max'; column: string }>
}

const split = (path: string): [string, string] => {
  const [relation, column] = path.split('.')
  return [relation!, column!]
}

/**
 * Which relations the joins repeat, judged one join at a time. All conditions between the same two
 * relations form one edge. On edge a–b, b fans out when the columns b is joined on miss part of b's
 * key: one a row can then match several b rows. Every relation still connected to a once that edge
 * is cut is then repeated, because each of its rows travels with a. So in contracts → items →
 * item_metadata, items fans out against contracts and contracts is repeated, even though items is
 * joined on its whole key at the next hop. Pooling a relation's join columns across edges (an
 * earlier version of this check) read that as "items is pinned by its key" and passed a doubled sum.
 * A GROUP BY naming the rest of b's key "pins" b: each group holds one of its rows, so it fans out
 * against nothing. In a join graph with a cycle, the cut does not separate anything, so everything
 * is marked repeated whenever any edge fans out: that is right for two children joined back on their
 * parent's key, and refuses some safe cycles rather than prove them.
 */
export function multiplied(model: Model, q: QueryShape): Set<string> {
  const edges = new Map<string, { ends: [string, string]; on: Map<string, Set<string>> }>()
  for (const [left, right] of q.joins) {
    const [a, ca] = split(left)
    const [b, cb] = split(right)
    const id = [a, b].sort().join(' ')
    const edge = edges.get(id) ?? { ends: [a, b], on: new Map([[a, new Set<string>()], [b, new Set<string>()]]) }
    edge.on.get(a)!.add(ca)
    edge.on.get(b)!.add(cb)
    edges.set(id, edge)
  }
  const grouped = new Set(q.groupBy)
  const fansOut = (relation: string, on: Set<string>) => {
    const key = model.keys[relation]
    if (!key) throw new Error(`unknown relation: ${relation}`)
    return key.some((k) => !on.has(k) && !grouped.has(`${relation}.${k}`))
  }
  const reachable = (from: string, cut: object) => {
    const seen = new Set([from])
    for (const stack = [from]; stack.length; ) {
      const r = stack.pop()!
      for (const e of edges.values()) {
        if (e === cut || !e.ends.includes(r)) continue
        const next = e.ends[0] === r ? e.ends[1] : e.ends[0]
        if (seen.has(next)) continue
        seen.add(next)
        stack.push(next)
      }
    }
    return seen
  }
  const out = new Set<string>()
  for (const edge of edges.values())
    for (const [a, b] of [edge.ends, [edge.ends[1], edge.ends[0]]] as const)
      if (fansOut(b, edge.on.get(b)!)) for (const r of reachable(a, edge)) out.add(r)
  return out
}

export interface AggregateVerdict {
  aggregate: string
  ok: boolean
  reason: string
}

/**
 * SUM and COUNT(col) over a multiplied relation are wrong whatever the GROUP BY: inside a group the
 * repeated value is added once per repeat. AVG is right only when the GROUP BY includes the
 * relation's own key, because then the repeated value is a constant within the group. MIN, MAX and
 * COUNT(DISTINCT) are unaffected by repeats.
 */
export function checkAggregates(model: Model, q: QueryShape): AggregateVerdict[] {
  // Fail closed: an alias or a misspelt name would otherwise read as "not repeated".
  const unknown = [...q.joins.flat(), ...q.groupBy, ...q.aggregates.map((a) => a.column)]
    .map((p) => split(p)[0])
    .filter((r) => !(r in model.keys))
  if (unknown.length) throw new Error(`unknown relation: ${[...new Set(unknown)].join(', ')}`)
  const repeated = multiplied(model, q)
  return q.aggregates.map(({ fn, column }) => {
    const aggregate = `${fn}(${column})`
    const [relation] = split(column)
    if (!repeated.has(relation)) return { aggregate, ok: true, reason: `${relation} rows are not repeated by any join` }
    if (fn === 'min' || fn === 'max' || fn === 'count_distinct')
      return { aggregate, ok: true, reason: `${fn} is unaffected by repeated rows` }
    const ownKey = (model.keys[relation] ?? []).every((k) => q.groupBy.includes(`${relation}.${k}`))
    if (fn === 'avg' && ownKey) return { aggregate, ok: true, reason: `grouped by ${relation}'s key, so the value is constant per group` }
    return {
      aggregate,
      ok: false,
      reason:
        `${relation} rows are repeated by the join, so ${aggregate} counts each one several times. ` +
        `Aggregate ${relation} at its own grain before joining, or use max(${column}) per ${relation} key.`,
    }
  })
}
