/**
 * Runs the six traps in order. Each prints the BROKEN answer, the GUARDED answer, and the difference
 * with its reason. Reads the data `pnpm generate` wrote; resets views and the janitor table first,
 * so running it twice prints the same thing.
 */
import { AS_OF, AS_OF_TS, connect, rows, setup } from '../src/db.ts'
import { DURATIONS, medianDays, negativeDurations } from '../src/durations.ts'
import { frozenCheck, naiveFreshness, SOURCES, staleCheck } from '../src/freshness.ts'
import { checkAggregates, FanOutError, runAtGrain } from '../src/grain.ts'
import { approve, janitorRun, runChecks } from '../src/janitor.ts'
import { runLedger } from '../src/ledger.ts'
import { allZero, connectionsBroken, connectionsGuarded, tally } from '../src/measured.ts'
import * as plans from '../src/plans.ts'

const out = (s = '') => console.log(s)
const section = (n: number, title: string) => out(`\n${'='.repeat(78)}\n${n}. ${title}\n${'='.repeat(78)}`)
const label = (tag: 'BROKEN' | 'GUARDED' | 'DIFF', text: string) =>
  out(`${tag.padEnd(8)} ${text.split('\n').join('\n         ')}`)
const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`

const db = connect()
const client = await db.connect()
try {
  await setup(db)
  const [{ n }] = (await rows<{ n: number }>(db, 'SELECT count(*)::int AS n FROM bronze.accounts')) as [{ n: number }]
  if (!n) throw new Error('no data: run `pnpm generate` first')
  out(`Acme Analytics warehouse, as of ${AS_OF}: ${n} accounts.`)

  // ── 1 ──
  section(1, 'Measured set: NULL is not zero')
  const broken = await connectionsBroken(db), guarded = await connectionsGuarded(db)
  const b = tally(broken), g = tally(guarded)
  const [{ measured }] = (await rows<{ measured: number }>(db, 'SELECT count(*)::int AS measured FROM silver.measured_accounts')) as [{ measured: number }]
  // One owner's book with nothing measured: the page that read "0 connections" on every account.
  const [book] = await rows<{ owner_name: string; ids: number[] }>(db, `
    SELECT owner_name, array_agg(account_id ORDER BY account_id) AS ids FROM semantic.accounts
    GROUP BY owner_name HAVING count(connections) = 0 ORDER BY owner_name LIMIT 1`)
  const inBook = (xs: typeof broken) => xs.filter((x) => book!.ids.includes(x.account_id)).map((x) => x.connections)
  const show = (vs: Array<number | null>) => [...new Set(vs.map((v) => v ?? 'NULL'))].map((v) => `${vs.filter((x) => (x ?? 'NULL') === v).length} x ${v}`).join(', ')
  label('BROKEN', `LEFT JOIN + count(): ${b.zero} accounts show 0 connections, ${b.positive} show some, ${b.unmeasured} unknown.\n` +
    `${book!.owner_name}'s book (${book!.ids.length} accounts): ${show(inBook(broken))}` +
    (allZero(inBook(broken)) ? `\n  result check: 0 on all ${book!.ids.length} rows; is this recorded at all?` : ''))
  label('GUARDED', `measured set has ${measured} accounts: ${g.zero} with a real 0, ${g.positive} with connections; ${g.unmeasured} NULL (not measured).\n` +
    `${book!.owner_name}'s book: ${show(inBook(guarded))}`)
  label('DIFF', `${b.zero - g.zero} zeros became NULL. The usage source covers ${measured} of ${n} accounts; outside\n` +
    `that set nobody looked, so the honest answer is "unknown", and 0 is kept for the ${g.zero} that truly have none.`)

  // ── 2 ──
  section(2, 'Fan-out: unique rows can still carry doubled sums')
  const pairs = await runAtGrain(db, plans.CONTRACTS_WITH_DEALS, 'contract_id', 'annotate')
  label('BROKEN', `"each contract with its deal", joined on account_id: ${pairs.rowCount} rows, read as ${pairs.rowCount} contracts.`)
  try {
    await runAtGrain(db, plans.CONTRACTS_WITH_DEALS, 'contract_id')
  } catch (e) {
    if (!(e instanceof FanOutError)) throw e
    label('GUARDED', `runAtGrain(grain = contract_id) refused: ${e.message}`)
  }
  const pinned = await runAtGrain(db, plans.CONTRACTS_PINNED, 'contract_id')
  const pinnedVerdicts = checkAggregates(plans.MODEL, plans.CONTRACTS_PINNED_SHAPE)
  label('GUARDED', `GROUP BY c.contract_id pins the grain: ${pinned.rowCount} rows, ${pinned.distinctKeys} contracts; grain holds.\n` +
    pinnedVerdicts.map((v) => `  ${v.aggregate}: ok, ${v.reason}`).join('\n'))
  label('DIFF', `${pairs.rowCount - pinned.rowCount} rows were contract-and-deal pairs, not contracts.`)
  out()
  const perAccount = await runAtGrain<{ contract_value: number }>(db, plans.VALUE_PER_ACCOUNT_BROKEN, 'account_id')
  const brokenTotal = perAccount.rows.reduce((s, r) => s + r.contract_value, 0)
  label('BROKEN', `"contract value per account", sum(c.value) across the same join, GROUP BY account_id:\n` +
    `${perAccount.rowCount} rows for ${perAccount.distinctKeys} accounts, so the row check PASSES; total ${money(brokenTotal)}.`)
  const verdicts = checkAggregates(plans.MODEL, plans.VALUE_PER_ACCOUNT_BROKEN_SHAPE)
  const fixed = await runAtGrain<{ contract_value: number }>(db, plans.VALUE_PER_ACCOUNT_GUARDED, 'account_id')
  const fixedTotal = fixed.rows.reduce((s, r) => s + r.contract_value, 0)
  const [{ truth }] = (await rows<{ truth: number }>(db, 'SELECT sum(value)::float AS truth FROM semantic.contracts')) as [{ truth: number }]
  label('GUARDED', verdicts.filter((v) => !v.ok).map((v) => `declared-shape check refused ${v.aggregate}: ${v.reason}`).join('\n') +
    `\neach side summed at its own grain, then joined: total ${money(fixedTotal)} (sum of every contract: ${money(truth)}).`)
  label('DIFF', `${money(brokenTotal - fixedTotal)} of contract value counted twice or more (${(brokenTotal / fixedTotal).toFixed(2)}x). A GROUP BY on the\n` +
    `account key gives one row per account and still multiplies every sum inside it.`)
  out()
  const chain = await runAtGrain<{ value: number }>(db, plans.CHAIN_SQL, 'contract_id')
  label('BROKEN', `contracts -> items -> item_metadata (one contract worth 100, two items, one metadata row each):\n` +
    `${chain.rowCount} row for ${chain.distinctKeys} contract, so the row check PASSES; sum(c.value) = ${chain.rows[0]!.value}.`)
  label('GUARDED', checkAggregates(plans.CHAIN_MODEL, plans.CHAIN_SHAPE).map((v) =>
    `declared-shape check ${v.ok ? 'allowed' : 'refused'} ${v.aggregate}: ${v.reason}`).join('\n'))
  label('DIFF', `items is joined on its whole key at the next hop, but the contracts-items join alone is one-to-many.\n` +
    `Each join is judged on its own: when one fans out, every table on the other side of it is repeated.`)

  // ── 3 ──
  section(3, 'Population ledger')
  out('Question: how many customers have weak adoption (under 3 reports viewed per active user, 30 days)?')
  const [{ n: silent }] = (await rows<{ n: number }>(db, plans.WEAK_ADOPTION_SQL)) as [{ n: number }]
  label('BROKEN', `the query answers ${silent}. Nothing says who was not considered.`)
  const seen = await runLedger(client, plans.CUSTOMERS, plans.WEAK_ADOPTION_BROKEN)
  label('GUARDED', `the same plan through the ledger:\n${seen.text}`)
  const right = await runLedger(client, plans.CUSTOMERS, plans.WEAK_ADOPTION_GUARDED)
  label('GUARDED', `fixed plan (LEFT JOIN; nobody active counts as weak):\n${right.text}`)
  const lost = seen.lines[0]!.dropped
  label('DIFF', `${silent} reported where ${right.rows.length} qualify. The inner join dropped ${lost} customers with no active user,\n` +
    `the weakest adoption there is. "dropped 0" on the fixed join is the ledger saying it checked.`)

  // ── 4 ──
  section(4, 'Negative-duration check')
  const onboarding = DURATIONS.find((d) => d.name === 'onboarding')!
  const negatives = await negativeDurations(db, onboarding)
  const [{ count, min }] = (await rows<{ count: number; min: number }>(db,
    'SELECT count(*)::int AS count, min(onboarding_days)::int AS min FROM semantic.onboarding')) as [{ count: number; min: number }]
  label('BROKEN', `median onboarding (went_live_on - onboarding_start, which is customer_since): ${await medianDays(db, onboarding)} days over ${count} customers; minimum ${min} days.`)
  label('GUARDED', `duration check: ${negatives.length} of ${count} rows run backwards. Worst five:\n` +
    negatives.slice(0, 5).map((r) => `  account ${r.key}: onboarding_start ${r.start}, went_live_on ${r.end}, ${r.days} days`).join('\n') +
    `\nmedian from first_signed_on instead: ${await medianDays(db, onboarding, 'first_signed_on')} days.`)
  for (const d of DURATIONS.filter((d) => d !== onboarding))
    out(`         ${d.name}: ${(await negativeDurations(db, d)).length} rows backwards (checked, nothing found).`)
  label('DIFF', `customer_since is the CURRENT contract's start and resets at renewal, so every renewed customer\n` +
    `"went live before they became a customer". The median was taken over ${negatives.length} impossible rows.`)

  // ── 5 ──
  section(5, 'Stale vs frozen freshness')
  const invoices = SOURCES.find((s) => s.table === 'bronze.invoices')!
  const stale = await staleCheck(db, invoices, AS_OF_TS)
  const naive = await naiveFreshness(db, invoices.table, AS_OF_TS)
  const [{ max }] = (await rows<{ max: string }>(db, 'SELECT max(issued_on)::text AS max FROM bronze.invoices')) as [{ max: string }]
  label('BROKEN', `${stale.name}: ${stale.ok ? 'GREEN' : 'RED'}, ${stale.detail}.\n` +
    `auto-picked newest timestamp column: ${naive.column}, ${naive.ageDays} days old: GREEN.\n` +
    `plain max(issued_on) = ${max}, in the future: reads GREEN.`)
  const lines = []
  for (const s of SOURCES) {
    const f = await frozenCheck(db, s, AS_OF_TS)
    lines.push(f ? `${f.name}: ${f.ok ? 'GREEN' : 'RED'}, ${f.detail}` : `${s.table}: no content column, because ${'noContentReason' in s ? s.noContentReason : ''}`)
  }
  label('GUARDED', lines.join('\n'))
  label('DIFF', `the copy ran 3 hours ago and carried the same rows; the billing source stopped issuing invoices\n` +
    `months ago. Only a column the source writes, with future dates cut, can tell those apart.`)

  // ── 6 ──
  section(6, 'Janitor cards')
  await db.query('TRUNCATE public.janitor_recommendations RESTART IDENTITY')
  const failing = (await runChecks(db, AS_OF_TS)).filter((r) => !r.ok)
  out(`failing checks: ${failing.map((f) => f.name).join(', ')}`)
  const run1 = await janitorRun(db, AS_OF_TS)
  label('GUARDED', `run 1 opened ${run1.opened.length} cards:\n` +
    run1.opened.map((c) => `  #${c.id} ${c.check_name}: ${c.finding}\n      fix: ${c.fix_name ?? 'none registered (upstream)'}`).join('\n'))
  const run2 = await janitorRun(db, AS_OF_TS)
  label('GUARDED', `run 2 opened ${run2.opened.length}; already open: ${run2.alreadyOpen.join(', ')}.`)
  try {
    await db.query(`INSERT INTO public.janitor_recommendations (check_name, finding, opened_at) VALUES ('bronze.invoices.frozen', 'dup', now())`)
  } catch (e) {
    label('GUARDED', `a hand-written second open card is rejected by the index: ${(e as Error).message}`)
  }
  for (const card of run1.opened) {
    try {
      const done = await approve(client, card.id, 'reviewer on duty', AS_OF_TS)
      label('GUARDED', `approve #${done.id}: fix applied, check re-run and passing; status ${done.status}, by ${done.decided_by} at ${done.decided_at!.toISOString().slice(0, 10)}`)
    } catch (e) {
      label('GUARDED', `approve #${card.id}: refused: ${(e as Error).message}`)
    }
  }
  const run3 = await janitorRun(db, AS_OF_TS)
  const after = await rows<{ id: number; check_name: string; status: string }>(db,
    'SELECT id, check_name, status FROM public.janitor_recommendations ORDER BY id')
  label('GUARDED', `run 3 opened ${run3.opened.length}; cards now: ${after.map((c) => `#${c.id} ${c.check_name} ${c.status}`).join('; ')}`)
  label('DIFF', `without the index every nightly run files the same finding again; without the re-check an approved\n` +
    `fix that changed nothing would be marked done.`)
  await setup(db) // put the original onboarding view back for the next run
} finally {
  client.release()
  await db.end()
}
