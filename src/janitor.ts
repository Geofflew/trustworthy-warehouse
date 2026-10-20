import { rows, type Db } from './db.ts'
import { DURATIONS, negativeDurations } from './durations.ts'
import { frozenCheck, SOURCES, staleCheck, type CheckResult } from './freshness.ts'
import type pg from 'pg'

/** Every check the janitor reads. Each returns ok plus the detail a card will carry verbatim. */
export async function runChecks(db: Db, asOf: Date): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  for (const s of SOURCES) {
    results.push(await staleCheck(db, s, asOf))
    const frozen = await frozenCheck(db, s, asOf)
    if (frozen) results.push(frozen)
  }
  for (const d of DURATIONS) {
    const bad = await negativeDurations(db, d)
    results.push({
      name: `${d.name}.negative_duration`,
      ok: bad.length === 0,
      detail: bad.length
        ? `${bad.length} rows of ${d.relation} have ${d.end} before ${d.start}; worst ${bad[0]!.days} days (${d.key} ${bad[0]!.key})`
        : `no ${d.name} runs backwards`,
    })
  }
  return results
}

/**
 * Fixes a person may approve, by check. A check with no entry still gets a card, but approving it is
 * refused: a frozen upstream feed is fixed upstream, not by the warehouse.
 */
export const FIXES: Record<string, { name: string; apply: (db: pg.PoolClient) => Promise<void> }> = {
  'onboarding.negative_duration': {
    name: 'measure onboarding from the first contract',
    // customer_since keeps its meaning (current contract start); the duration stops depending on it.
    apply: async (db) => {
      await db.query(`
        CREATE OR REPLACE VIEW semantic.onboarding AS
        SELECT account_id, name, customer_since, first_signed_on,
               first_signed_on                  AS onboarding_start,
               went_live_on,
               (went_live_on - first_signed_on) AS onboarding_days
        FROM silver.accounts
        WHERE is_customer AND went_live_on IS NOT NULL`)
    },
  },
}

export interface Card {
  id: number
  check_name: string
  finding: string
  fix_name: string | null
  status: 'open' | 'fixed' | 'dismissed'
  decided_by: string | null
  decided_at: Date | null
}

/**
 * Turn failing checks into cards. The partial unique index decides what is new: a check that already
 * has an open card files nothing, however many nights it fails. The database enforces it, so two
 * janitor runs racing each other cannot both file.
 */
export async function janitorRun(db: Db, asOf: Date): Promise<{ opened: Card[]; alreadyOpen: string[] }> {
  const failing = (await runChecks(db, asOf)).filter((r) => !r.ok)
  const opened: Card[] = [], alreadyOpen: string[] = []
  for (const f of failing) {
    const [card] = await rows<Card>(db, `
      INSERT INTO public.janitor_recommendations (check_name, finding, fix_name, opened_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (check_name) WHERE status = 'open' DO NOTHING
      RETURNING *`, [f.name, f.detail, FIXES[f.name]?.name ?? null, asOf])
    if (card) opened.push(card)
    else alreadyOpen.push(f.name)
  }
  return { opened, alreadyOpen }
}

/**
 * Approve a card: apply its fix, re-run its check, and commit only if the check now passes. Postgres
 * DDL is transactional, so a fix that does not clear the finding leaves no trace.
 */
export async function approve(client: pg.PoolClient, cardId: number, by: string, asOf: Date): Promise<Card> {
  await client.query('BEGIN')
  try {
    const [card] = await rows<Card>(client,
      `SELECT * FROM public.janitor_recommendations WHERE id = $1 AND status = 'open' FOR UPDATE`, [cardId])
    if (!card) throw new Error(`card ${cardId} is not open`)
    const fix = FIXES[card.check_name]
    if (!fix) throw new Error(`card ${cardId} (${card.check_name}) has no registered fix; it needs a person upstream`)
    await fix.apply(client)
    const after = (await runChecks(client, asOf)).find((r) => r.name === card.check_name)
    if (!after?.ok) throw new Error(`fix "${fix.name}" did not clear ${card.check_name}: ${after?.detail}`)
    const [done] = await rows<Card>(client, `
      UPDATE public.janitor_recommendations SET status = 'fixed', decided_by = $2, decided_at = $3
      WHERE id = $1 RETURNING *`, [cardId, by, asOf])
    await client.query('COMMIT')
    return done!
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  }
}
