// One test per guard, each written so it fails if the guard is removed. Needs DATABASE_URL; it
// regenerates the synthetic data, so point it at a database you do not mind rebuilding.
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generate } from '../scripts/generate.ts'
import { AS_OF_TS, connect, rows, setup } from '../src/db.ts'
import { DURATIONS, negativeDurations } from '../src/durations.ts'
import { frozenCheck, SOURCES, staleCheck, validateSource, type Source } from '../src/freshness.ts'
import { checkAggregates, FanOutError, runAtGrain } from '../src/grain.ts'
import { approve, FIXES, janitorRun } from '../src/janitor.ts'
import { runLedger } from '../src/ledger.ts'
import { allZero, connectionsBroken, connectionsGuarded, tally } from '../src/measured.ts'
import * as plans from '../src/plans.ts'

let db: pg.Pool
let client: pg.PoolClient
beforeAll(async () => {
  db = connect()
  await generate(db)
  client = await db.connect()
}, 60_000)
afterAll(async () => {
  await setup(db)
  client.release()
  await db.end()
})

describe('1. measured set', () => {
  it('reads NULL outside the measured set and 0 only for measured accounts with none', async () => {
    const [{ measured }] = (await rows<{ measured: number }>(db, 'SELECT count(*)::int AS measured FROM silver.measured_accounts')) as [{ measured: number }]
    const g = tally(await connectionsGuarded(db))
    expect(g.unmeasured).toBe(300 - measured)
    expect(g.zero).toBeGreaterThan(0)
    expect(g.zero + g.positive).toBe(measured)
    // The trap is real: the naive join calls every unmeasured account a zero.
    expect(tally(await connectionsBroken(db)).zero).toBe(g.zero + g.unmeasured)
  })
  it('flags a column that is 0 on every row', () => {
    expect(allZero([0, 0, 0, 0, 0])).toBe(true)
    expect(allZero([0, 0, 0, 0, 1])).toBe(false)
    expect(allZero([0, 0])).toBe(false)
  })
})

describe('2. fan-out and grain', () => {
  it('refuses a result whose declared grain does not hold', async () => {
    await expect(runAtGrain(db, plans.CONTRACTS_WITH_DEALS, 'contract_id')).rejects.toBeInstanceOf(FanOutError)
    const pinned = await runAtGrain(db, plans.CONTRACTS_PINNED, 'contract_id')
    expect(pinned.rowCount).toBe(pinned.distinctKeys)
  })
  it('refuses a sum across a shared-parent join even when the row grain holds', async () => {
    const perAccount = await runAtGrain(db, plans.VALUE_PER_ACCOUNT_BROKEN, 'account_id')
    expect(perAccount.rowCount).toBe(perAccount.distinctKeys) // the row check cannot see it
    const verdicts = checkAggregates(plans.MODEL, plans.VALUE_PER_ACCOUNT_BROKEN_SHAPE)
    expect(verdicts.map((v) => v.ok)).toEqual([false, false])
  })
  it('lets a GROUP BY on one side pin it, and allows only what is safe on the other', () => {
    const shape = (aggregates: typeof plans.CONTRACTS_PINNED_SHAPE.aggregates) => ({ ...plans.CONTRACTS_PINNED_SHAPE, aggregates })
    const ok = (fn: 'sum' | 'avg' | 'max' | 'count', column: string) => checkAggregates(plans.MODEL, shape([{ fn, column }]))[0]!.ok
    expect(ok('count', 'deals.deal_id')).toBe(true) // contracts pinned: deals not repeated
    expect(ok('max', 'contracts.value')).toBe(true)
    expect(ok('avg', 'contracts.value')).toBe(true) // grouped by contracts' own key
    expect(ok('sum', 'contracts.value')).toBe(false) // still repeated once per deal
  })
})

describe('3. population ledger', () => {
  it('prints every step, flags a join that dropped rows, and reconciles', async () => {
    const broken = await runLedger<{ account_id: number }>(client, plans.CUSTOMERS, plans.WEAK_ADOPTION_BROKEN)
    expect(broken.flags.map((f) => [f.step, f.flag])).toEqual([['join active users', 'enrich step dropped rows']])
    expect(broken.lines[0]!.reason).toMatch(/no row in active_users/)

    const fixed = await runLedger<{ account_id: number }>(client, plans.CUSTOMERS, plans.WEAK_ADOPTION_GUARDED)
    expect(fixed.flags).toEqual([])
    expect(fixed.text).toMatch(/join active users\s+entered\s+\d+\s+kept\s+\d+\s+dropped\s+0\s+nothing dropped/)
    expect(fixed.rows.length).toBe(broken.rows.length + broken.lines[0]!.dropped)
    expect(fixed.text).not.toMatch(/DOES NOT RECONCILE/)
  })
  it('flags an enrich step that fans out', async () => {
    const ledger = await runLedger(client, { name: 'account', key: 'account_id', base: 'SELECT account_id FROM semantic.accounts' }, [
      { name: 'join contracts', kind: 'enrich', reason: 'no contract', sql: (p) => `SELECT p.account_id, c.contract_id FROM ${p} p JOIN semantic.contracts c USING (account_id)` },
    ])
    expect(ledger.flags[0]?.flag).toBe('fan-out')
  })
})

