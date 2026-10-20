/**
 * Builds the Acme Analytics dataset from a fixed seed. Same seed, same rows, same demo output.
 *
 * Where each trap lives:
 *   - usage_coverage / usage_connections: the usage integration covers 10% of accounts (trap 1).
 *   - contracts / deals: one deal per contract plus expansion deals, so joining the two on the
 *     account makes contract-and-deal pairs (trap 2).
 *   - users: a quarter of customers have no user active in the last 30 days (trap 3).
 *   - contracts: renewed accounts have a second contract that starts after they went live, so the
 *     current contract's start is later than the go-live date (trap 4).
 *   - invoices: the copy stamp is three hours old, the newest real invoice is 195 days old, and one
 *     scheduled invoice is dated two years ahead (trap 5).
 */
import { AS_OF, connect, setup, type Db } from '../src/db.ts'

const SEED = 20250630
const ACCOUNTS = 300

// mulberry32: tiny, seedable, and the same on every platform.
let state = SEED
function rand(): number {
  state = (state + 0x6d2b79f5) | 0
  let t = state
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1))
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!

const ADJECTIVES = ['Amber', 'Brisk', 'Cobalt', 'Dapper', 'Eastern', 'Fern', 'Granite', 'Harbor', 'Indigo', 'Juniper',
  'Kestrel', 'Lumen', 'Maple', 'Northfield', 'Opal', 'Pinewood', 'Quartz', 'Russet', 'Saffron', 'Tidewater']
const NOUNS = ['Ledger', 'Orchard', 'Beacon', 'Foundry', 'Atlas', 'Compass', 'Harvest', 'Summit', 'Lantern', 'Meadow',
  'Anchor', 'Canopy', 'Quarry', 'Signal', 'Thicket']
const SUFFIXES = ['Labs', 'Works', 'Group', 'Systems', 'Partners', 'Collective', 'Co']
const FIRST = ['Avery', 'Blake', 'Casey', 'Dana', 'Emery', 'Finley', 'Gray', 'Harper', 'Indra', 'Jules', 'Kai', 'Lane',
  'Morgan', 'Noel', 'Oakley', 'Parker', 'Quinn', 'Reese', 'Sage', 'Tatum']
const LAST = ['Abernathy', 'Bellweather', 'Calloway', 'Dunmore', 'Ellison', 'Fairbank', 'Galloway', 'Hollis', 'Iverson',
  'Jessup', 'Kincaid', 'Lockhart', 'Merriweather', 'Northcott', 'Ormsby', 'Pembrook']
const person = (): string => `${pick(FIRST)} ${pick(LAST)}`

const day = (offset: number): string => {
  const d = new Date(`${AS_OF}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}
const hoursAgo = (h: number): string => new Date(Date.parse(`${AS_OF}T00:00:00Z`) - h * 3_600_000).toISOString()

type Row = unknown[]
async function insert(db: Db, table: string, columns: string[], data: Row[]): Promise<void> {
  for (let i = 0; i < data.length; i += 1000) {
    const chunk = data.slice(i, i + 1000)
    const values = chunk.map((_, r) => `(${columns.map((_, c) => `$${r * columns.length + c + 1}`).join(', ')})`)
    await db.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${values.join(', ')}`, chunk.flat())
  }
}

