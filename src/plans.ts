// The queries the demo and the tests share: each trap's broken form next to its guarded form.
import type { Model, QueryShape } from './grain.ts'
import type { Step } from './ledger.ts'

// ── 2. fan-out ──
export const MODEL: Model = {
  keys: { accounts: ['account_id'], contracts: ['contract_id'], deals: ['deal_id'] },
}

/** "Each contract with its deal": joined on the account, so it returns contract-and-deal pairs. */
export const CONTRACTS_WITH_DEALS = `
  SELECT c.contract_id, c.account_id, c.value, d.deal_id, d.amount
  FROM semantic.contracts c JOIN semantic.deals d ON d.account_id = c.account_id`

/** The same question with the grain pinned: one row per contract, the deals counted inside it. */
export const CONTRACTS_PINNED = `
  SELECT c.contract_id, max(c.value) AS value, count(d.deal_id)::int AS deals_on_account
  FROM semantic.contracts c JOIN semantic.deals d ON d.account_id = c.account_id
  GROUP BY c.contract_id`
export const CONTRACTS_PINNED_SHAPE: QueryShape = {
  joins: [['contracts.account_id', 'deals.account_id']],
  groupBy: ['contracts.contract_id'],
  aggregates: [{ fn: 'max', column: 'contracts.value' }, { fn: 'count', column: 'deals.deal_id' }],
}

/** "Contract value and deal amount per account": one row per account, and every sum multiplied. */
export const VALUE_PER_ACCOUNT_BROKEN = `
  SELECT c.account_id, sum(c.value) AS contract_value, sum(d.amount) AS deal_amount
  FROM semantic.contracts c JOIN semantic.deals d ON d.account_id = c.account_id
  GROUP BY c.account_id`
export const VALUE_PER_ACCOUNT_BROKEN_SHAPE: QueryShape = {
  joins: [['contracts.account_id', 'deals.account_id']],
  groupBy: ['contracts.account_id'],
  aggregates: [{ fn: 'sum', column: 'contracts.value' }, { fn: 'sum', column: 'deals.amount' }],
}
/** Each side aggregated at its own grain, then joined one-to-one on the account. */
export const VALUE_PER_ACCOUNT_GUARDED = `
  WITH c AS (SELECT account_id, sum(value) AS contract_value FROM semantic.contracts GROUP BY account_id),
       d AS (SELECT account_id, sum(amount) AS deal_amount FROM semantic.deals GROUP BY account_id)
  SELECT c.account_id, c.contract_value, d.deal_amount FROM c JOIN d ON d.account_id = c.account_id`

// ── 3. population ledger ──
export const CUSTOMERS = { name: 'customer', key: 'account_id', base: `SELECT account_id FROM semantic.accounts WHERE is_customer` }
export const WEAK_ADOPTION_SQL = `
  SELECT count(*)::int AS n FROM semantic.accounts a JOIN semantic.active_users u ON u.account_id = a.account_id
  WHERE a.is_customer AND u.reports_viewed_30d::numeric / u.active_users < 3`

export const WEAK_ADOPTION_BROKEN: Step[] = [
  {
    name: 'join active users',
    kind: 'enrich',
    reason: 'no row in active_users: nobody active in 30 days',
    sql: (p) => `SELECT p.account_id, u.active_users, u.reports_viewed_30d FROM ${p} p JOIN semantic.active_users u USING (account_id)`,
  },
  {
    name: 'under 3 reports per active user',
    kind: 'filter',
    reason: '3 or more reports per active user',
    sql: (p) => `SELECT * FROM ${p} WHERE reports_viewed_30d::numeric / active_users < 3`,
  },
]

export const WEAK_ADOPTION_GUARDED: Step[] = [
  {
    name: 'join active users',
    kind: 'enrich',
    reason: 'no row in active_users: nobody active in 30 days',
    sql: (p) => `SELECT p.account_id, coalesce(u.active_users, 0) AS active_users, coalesce(u.reports_viewed_30d, 0) AS reports_viewed_30d
                 FROM ${p} p LEFT JOIN semantic.active_users u USING (account_id)`,
  },
  {
    name: 'under 3 reports per active user',
    kind: 'filter',
    reason: '3 or more reports per active user',
    // Nobody active is the weakest adoption there is, not a row to leave out.
    sql: (p) => `SELECT * FROM ${p} WHERE active_users = 0 OR reports_viewed_30d::numeric / nullif(active_users, 0) < 3`,
  },
]

/**
 * One-to-many-to-one: contracts → items (many per contract) → item_metadata (one per item). Each
 * table is joined on a column that is some table's key, and the result is one row per contract, so
 * both the row check and a per-relation key rule pass. The contract's value is still added once per
 * item. Inline VALUES so it runs without generated data: one contract of 100, two items.
 */
export const CHAIN_MODEL: Model = {
  keys: { contracts: ['contract_id'], items: ['item_id'], item_metadata: ['item_id'], item_tags: ['tag_id'] },
}
export const CHAIN_SQL = `
  WITH contracts(contract_id, value) AS (VALUES (1, 100)),
       items(item_id, contract_id) AS (VALUES (1, 1), (2, 1)),
       item_metadata(item_id, label) AS (VALUES (1, 'a'), (2, 'b'))
  SELECT c.contract_id, sum(c.value)::int AS value
  FROM contracts c JOIN items i ON i.contract_id = c.contract_id JOIN item_metadata m ON m.item_id = i.item_id
  GROUP BY c.contract_id`
export const CHAIN_SHAPE: QueryShape = {
  joins: [['items.contract_id', 'contracts.contract_id'], ['item_metadata.item_id', 'items.item_id']],
  groupBy: ['contracts.contract_id'],
  aggregates: [{ fn: 'sum', column: 'contracts.value' }],
}
