import { rows, type Db } from './db.ts'

/** Two date columns whose difference is read as a length of time. */
export interface Duration {
  name: string
  relation: string
  key: string
  start: string
  end: string
}

/** Every pair of dates in the warehouse that some answer subtracts. A new one is a line here. */
export const DURATIONS: Duration[] = [
  { name: 'onboarding', relation: 'semantic.onboarding', key: 'account_id', start: 'onboarding_start', end: 'went_live_on' },
  { name: 'contract_term', relation: 'semantic.contracts', key: 'contract_id', start: 'start_date', end: 'end_date' },
]

export interface NegativeRow {
  key: number
  start: string
  end: string
  days: number
}

/**
 * A length of time below zero is impossible, so a row whose end precedes its start proves one of the
 * two dates means something other than what the subtraction assumes; the check returns those rows, worst first, so the finding names
 * the evidence rather than a count.
 */
export async function negativeDurations(db: Db, d: Duration): Promise<NegativeRow[]> {
  return rows(db, `
    SELECT ${d.key} AS key, ${d.start}::text AS start, ${d.end}::text AS end, (${d.end} - ${d.start})::int AS days
    FROM ${d.relation}
    WHERE ${d.end} < ${d.start}
    ORDER BY days, ${d.key}`)
}

export async function medianDays(db: Db, d: Duration, start = d.start): Promise<number> {
  const [r] = await rows<{ median: number }>(db,
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ${d.end} - ${start})::float AS median FROM ${d.relation}`)
  return r!.median
}