export async function generate(db: Db): Promise<Record<string, number>> {
  state = SEED
  await setup(db)
  await db.query(`TRUNCATE bronze.accounts, bronze.contracts, bronze.deals, bronze.go_lives, bronze.users,
                  bronze.usage_coverage, bronze.usage_connections, bronze.invoices, bronze.plans`)
  const load = hoursAgo(3) // every table was "copied" three hours before AS_OF

  const accounts: Row[] = [], contracts: Row[] = [], deals: Row[] = [], goLives: Row[] = []
  const users: Row[] = [], coverage: Row[] = [], connections: Row[] = [], invoices: Row[] = []
  const names = new Set<string>()
  // Ten account owners. The usage integration was piloted with one owner's book only.
  const owners: string[] = []
  while (owners.length < 10) { const p = person(); if (!owners.includes(p)) owners.push(p) }
  let contractId = 1000, dealId = 5000, userId = 1, connectionId = 1, invoiceId = 1

  for (let id = 1; id <= ACCOUNTS; id++) {
    let name: string
    do name = `${pick(ADJECTIVES)} ${pick(NOUNS)} ${pick(SUFFIXES)}`
    while (names.has(name))
    names.add(name)
    accounts.push([id, name, owners[id % 10]!, load])

    // First contract starts 1 to 3 years back; about one in six has since renewed into a second contract.
    const firstStart = -int(380, 1000)
    const renewed = firstStart < -380 && rand() < 0.16
    const terms = renewed ? [firstStart, firstStart + 365] : [firstStart]
    const churned = !renewed && firstStart + 365 < 0 && rand() < 0.5
    for (const [i, start] of terms.entries()) {
      const end = i === terms.length - 1 && !churned ? Math.max(start + 365, int(30, 400)) : start + 364
      const value = int(12, 90) * 1000
      contracts.push([contractId++, id, day(start), day(end), value])
      deals.push([dealId++, id, day(start - int(5, 30)), value])
    }
    // Expansion deals: extra deals on the same account, which is what makes the account join fan out.
    if (rand() < 0.3) deals.push([dealId++, id, day(firstStart + int(60, 300)), int(3, 20) * 1000])

    goLives.push([id, day(firstStart + int(20, 130))])

    // A quarter of accounts have nobody active in the last 30 days.
    const dormant = rand() < 0.25
    const engagement = int(2, 16) // reports a typical active user here views in 30 days
    for (let u = int(2, 9); u > 0; u--) {
      const active = !dormant && rand() < 0.7
      const lastActive = active ? day(-int(0, 28)) : rand() < 0.8 ? day(-int(31, 300)) : null
      users.push([userId++, id, person(), lastActive, active ? int(0, engagement) : 0])
    }

    // The usage integration: the pilot owner's book, every tenth account. Some genuinely have none.
    if (id % 10 === 0) {
      coverage.push([id, load])
      for (let c = rand() < 0.3 ? 0 : int(1, 4); c > 0; c--)
        connections.push([connectionId++, id, pick(['bank', 'card', 'payroll', 'erp']), hoursAgo(int(4, 60)), load])
    }

    // Monthly invoices that stop 195 days before AS_OF: the source froze, the copy kept running.
    for (let m = firstStart; m <= -195; m += 30) invoices.push([invoiceId++, id, day(m), int(1, 8) * 1000, load])
  }
  // One scheduled invoice two years out, which would make the frozen feed read as fresh.
  invoices.push([invoiceId++, 7, day(730), 5000, load])

  await insert(db, 'bronze.accounts', ['account_id', 'name', 'owner_name', '_loaded_at'], accounts)
  await insert(db, 'bronze.contracts', ['contract_id', 'account_id', 'start_date', 'end_date', 'value'], contracts)
  await insert(db, 'bronze.deals', ['deal_id', 'account_id', 'closed_on', 'amount'], deals)
  await insert(db, 'bronze.go_lives', ['account_id', 'went_live_on'], goLives)
  await insert(db, 'bronze.users', ['user_id', 'account_id', 'full_name', 'last_active_on', 'reports_viewed_30d'], users)
  await insert(db, 'bronze.usage_coverage', ['account_id', '_loaded_at'], coverage)
  await insert(db, 'bronze.usage_connections', ['connection_id', 'account_id', 'connector', 'last_seen_at', '_loaded_at'], connections)
  await insert(db, 'bronze.invoices', ['invoice_id', 'account_id', 'issued_on', 'amount', '_loaded_at'], invoices)
  await insert(db, 'bronze.plans', ['plan_code', 'name', '_loaded_at'],
    [['starter', 'Starter', hoursAgo(9000)], ['growth', 'Growth', hoursAgo(9000)], ['scale', 'Scale', hoursAgo(9000)]])

  return { accounts: accounts.length, contracts: contracts.length, deals: deals.length, users: users.length,
    usage_coverage: coverage.length, usage_connections: connections.length, invoices: invoices.length }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = connect()
  try {
    const counts = await generate(db)
    console.log(Object.entries(counts).map(([t, n]) => `${t}: ${n}`).join(', '))
  } finally {
    await db.end()
  }
}
