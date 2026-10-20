# The six mechanisms in full

One section per guard: the trap, the design, the rejected alternative, the code, the test, and the
demo section that exercises it. The README carries one paragraph each; this is the depth behind
them. Full demo output is in [`demo-output.md`](demo-output.md).

Terms: the **grain** of a result is what one row is, named by a key column. The **measured set** is
the list of rows a partial source actually looked at. A **population ledger** is the per-step
record of how many rows entered, stayed and left, and why. **Stale** means our copy has stopped;
**frozen** means the source has stopped while our copy keeps running. A **card** is one failing
check turned into a to-do with an optional fix.

## 1. Aggregate check: unique rows, doubled sums

**Trap.** `src/grain.ts:runAtGrain` takes the SQL and the declared grain key and has Postgres
compute `count(*)` and `count(DISTINCT key)` over the same subquery. Unequal means fan-out: it
throws `FanOutError`, or in annotate mode returns the rows with a warning. That catches "each
contract with its deal" returning contract-and-deal pairs. It cannot catch the worse case.
`SELECT account_id, sum(c.value) ... GROUP BY account_id` over contracts joined to deals returns
one row per account, so the grain holds, and every sum is multiplied by the account's deal count.

**Design.** `src/grain.ts:checkAggregates` is a **declared-shape check**: it does not read SQL. The
caller describes the query by hand (its equality joins, GROUP BY columns and aggregates; see
`src/plans.ts`), and the check compares that description with each relation's declared key.

`multiplied()` judges one join at a time. All conditions between the same two relations form one
edge. On the edge between a and b, b **fans out** when the columns b is joined on miss part of b's
key: one a row can then match several b rows. Every relation still connected to a once that edge is
cut is then repeated, because each of its rows travels with a. A GROUP BY naming the rest of b's key
**pins** b: each group holds one of b's rows, so b fans out against nothing.

The verdicts follow from arithmetic. SUM and COUNT of a repeated relation are wrong whatever the
GROUP BY. AVG is right only when grouped by that relation's own key, because the repeated value is
then constant in the group. MIN, MAX and COUNT(DISTINCT) are unaffected. A relation with no declared
key, such as an alias, is refused rather than assumed safe. The demo's corrected per-account query
aggregates each side at its own grain before joining.

**Why per edge.** The first version pooled each relation's join columns across all its joins and
asked whether the pool covered its key. In contracts → items → item_metadata (items joined to
contracts on `items.contract_id`, to metadata on `items.item_id`), the pool for items is
`{contract_id, item_id}`, which covers its key, so the check said nothing was repeated. But the
contracts–items join on its own is one-to-many, and one contract of 100 with two items sums to 200.
The second hop joining items on its key says nothing about the first hop. Judging each edge alone
and carrying the repeat across the graph is what makes the shared-parent case (contracts and deals
both joined on `account_id`, directly or through accounts) and the chain case fall out of one rule.

**Next cases tried.** A four-table chain (tags hanging off metadata) marks metadata, items and
contracts repeated. A diamond (contracts and deals each joined to accounts and to each other on
`account_id`) refuses SUM on either child and allows MAX. A cycle is judged pair by pair, so it can
refuse a safe query: contracts → contract_metadata on `contract_id` and contract_metadata →
accounts on `account_id` is really one row per contract, but metadata joined to accounts on
`account_id` alone could fan out, and the check refuses rather than prove it. That is the stated
direction of failure: refuse, never pass.

**Rejected.** Treating "GROUP BY the key" as the fix. It fixes the row count and leaves the sums
wrong. Also rejected: correcting the sum (Looker-style symmetric aggregates). Refusing keeps the
check small and makes the author write the per-grain subquery, which is the query they meant.

**Tests.** "refuses a sum across a shared-parent join even when the row grain holds", "lets a GROUP
BY on one side pin it", "sees two children repeat each other when joined through their parent",
"refuses a sum carried down a one-to-many-to-one chain", "handles a diamond", "fails closed on a
cycle it cannot prove safe", "refuses a relation it has no key for".

**Demo.** Section 2: 552 rows for 350 contracts refused; the per-account sum passes the row check at
1.56x and the declared-shape check refuses it; the contracts → items → item_metadata chain returns
one row with 200 for a contract worth 100, and the check refuses `sum(contracts.value)`.

## 2. Measured set: NULL is not zero

**Trap.** A source that covers some accounts cannot say "zero" about the others. A `LEFT JOIN`
followed by `count()` turns "never looked" into 0, and people act on a 0.

**Design.** `src/schema.sql: silver.account_connections` has one row per account in
`silver.measured_accounts`, counted with a LEFT JOIN from the measured set to the connections.
`semantic.accounts` LEFT JOINs to it, so an account outside the set gets NULL without any COALESCE.
Inside the set a 0 is a real zero. `src/measured.ts:allZero` is the after-the-fact check for the
broken path: a numeric column that is 0 on every row of a result usually means the metric is not
recorded.

**Rejected.** A `has_usage_data` boolean next to a 0. Every consumer must remember to read the
flag, and the ones that forget still render 0. Putting the uncertainty in the value itself means a
consumer that forgets shows a blank, which is the safe failure.

