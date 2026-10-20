# The mechanism, on one page

A warehouse answer can be arithmetically right and still wrong: it answers a narrower question
than the one asked, counts the same row twice, or reports on data that stopped arriving months ago.
None of these raise an error. Each guard below turns one of those silent failures into something
printed, refused, or filed as a card.

The warehouse has three layers. **Bronze** holds raw copies of each source. **Silver** conforms
them: one row per real thing, consistent names. **Semantic** is what people and tools query.

## 1. Measured set: NULL is not zero

A source that only covers some accounts cannot say "zero" about the others. It never looked.
A `LEFT JOIN` followed by a count turns "never looked" into 0. People act on a 0; they ask
about a blank. The guard is a relation that lists which accounts the source measured (the
**measured set**). Counts are computed only inside it, where 0 means zero. Outside it the column
is NULL. The rejected alternative is a `has_data` flag next to a 0: every consumer must remember
to read the flag, and the ones that do not still print 0.

## 2. Fan-out and grain

The **grain** of a result is what one row is, named by a key ("one row per contract,
`contract_id`"). A join that matches several rows on each side multiplies rows: contracts joined
to deals on the account produce contract-and-deal pairs that read as contracts. Two guards, because
each misses what the other catches:

- At run time, the runner is told the grain key and compares `count(*)` with
  `count(DISTINCT key)`. Unequal means fan-out, and the runner refuses or annotates.
- Before running, a declared-shape check: the query's joins, GROUP BY and aggregates are described
  by hand (not parsed from SQL) and compared with each relation's declared key, one join edge at
  a time. On an edge, a side joined on less than its whole key fans out, and the fan-out
  propagates to everything on the other side of that edge: contracts joined to items joined to
  metadata doubles the contract, even though items reaches metadata on its own key. Two children
  of one account joined on `account_id`, directly or through the account, multiply each other. A
  relation with no declared key is refused.
  `GROUP BY` on one side's key **pins** that side: within a group it is one row, so it no longer
  repeats the other side. But a `SUM` of the pinned side's own column is still multiplied by the
  other side's match count. The result has one row per account, passes the row check, and is
  wrong in every row. Only `MAX`, `MIN`, `COUNT(DISTINCT)`, or an `AVG` grouped by the summed
  relation's own key are safe there. The usual fix is to aggregate each side at its own grain before
  joining.

## 3. Population ledger

Each step of a multi-step answer declares what one row is and whether it is allowed to drop rows.
A **filter** step exists to drop rows and must say why. An **enrich** step (a join that adds
columns) must keep every row and must not multiply them. The runner prints
`entered / kept / dropped / reason` for every step, every time, and a total that reconciles.
Printing the line when nothing was dropped is the point: silence must mean "checked, nothing
dropped", never "did not check". An enrich step that drops rows is flagged, because that is a
join quietly narrowing the population the question asked about.

## 4. Durations do not run backwards

Any pair of date columns used as a length of time is declared as a duration. The check fires on
every row where the end comes before the start. A negative onboarding time means one of the two
dates does not mean what the calculation assumes, here a "customer since" date that resets at
each renewal. The average over such rows is wrong, and the check names the rows.

## 5. Stale versus frozen

**Stale** asks whether the copy is still running: the newest load stamp, which our pipeline writes.
**Frozen** asks whether the source is still producing: the newest value of a declared content
column, a fact the source writes (an invoice date, not our copy time). A copy can run every hour
and carry the same rows for half a year; stale stays green and only frozen fires. The content column
is declared per source because no rule can pick it: the timestamp that moves most on a table is
usually a pipeline stamp. Future-dated values are excluded, or one scheduled invoice two years out
makes a dead feed read as fresh. A source with no content column must say why in writing.

## 6. Janitor cards

A failing check becomes a **card**: the finding as the check reported it, plus the name of a fix if
one is registered. A partial unique index allows only one open card per check, so a check that fails
every night does not file a card every night. Approving a card runs its fix and re-runs the check in
the same transaction. If the check still fails, nothing commits. Who approved and when is recorded
on the card.