describe('4. negative duration', () => {
  it('finds onboarding that runs backwards, and nothing in contract terms', async () => {
    const [onboarding, term] = DURATIONS
    const bad = await negativeDurations(db, onboarding!)
    expect(bad.length).toBeGreaterThan(0)
    expect(bad.every((r) => r.days < 0)).toBe(true)
    expect(await negativeDurations(db, term!)).toEqual([])
  })
})

describe('5. stale vs frozen', () => {
  const invoices = SOURCES.find((s) => s.table === 'bronze.invoices')!
  it('passes stale and fires frozen on a feed whose copy moves and content does not', async () => {
    expect((await staleCheck(db, invoices, AS_OF_TS)).ok).toBe(true)
    const frozen = (await frozenCheck(db, invoices, AS_OF_TS))!
    expect(frozen.ok).toBe(false)
    expect(frozen.detail).toMatch(/195 days old.*1 future-dated row ignored/) // without the cut the future row reads fresh
  })
  it('requires a written reason for a source with no content column', () => {
    // @ts-expect-error contentColumn null without noContentReason does not type-check
    const missing: Source = { table: 't', loadedAtColumn: 'x', staleAfterHours: 1, contentColumn: null }
    expect(() => validateSource(missing)).toThrow(/no written reason/)
    for (const s of SOURCES) expect(() => validateSource(s)).not.toThrow()
  })
})

describe('6. janitor cards', () => {
  it('keeps one open card per check, applies an approved fix only if the check then passes', async () => {
    await setup(db)
    await db.query('TRUNCATE public.janitor_recommendations RESTART IDENTITY')
    const first = await janitorRun(db, AS_OF_TS)
    const second = await janitorRun(db, AS_OF_TS)
    expect(first.opened.map((c) => c.check_name).sort()).toEqual(['bronze.invoices.frozen', 'onboarding.negative_duration'])
    expect(second.opened).toEqual([])
    await expect(
      db.query(`INSERT INTO public.janitor_recommendations (check_name, finding, opened_at) VALUES ('bronze.invoices.frozen', 'x', now())`)
    ).rejects.toMatchObject({ code: '23505' })

    const frozen = first.opened.find((c) => c.check_name === 'bronze.invoices.frozen')!
    await expect(approve(client, frozen.id, 'tester', AS_OF_TS)).rejects.toThrow(/no registered fix/)
    const card = first.opened.find((c) => c.check_name === 'onboarding.negative_duration')!
    const done = await approve(client, card.id, 'tester', AS_OF_TS)
    expect(done).toMatchObject({ status: 'fixed', decided_by: 'tester' })
    expect(await negativeDurations(db, DURATIONS[0]!)).toEqual([])
    expect((await janitorRun(db, AS_OF_TS)).opened).toEqual([])
  })
})