**Next case.** `allZero` fires only when every row is zero; a mixed result (276 zeros, 24 non-zero)
passes it. Only the measured set fixes the mixed case. Stated in the README limits.

**Test.** "reads NULL outside the measured set and 0 only for measured accounts with none", "flags
a column that is 0 on every row".

**Demo.** Section 1: 276 zeros become 6 real zeros, 24 with connections and 270 NULL.

## 3. Population ledger

**Trap.** A join quietly narrows the population. "Weak adoption per active user" inner-joins to
active users, and every account with nobody active, the weakest adoption there is, disappears.

**Design.** `src/ledger.ts:runLedger` runs a base relation through steps. Each step declares its
kind. A `filter` exists to drop rows and must give the reason. An `enrich` step (a join that adds
columns) must keep every row and must not multiply them. Each step is materialised into a temp
table inside one transaction, and the runner prints `entered / kept / dropped / reason` for every
step and a total. It prints the line even when nothing was dropped. Dropped and arrived keys are
counted by identity (`EXCEPT` in both directions), not by subtracting totals, so a step that swaps
three accounts for three others shows 3 dropped and 3 arrived. Any arrived key is flagged and makes
the total line say it does not reconcile. An enrich step that drops rows, or any step whose rows
outnumber its keys, is flagged too.

**Rejected.** Logging only when rows are dropped. Then silence means either "checked, nothing
dropped" or "never checked", and the reader cannot tell which.

**Next case.** A step that keeps every key but changes what a row says (a join that picks the wrong
match) shows dropped 0. The ledger counts keys, not contents. Stated in the README limits.

**Tests.** "prints every step, flags a join that dropped rows, and reconciles", "flags an enrich
step that fans out", "flags an enrich step that swaps keys, and the total stops reconciling".

**Demo.** Section 3: 38 reported where 81 qualify; the ledger shows the join dropped 43.

## 4. Negative-duration check

**Trap.** `customer_since` is the current contract's start and moves forward at each renewal, so
renewed customers "went live before they became customers" and the median onboarding time is taken
over impossible rows.

**Design.** `src/durations.ts:DURATIONS` lists every pair of dates some answer subtracts;
`negativeDurations` returns the rows where the end precedes the start, worst first.

**Rejected.** Clamping negatives to zero, or excluding them from the median. Both hide the real
defect, which is that the start column means something other than what the subtraction assumes.
The check reports the rows; the fix (a janitor card) changes which date the duration starts from.

**Next case.** An account that renewed before it went live gets a shorter, still positive, wrong
onboarding time, and the check passes it. Stated in the README limits.

**Test.** "finds onboarding that runs backwards, and nothing in contract terms".

**Demo.** Section 4: 50 of 170 rows run backwards, minimum -343 days; the median from the first
contract is 71 days against 50.

## 5. Stale versus frozen

**Trap.** A copy job that runs every few hours and carries the same rows keeps the load stamp fresh
while the source has stopped producing.

**Design.** `src/freshness.ts:Source` makes every source declare a load-stamp column for
`staleCheck` and either a content column with its own window for `frozenCheck`, or
`contentColumn: null` with a written `noContentReason`. The type will not compile without the
reason. `frozenCheck` ignores values after the anchor date.

**Rejected.** Picking the content column automatically as the newest timestamp on the table.
`naiveFreshness` does that, and the demo shows it choosing `_loaded_at`: on a copied table the most
recently updated timestamp is usually one the pipeline writes. Without the future-date cut,
`max(issued_on)` is a scheduled invoice two years out and the dead feed reads as fresh.

**Next case.** The frozen check reads only the newest content date. If one account is still
invoiced while the rest stopped, the feed reads fresh. Stated in the README limits.

**Tests.** "passes stale and fires frozen on a feed whose copy moves and content does not",
"requires a written reason for a source with no content column".

**Demo.** Section 5: stale green at 3 hours; frozen red at 195 days with 1 future-dated row ignored.

## 6. Janitor cards

**Trap.** Checks that fail every night either file a duplicate every night or nothing at all, and a
proposed fix can be approved without fixing anything.

**Design.** `src/schema.sql: janitor_one_open_card_per_check` is a partial unique index on
`check_name WHERE status = 'open'`. `src/janitor.ts:janitorRun` inserts a card per failing check
with `ON CONFLICT ... DO NOTHING`, so a check that fails every night keeps one open card, and two
concurrent runs cannot both file one. The card's `finding` is the check's own output. `approve`
locks the card, applies the fix registered for that check, re-runs the check, and commits only if
it passes. Postgres DDL is transactional, so a fix that does not clear the finding leaves nothing
behind. Who approved and when are recorded on the card. A check with no registered fix (the frozen
feed) gets a card that cannot be approved: it is fixed upstream.

**Rejected.** De-duplicating in application code (select, then insert if absent). Two runs racing
each other both see "absent" and both insert.

**Next case.** The re-check proves the finding is gone, not that the fix is right: a fix that
filtered out the negative rows would also pass. Stated in the README limits.

**Tests.** "keeps one open card per check, applies an approved fix only if the check then passes",
"refuses to approve a fix that does not clear its check, leaving card and view as they were".

**Demo.** Section 6: 2 cards on run 1, 0 new on runs 2 and 3; one fix approved and applied, one
refused.
