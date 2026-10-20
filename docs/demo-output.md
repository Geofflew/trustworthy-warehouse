# Full demo output

The complete output of `pnpm generate && pnpm demo` against a fresh Postgres database. It is
identical on every run (seed `20250630`, anchor date 2025-06-30). The README quotes only the part
its five-minute read refers to.

```text
Acme Analytics warehouse, as of 2025-06-30: 300 accounts.

==============================================================================
1. Measured set: NULL is not zero
==============================================================================
BROKEN   LEFT JOIN + count(): 276 accounts show 0 connections, 24 show some, 0 unknown.
         Emery Hollis's book (30 accounts): 30 x 0
           result check: 0 on all 30 rows; is this recorded at all?
GUARDED  measured set has 30 accounts: 6 with a real 0, 24 with connections; 270 NULL (not measured).
         Emery Hollis's book: 30 x NULL
DIFF     270 zeros became NULL. The usage source covers 30 of 300 accounts; outside
         that set nobody looked, so the honest answer is "unknown", and 0 is kept for the 6 that truly have none.

==============================================================================
2. Fan-out: unique rows can still carry doubled sums
==============================================================================
BROKEN   "each contract with its deal", joined on account_id: 552 rows, read as 552 contracts.
GUARDED  runAtGrain(grain = contract_id) refused: fan-out: declared one row per contract_id, got 552 rows for 350 distinct contract_id
GUARDED  GROUP BY c.contract_id pins the grain: 350 rows, 350 contracts; grain holds.
           max(contracts.value): ok, max is unaffected by repeated rows
           count(deals.deal_id): ok, deals rows are not repeated by any join
DIFF     202 rows were contract-and-deal pairs, not contracts.

BROKEN   "contract value per account", sum(c.value) across the same join, GROUP BY account_id:
         300 rows for 300 accounts, so the row check PASSES; total $27,551,000.
GUARDED  declared-shape check refused sum(contracts.value): contracts rows are repeated by the join, so sum(contracts.value) counts each one several times. Aggregate contracts at its own grain before joining, or use max(contracts.value) per contracts key.
         declared-shape check refused sum(deals.amount): deals rows are repeated by the join, so sum(deals.amount) counts each one several times. Aggregate deals at its own grain before joining, or use max(deals.amount) per deals key.
         each side summed at its own grain, then joined: total $17,699,000 (sum of every contract: $17,699,000).
DIFF     $9,852,000 of contract value counted twice or more (1.56x). A GROUP BY on the
         account key gives one row per account and still multiplies every sum inside it.

BROKEN   contracts -> items -> item_metadata (one contract worth 100, two items, one metadata row each):
         1 row for 1 contract, so the row check PASSES; sum(c.value) = 200.
GUARDED  declared-shape check refused sum(contracts.value): contracts rows are repeated by the join, so sum(contracts.value) counts each one several times. Aggregate contracts at its own grain before joining, or use max(contracts.value) per contracts key.
DIFF     items is joined on its whole key at the next hop, but the contracts-items join alone is one-to-many.
         Each join is judged on its own: when one fans out, every table on the other side of it is repeated.

==============================================================================
3. Population ledger
==============================================================================
Question: how many customers have weak adoption (under 3 reports viewed per active user, 30 days)?
BROKEN   the query answers 38. Nothing says who was not considered.
GUARDED  the same plan through the ledger:
           one row per customer (account_id); 170 entered
           join active users                entered  170  kept  127  dropped   43  no row in active_users: nobody active in 30 days   <-- enrich step dropped rows
           under 3 reports per active user  entered  127  kept   38  dropped   89  3 or more reports per active user
           total: 170 entered = 38 kept + 132 dropped
GUARDED  fixed plan (LEFT JOIN; nobody active counts as weak):
           one row per customer (account_id); 170 entered
           join active users                entered  170  kept  170  dropped    0  nothing dropped
           under 3 reports per active user  entered  170  kept   81  dropped   89  3 or more reports per active user
           total: 170 entered = 81 kept + 89 dropped
DIFF     38 reported where 81 qualify. The inner join dropped 43 customers with no active user,
         the weakest adoption there is. "dropped 0" on the fixed join is the ledger saying it checked.

==============================================================================
4. Negative-duration check
==============================================================================
BROKEN   median onboarding (went_live_on - onboarding_start, which is customer_since): 50 days over 170 customers; minimum -343 days.
GUARDED  duration check: 50 of 170 rows run backwards. Worst five:
           account 140: onboarding_start 2024-05-05, went_live_on 2023-05-28, -343 days
           account 35: onboarding_start 2024-06-14, went_live_on 2023-07-09, -341 days
           account 217: onboarding_start 2024-03-22, went_live_on 2023-04-16, -341 days
           account 74: onboarding_start 2024-05-21, went_live_on 2023-06-17, -339 days
           account 289: onboarding_start 2024-04-15, went_live_on 2023-05-12, -339 days
         median from first_signed_on instead: 71 days.
         contract_term: 0 rows backwards (checked, nothing found).
DIFF     customer_since is the CURRENT contract's start and resets at renewal, so every renewed customer
         "went live before they became a customer". The median was taken over 50 impossible rows.

==============================================================================
5. Stale vs frozen freshness
==============================================================================
BROKEN   bronze.invoices.stale: GREEN, newest _loaded_at is 3 hours old, limit 36.
         auto-picked newest timestamp column: _loaded_at, 0 days old: GREEN.
         plain max(issued_on) = 2027-06-30, in the future: reads GREEN.
GUARDED  bronze.invoices.frozen: RED, newest issued_on is 195 days old, limit 45 (1 future-dated row ignored)
         bronze.usage_connections.frozen: GREEN, newest last_seen_at is 0 days old, limit 7
         bronze.plans: no content column, because reference list of plan names, edited by hand a few times a year; nothing in it records when
DIFF     the copy ran 3 hours ago and carried the same rows; the billing source stopped issuing invoices
         months ago. Only a column the source writes, with future dates cut, can tell those apart.

==============================================================================
6. Janitor cards
==============================================================================
failing checks: bronze.invoices.frozen, onboarding.negative_duration
GUARDED  run 1 opened 2 cards:
           #1 bronze.invoices.frozen: newest issued_on is 195 days old, limit 45 (1 future-dated row ignored)
               fix: none registered (upstream)
           #2 onboarding.negative_duration: 50 rows of semantic.onboarding have went_live_on before onboarding_start; worst -343 days (account_id 140)
               fix: measure onboarding from the first contract
GUARDED  run 2 opened 0; already open: bronze.invoices.frozen, onboarding.negative_duration.
GUARDED  a hand-written second open card is rejected by the index: duplicate key value violates unique constraint "janitor_one_open_card_per_check"
GUARDED  approve #1: refused: card 1 (bronze.invoices.frozen) has no registered fix; it needs a person upstream
GUARDED  approve #2: fix applied, check re-run and passing; status fixed, by reviewer on duty at 2025-06-30
GUARDED  run 3 opened 0; cards now: #1 bronze.invoices.frozen open; #2 onboarding.negative_duration fixed
DIFF     without the index every nightly run files the same finding again; without the re-check an approved
         fix that changed nothing would be marked done.
```
