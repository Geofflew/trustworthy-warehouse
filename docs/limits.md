# Scope and implementation limits

[Back to the overview](../README.md)


- `checkAggregates` reads a hand-written description of the query, not SQL. A real deployment needs
  a SQL parser to extract that shape. If the description is wrong, the verdict is wrong, and a CTE
  or derived table has no declared key to check against.
- The aggregate check judges each pair of joined relations alone. In a join graph with a cycle it
  can refuse a safe query: a metadata table joined to contracts on `contract_id` and to accounts on
  `account_id` really is one row per contract, and the check refuses it. It fails closed, and the
  tests pin that it refuses the repeated sum in the three-table chain, a four-table chain and a
  diamond (two children joined to their parent and to each other on `account_id`). A GROUP BY on
  an equal column of another relation (`items.contract_id` for `contracts.contract_id`) does not
  pin; only the relation's own key columns do.
- `allZero` fires only when every row is zero. A result with 276 zeros and 24 non-zero values
  passes it; only the measured set fixes the mixed case.
- `runAtGrain` runs the query twice (once for counts, once for rows): fine for answers of a few
  thousand rows, not for large exports.
- The ledger catches narrowing between steps, not a base relation that is already narrower than the
  question. It counts keys, not contents: a join that picks the wrong match shows dropped 0.
- The negative-duration check catches durations that run backwards, not ones that are wrong but
  positive.
- The frozen check reads only the newest content date; one still-invoiced account makes the feed
  read fresh. Windows are per-source judgement, not profiled.
- Cards never close themselves when a check starts passing, and nothing re-opens a fixed card on
  regression. The re-check proves the finding is gone, not that the fix is right.
- Choosing the measured set stays manual: something upstream must say which accounts the source
  covers.
