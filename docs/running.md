# Run the example

[Back to the overview](../README.md)


Use Node 22+, pnpm 11, Git, and a dedicated disposable PostgreSQL database. Create the database
first; generators and tests rebuild example schemas. Do not point them at an application database.

```sh
export DATABASE_URL=postgres://localhost:5432/acme   # any Postgres 14+; the demo creates its own schema
pnpm i && pnpm generate && pnpm demo                  # pnpm test runs the guards' tests
```

Section 2 of the output is the one the five-minute read refers to:

```text
BROKEN   "contract value per account", sum(c.value) across the same join, GROUP BY account_id:
         300 rows for 300 accounts, so the row check PASSES; total $27,551,000.
GUARDED  declared-shape check refused sum(contracts.value): contracts rows are repeated by the join, ...
         declared-shape check refused sum(deals.amount): deals rows are repeated by the join, ...
         each side summed at its own grain, then joined: total $17,699,000 (sum of every contract: $17,699,000).
DIFF     $9,852,000 of contract value counted twice or more (1.56x). A GROUP BY on the
         account key gives one row per account and still multiplies every sum inside it.

BROKEN   contracts -> items -> item_metadata (one contract worth 100, two items, one metadata row each):
         1 row for 1 contract, so the row check PASSES; sum(c.value) = 200.
GUARDED  declared-shape check refused sum(contracts.value): contracts rows are repeated by the join, ...
```

What to notice: the row check says PASSES on both broken queries. The guard that catches them
never looks at the rows. It reads the declared shape and the declared keys. The output is identical
on every run; the full six sections are in [`docs/demo-output.md`](demo-output.md). Each
section prints BROKEN, then GUARDED, then DIFF with the reason.

The traps live in `scripts/generate.ts` (seed `20250630`, anchor date 2025-06-30): every renewed
account has a second contract and a second deal; the usage integration covers one owner's book,
accounts 10, 20, ... 300; a quarter of accounts have no user active in 30 days; invoices stop 195
days before the anchor while `_loaded_at` is three hours old; one invoice for account 7 is dated
2027-06-30. The chain example is inline `VALUES` in `src/plans.ts:CHAIN_SQL`.
