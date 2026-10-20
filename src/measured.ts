import { rows, type Db } from './db.ts'

export interface ConnectionCount {
  account_id: number
  connections: number | null
}

/**
 * The obvious query, and the bug: a LEFT JOIN from every account to a source that covers one in ten.
 * count() of an unmatched column is 0, so "never measured" and "measured, has none" print the same.
 */
export async function connectionsBroken(db: Db): Promise<ConnectionCount[]> {
  return rows(db, `
    SELECT a.account_id, count(c.connection_id)::int AS connections
    FROM silver.accounts a
    LEFT JOIN bronze.usage_connections c ON c.account_id = a.account_id
    GROUP BY a.account_id ORDER BY a.account_id`)
}

/** The guarded read: semantic.accounts counts only inside the measured set and is NULL outside it. */
export async function connectionsGuarded(db: Db): Promise<ConnectionCount[]> {
  return rows(db, `SELECT account_id, connections FROM semantic.accounts ORDER BY account_id`)
}

/**
 * A result-side check for the broken path: a numeric column that is 0 on every row of a large enough
 * result usually means the thing is not recorded, not that it never happens. Below the row minimum a
 * run of zeros is too likely to be real to report.
 */
export function allZero(values: Array<number | null>, minRows = 5): boolean {
  return values.length >= minRows && values.every((v) => v === 0)
}

export function tally(counts: ConnectionCount[]): { zero: number; positive: number; unmeasured: number } {
  return {
    zero: counts.filter((c) => c.connections === 0).length,
    positive: counts.filter((c) => (c.connections ?? 0) > 0).length,
    unmeasured: counts.filter((c) => c.connections === null).length,
  }
}