describe('review follow-ups', () => {
  const shape = (s: Partial<typeof plans.CONTRACTS_PINNED_SHAPE>) => ({ ...plans.CONTRACTS_PINNED_SHAPE, ...s })
  const verdict = (s: Partial<typeof plans.CONTRACTS_PINNED_SHAPE>) => checkAggregates(plans.MODEL, shape(s))[0]!

  it('sees two children repeat each other when joined through their parent', () => {
    const v = verdict({
      joins: [['contracts.account_id', 'accounts.account_id'], ['accounts.account_id', 'deals.account_id']],
      groupBy: ['accounts.account_id'],
      aggregates: [{ fn: 'sum', column: 'contracts.value' }],
    })
    expect(v.ok).toBe(false)
  })
  it('refuses a sum carried down a one-to-many-to-one chain (contracts → items → metadata)', async () => {
    const [row] = (await runAtGrain<{ value: number }>(db, plans.CHAIN_SQL, 'contract_id')).rows
    expect(row!.value).toBe(200) // one contract of 100, one row, doubled: the row check cannot see it
    const v = (fn: 'sum' | 'max', column: string, extra: Partial<typeof plans.CHAIN_SHAPE> = {}) =>
      checkAggregates(plans.CHAIN_MODEL, { ...plans.CHAIN_SHAPE, ...extra, aggregates: [{ fn, column }] })[0]!.ok
    expect(v('sum', 'contracts.value')).toBe(false)
    expect(v('max', 'contracts.value')).toBe(true)
    expect(v('sum', 'items.item_id')).toBe(true) // items and metadata are one-to-one: neither is repeated
    expect(v('sum', 'item_metadata.item_id')).toBe(true)
    // One hop further: tags hang off metadata, so metadata, items and contracts are all repeated.
    const fourth = { joins: [...plans.CHAIN_SHAPE.joins, ['item_tags.item_id', 'item_metadata.item_id']] as Array<[string, string]> }
    expect(v('sum', 'item_metadata.item_id', fourth)).toBe(false)
    expect(v('sum', 'items.item_id', fourth)).toBe(false)
    expect(v('sum', 'contracts.value', fourth)).toBe(false)
  })
  it('handles a diamond: two children joined to the parent and to each other on account_id', () => {
    const joins: Array<[string, string]> = [
      ['contracts.account_id', 'accounts.account_id'],
      ['deals.account_id', 'accounts.account_id'],
      ['contracts.account_id', 'deals.account_id'],
    ]
    const v = (fn: 'sum' | 'max', column: string) =>
      verdict({ joins, groupBy: ['accounts.account_id'], aggregates: [{ fn, column }] }).ok
    expect(v('sum', 'contracts.value')).toBe(false)
    expect(v('sum', 'deals.amount')).toBe(false)
    expect(v('max', 'contracts.value')).toBe(true)
  })
  it('fails closed on a cycle it cannot prove safe', () => {
    // contracts → metadata on contract_id, metadata → accounts on account_id: really one row per
    // contract, but each pair is judged alone, and metadata joined on account_id alone could fan out.
    const model = { keys: { accounts: ['account_id'], contracts: ['contract_id'], contract_metadata: ['contract_id'] } }
    const [r] = checkAggregates(model, {
      joins: [['contracts.account_id', 'accounts.account_id'], ['contract_metadata.contract_id', 'contracts.contract_id'],
        ['contract_metadata.account_id', 'accounts.account_id']],
      groupBy: [],
      aggregates: [{ fn: 'sum', column: 'contracts.value' }],
    })
    expect(r!.ok).toBe(false)
  })
  it('refuses a relation it has no key for', () => {
    expect(() => verdict({ aggregates: [{ fn: 'sum', column: 'c.value' }] })).toThrow(/unknown relation: c/)
  })
  it('refuses AVG not grouped by its own key and COUNT of a repeated relation; allows MIN', () => {
    const perAccount = { groupBy: ['contracts.account_id'] }
    expect(verdict({ ...perAccount, aggregates: [{ fn: 'avg', column: 'contracts.value' }] }).ok).toBe(false)
    expect(verdict({ ...perAccount, aggregates: [{ fn: 'count', column: 'contracts.contract_id' }] }).ok).toBe(false)
    expect(verdict({ ...perAccount, aggregates: [{ fn: 'min', column: 'contracts.value' }] }).ok).toBe(true)
  })
  it('flags an enrich step that swaps keys, and the total stops reconciling', async () => {
    const ledger = await runLedger(client, plans.CUSTOMERS, [
      {
        name: 'swap three',
        kind: 'enrich',
        reason: 'swapped',
        sql: (p) => `SELECT CASE WHEN account_id IN (SELECT account_id FROM ${p} ORDER BY account_id LIMIT 3)
                                 THEN account_id + 100000 ELSE account_id END AS account_id FROM ${p}`,
      },
    ])
    expect(ledger.lines[0]).toMatchObject({ dropped: 3, arrived: 3, flag: 'keys arrived' })
    expect(ledger.text).toMatch(/DOES NOT RECONCILE/)
  })
  it('refuses to approve a fix that does not clear its check, leaving card and view as they were', async () => {
    await setup(db)
    await db.query('TRUNCATE public.janitor_recommendations RESTART IDENTITY')
    const card = (await janitorRun(db, AS_OF_TS)).opened.find((c) => c.check_name === 'onboarding.negative_duration')!
    const viewdef = async () => (await rows<{ d: string }>(db, `SELECT pg_get_viewdef('semantic.onboarding') AS d`))[0]!.d
    const before = await viewdef()
    const real = FIXES['onboarding.negative_duration']!
    // A fix that changes the view but keeps the backwards start date.
    FIXES['onboarding.negative_duration'] = {
      name: 'ineffective',
      apply: async (c) => {
        await c.query(`CREATE OR REPLACE VIEW semantic.onboarding AS
          SELECT account_id, name, customer_since, first_signed_on, customer_since AS onboarding_start, went_live_on,
                 (went_live_on - customer_since + 0) AS onboarding_days
          FROM silver.accounts WHERE is_customer AND went_live_on IS NOT NULL`)
      },
    }
    try {
      await expect(approve(client, card.id, 'tester', AS_OF_TS)).rejects.toThrow(/did not clear/)
    } finally {
      FIXES['onboarding.negative_duration'] = real
    }
    const [after] = await rows<{ status: string; decided_by: string | null }>(db,
      'SELECT status, decided_by FROM public.janitor_recommendations WHERE id = $1', [card.id])
    expect(after).toEqual({ status: 'open', decided_by: null })
    expect(await viewdef()).toBe(before)
  })
})
