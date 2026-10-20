# Six ways a warehouse answer is wrong without an error (draft)

*Hero image: the summary diagram from the README.*

## The synthetic failures

This example builds Acme Analytics, an invented warehouse with raw copies (bronze), conformed
tables (silver), and a semantic layer. The seeded data intentionally exhibits six failures:

- A usage source measures only part of the population, but a LEFT JOIN and count print zero for
  accounts it never measured.
- Joining contracts and deals on account multiplies rows and inflates sums.
- A ratio per active user drops every account with no active users.
- Renewed customer dates make some onboarding durations negative.
- An invoice feed has old content behind a recent load stamp.
- Failed checks need a recorded finding and a verified fix.

These are constructed demonstrations, not a report of company incidents or operating metrics.

## Alternatives the demo rejects

Rendering a zero as a dash does not repair the underlying value. A measured set distinguishes
unmeasured accounts from measured accounts with no activity.

Picking the newest timestamp automatically can select a pipeline-written load stamp. The demo
instead declares which source-written content column establishes freshness.

Adding GROUP BY makes result rows unique but leaves sums multiplied. Pooling a table's join
columns can also miss multiplication along a chain: the second hop uses the item's key, while
the first hop still repeats the contract. The guard judges each join separately and propagates
that repetition through the join graph.

## The mechanisms

1. **A measured set.** A relation that lists which accounts the partial source looked at. Inside
   it, 0 means zero. Outside it, the value is NULL.
2. **A declared grain, checked two ways.** At run time, `count(*)` against `count(DISTINCT key)`.
   Before running, a declared-shape check (the query described by hand, not parsed) that refuses `SUM` across a join whose
   other side repeats rows, even when the GROUP BY makes the rows unique.
3. **A population ledger.** Every step says what one row is and whether it may drop rows, and the
   runner prints entered, kept, dropped and why for every step, including the ones that dropped
   nothing.
4. **A duration check.** Any pair of dates some answer subtracts is declared, and backwards rows
   are reported by name.
5. **Stale and frozen as two checks.** Stale reads our load stamp. Frozen reads a content column
   each source declares, with future dates cut. A source without one says why in writing.
6. **Cards with one open per check.** A partial unique index does the de-duplication. Approving a
   card applies its fix and re-runs the check in one transaction.

## The numbers

The synthetic demo produces: a per-account sum at 1.56x that passes the row
check, and a one-contract chain that sums to 200 for a contract worth 100; 276 zeros that should be 6 zeros and 270 blanks;
552 rows for 350 contracts; 38 reported where 81 qualify; 50 of 170 onboarding times negative; an
invoice feed frozen 195 days behind a 3-hour-old load stamp.

## The limit

None of this decides what the right population is. The measured set has to come from somewhere
that knows which accounts the source covers. The ledger shows what each step removed, and a person
still has to say whether the base was the question's population. The declared-shape check reads a
declared query shape, not SQL, so it needs a parser in front of it to run on real queries.

## The repo

`trustworthy-warehouse`: link once published.
