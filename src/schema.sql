-- Acme Analytics warehouse: bronze (raw copies), silver (conformed), semantic (what people query).
-- Re-runnable: every statement is IF NOT EXISTS or CREATE OR REPLACE, so applying it again also
-- restores any view the janitor demo replaced. {{AS_OF}} is the fixed anchor date (src/db.ts).

CREATE SCHEMA IF NOT EXISTS bronze;
CREATE SCHEMA IF NOT EXISTS silver;
CREATE SCHEMA IF NOT EXISTS semantic;

-- The warehouse's "today". Fixed so every run prints the same numbers.
CREATE OR REPLACE FUNCTION silver.as_of() RETURNS date LANGUAGE sql IMMUTABLE AS $$ SELECT DATE '{{AS_OF}}' $$;

-- ── bronze ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bronze.accounts (
  account_id  int PRIMARY KEY,
  name        text NOT NULL,
  owner_name  text NOT NULL,
  _loaded_at  timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS bronze.contracts (
  contract_id int PRIMARY KEY,
  account_id  int NOT NULL,
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  value       numeric(12,2) NOT NULL
);
CREATE TABLE IF NOT EXISTS bronze.deals (
  deal_id     int PRIMARY KEY,
  account_id  int NOT NULL,
  closed_on   date NOT NULL,
  amount      numeric(12,2) NOT NULL
);
CREATE TABLE IF NOT EXISTS bronze.go_lives (
  account_id   int PRIMARY KEY,
  went_live_on date NOT NULL
);
CREATE TABLE IF NOT EXISTS bronze.users (
  user_id            int PRIMARY KEY,
  account_id         int NOT NULL,
  full_name          text NOT NULL,
  last_active_on     date,
  reports_viewed_30d int NOT NULL
);
-- The usage integration. It is installed for about one account in ten; the rest were never measured.
CREATE TABLE IF NOT EXISTS bronze.usage_coverage (
  account_id int PRIMARY KEY,
  _loaded_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS bronze.usage_connections (
  connection_id int PRIMARY KEY,
  account_id    int NOT NULL,
  connector     text NOT NULL,
  last_seen_at  timestamptz NOT NULL,
  _loaded_at    timestamptz NOT NULL
);
-- The billing feed. `_loaded_at` is our copy stamp; `issued_on` is the source's own fact.
CREATE TABLE IF NOT EXISTS bronze.invoices (
  invoice_id int PRIMARY KEY,
  account_id int NOT NULL,
  issued_on  date NOT NULL,
  amount     numeric(12,2) NOT NULL,
  _loaded_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS bronze.plans (
  plan_code  text PRIMARY KEY,
  name       text NOT NULL,
  _loaded_at timestamptz NOT NULL
);

-- ── silver ──────────────────────────────────────────────────────────────────
-- customer_since is the CURRENT contract's start, so it moves forward at every renewal. That is how
-- the source defines it; first_signed_on is the date most questions actually mean.
CREATE OR REPLACE VIEW silver.accounts AS
SELECT a.account_id,
       a.name,
       a.owner_name,
       cur.start_date                                    AS customer_since,
       first.start_date                                  AS first_signed_on,
       g.went_live_on,
       cur.end_date >= silver.as_of()                    AS is_customer
FROM bronze.accounts a
LEFT JOIN LATERAL (SELECT start_date, end_date FROM bronze.contracts c
                    WHERE c.account_id = a.account_id AND c.start_date <= silver.as_of()
                    ORDER BY start_date DESC LIMIT 1) cur ON true
LEFT JOIN LATERAL (SELECT min(start_date) AS start_date FROM bronze.contracts c
                    WHERE c.account_id = a.account_id) first ON true
LEFT JOIN bronze.go_lives g ON g.account_id = a.account_id;

-- The measured set: the accounts the usage integration covers. Membership, not the presence of a
-- connection row, is what separates "has none" from "nobody looked".
CREATE OR REPLACE VIEW silver.measured_accounts AS
SELECT account_id FROM bronze.usage_coverage;

-- One row per MEASURED account. Here, and only here, a count of 0 is a real zero.
CREATE OR REPLACE VIEW silver.account_connections AS
SELECT m.account_id, count(c.connection_id)::int AS connections
FROM silver.measured_accounts m
LEFT JOIN bronze.usage_connections c ON c.account_id = m.account_id
GROUP BY m.account_id;

-- One row per account that has at least one active user. Accounts with none have no row.
CREATE OR REPLACE VIEW silver.active_users AS
SELECT account_id,
       count(*)::int                 AS active_users,
       sum(reports_viewed_30d)::int  AS reports_viewed_30d
FROM bronze.users
WHERE last_active_on > silver.as_of() - 30
GROUP BY account_id;

-- ── semantic ────────────────────────────────────────────────────────────────
-- connections is NULL outside the measured set. A LEFT JOIN to a relation that has a row only for
-- measured accounts gives exactly that, with no COALESCE anywhere.
CREATE OR REPLACE VIEW semantic.accounts AS
SELECT a.account_id, a.name, a.owner_name, a.is_customer, a.customer_since, a.first_signed_on,
       a.went_live_on, ac.connections
FROM silver.accounts a
LEFT JOIN silver.account_connections ac ON ac.account_id = a.account_id;

-- Onboarding runs from onboarding_start to went_live_on. It reads customer_since, which is the bug the
-- negative-duration check finds; the janitor's approved fix replaces this view (src/janitor.ts).
CREATE OR REPLACE VIEW semantic.onboarding AS
SELECT account_id, name, customer_since, first_signed_on,
       customer_since                  AS onboarding_start,
       went_live_on,
       (went_live_on - customer_since) AS onboarding_days
FROM silver.accounts
WHERE is_customer AND went_live_on IS NOT NULL;

CREATE OR REPLACE VIEW semantic.contracts AS SELECT contract_id, account_id, start_date, end_date, value FROM bronze.contracts;
CREATE OR REPLACE VIEW semantic.deals AS SELECT deal_id, account_id, closed_on, amount FROM bronze.deals;

-- ── janitor ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.janitor_recommendations (
  id          bigserial PRIMARY KEY,
  check_name  text NOT NULL,
  finding     text NOT NULL,           -- copied from the check's own output, never written by hand
  fix_name    text,                    -- a registered fix, or NULL when a person must act upstream
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fixed', 'dismissed')),
  opened_at   timestamptz NOT NULL,
  decided_by  text,
  decided_at  timestamptz,
  CHECK ((status = 'open') = (decided_at IS NULL))
);
-- One open card per check. Decided cards are history and may repeat.
CREATE UNIQUE INDEX IF NOT EXISTS janitor_one_open_card_per_check
  ON public.janitor_recommendations (check_name) WHERE status = 'open';

CREATE OR REPLACE VIEW semantic.active_users AS SELECT account_id, active_users, reports_viewed_30d FROM silver.active_users;
