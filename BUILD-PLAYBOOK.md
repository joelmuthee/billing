# Billing Dashboard — Build Playbook

How to rebuild this billing dashboard from scratch for a new client (or a fresh personal instance). Operational guide. For the "why" and design philosophy, see `karparthy's-obisidian/wiki/concepts/billing-dashboard-build.md`.

**Reference implementation**: this repo. Live at https://billing.essenceautomations.com.

---

## What it is

A personal billing dashboard for a service business that has:
- Recurring clients (monthly / quarterly)
- One-off project clients (with optional staged payments like deposit + balance)
- Recurring business expenses (subscriptions, rent, etc.)
- Ad-hoc one-off expenses

It produces:
- Day-to-day cash view: who paid this month, who's overdue, who's due in 30 days
- Accrual view: smoothed monthly revenue, expense burn, net profit, MRR
- Per-client reminder workflows (WhatsApp click-to-send, copy-paste email drafts, KRA invoice flag)
- Upsell follow-up scheduling for one-off clients

## Stack

| Piece | Where | Role |
|---|---|---|
| HTML + CSS + JS (static) | Cloudflare Pages | The dashboard the owner sees |
| Worker (Node-style ES module) | Cloudflare Workers | API + auth |
| D1 (SQLite at the edge) | Cloudflare | Storage |

Total monthly cost on free tiers: zero. No third-party services. No email send (drafts copy to clipboard instead).

## Repo layout

```
<project>/
├── index.html              single-page shell with login + 5 tabs
├── styles.css              Vercel-inspired (Geist + shadow-as-border)
├── app.js                  all front-end logic, one global state
├── DESIGN.md               design system spec (from awesome-design-md/vercel/)
├── NOTES.md                deploy commands + day-to-day usage
├── BUILD-PLAYBOOK.md       this file
└── worker/
    ├── wrangler.toml       CF worker config (account_id, D1 binding, no cron)
    ├── schema.sql          full table layout for fresh installs
    ├── migrations/         dated, idempotent SQL files
    │   ├── 001_reminder_method.sql
    │   ├── 002_expenses.sql
    │   ├── 003_services.sql
    │   └── 004_upsell_and_scheduled.sql
    └── src/index.js        worker entry (auth + CRUD + bump logic)
```

## Data model

Five tables.

### `clients`

Both recurring and one-off clients live here. `plan` distinguishes them.

```sql
id INTEGER PK
name TEXT NOT NULL
business TEXT                                            -- optional company label
plan TEXT NOT NULL                                       -- 'monthly' | 'quarterly' | 'one-off'
amount INTEGER NOT NULL DEFAULT 0                        -- the recurring figure or project total
method TEXT                                              -- 'mpesa' | 'cheque' | 'bank' | 'cash'
phone TEXT                                               -- needed for WhatsApp reminders
email TEXT                                               -- needed for email-draft reminders
notes TEXT
start_date TEXT NOT NULL                                 -- ISO YYYY-MM-DD
next_due TEXT                                            -- ISO; null after one-off completes
status TEXT NOT NULL DEFAULT 'active'                    -- 'active' | 'paused' | 'churned' | 'completed'
reminder_method TEXT NOT NULL DEFAULT 'whatsapp'         -- 'whatsapp' | 'email' | 'kra_invoice' | 'none'
services TEXT NOT NULL DEFAULT '[]'                      -- JSON array of service slugs
upsell_notes TEXT                                        -- free text for upsell ideas
upsell_followup_date TEXT                                -- ISO date to remind
created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
```

### `payments`

Actual cash received against a client. Recording a payment auto-bumps the client's `next_due` by the plan period (1 month for monthly, 3 for quarterly, sets to null for one-off).

```sql
id INTEGER PK
client_id INTEGER NOT NULL                               -- FK clients.id ON DELETE CASCADE
amount INTEGER NOT NULL
paid_on TEXT NOT NULL                                    -- ISO
method TEXT
reference TEXT                                           -- Mpesa code, cheque #
notes TEXT
created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
```

### `scheduled_payments`

Expected future payments per client. Drives the "deposit + balance" pattern.

```sql
id INTEGER PK
client_id INTEGER NOT NULL                               -- FK clients.id ON DELETE CASCADE
amount INTEGER NOT NULL
due_date TEXT NOT NULL                                   -- ISO
description TEXT                                         -- "Website balance" etc.
paid_on TEXT                                             -- null until paid
payment_id INTEGER                                       -- FK payments.id ON DELETE SET NULL
notes TEXT
created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
```

When a payment is recorded with `scheduled_payment_id` set, the worker marks the scheduled item paid in the same transaction.

### `expenses`

Recurring (GHL, Claude, rent) or one-off (printer toner).

```sql
id INTEGER PK
name TEXT NOT NULL
category TEXT                                            -- free text
amount INTEGER NOT NULL DEFAULT 0
method TEXT
plan TEXT NOT NULL                                       -- 'monthly' | 'quarterly' | 'one-off'
start_date TEXT NOT NULL
next_due TEXT
status TEXT NOT NULL DEFAULT 'active'                    -- 'active' | 'paused' | 'cancelled' | 'completed'
notes TEXT
created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
```

### `expense_payments`

Same shape as `payments` but for expenses.

```sql
id INTEGER PK
expense_id INTEGER NOT NULL                              -- FK expenses.id ON DELETE CASCADE
amount INTEGER NOT NULL
paid_on TEXT NOT NULL
method TEXT
reference TEXT
notes TEXT
created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
```

## Worker endpoints

All require `Authorization: Bearer <ADMIN_TOKEN>` except `/api/health`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness probe (no auth) |
| POST | `/api/auth` | Sanity-check the token (used by login screen) |
| GET | `/api/data` | Single bulk fetch: clients, payments, expenses, expense_payments, scheduled_payments |
| POST | `/api/clients` | Create |
| PUT | `/api/clients/:id` | Update |
| DELETE | `/api/clients/:id` | Delete (cascades payments + scheduled) |
| POST | `/api/payments` | Record payment, bumps client.next_due. Accepts optional `scheduled_payment_id` to clear a scheduled item in the same call. For one-off completion: only flips status to `completed` if no unpaid scheduled remain. Auto-sets upsell_followup_date to paid_on + 3 months if not already set. |
| DELETE | `/api/payments/:id` | |
| POST | `/api/scheduled-payments` | Create future scheduled payment |
| PUT | `/api/scheduled-payments/:id` | Update |
| DELETE | `/api/scheduled-payments/:id` | |
| POST | `/api/expenses` | |
| PUT | `/api/expenses/:id` | |
| DELETE | `/api/expenses/:id` | |
| POST | `/api/expense-payments` | Record expense payment, bumps expense.next_due |
| DELETE | `/api/expense-payments/:id` | |

CORS is `Access-Control-Allow-Origin: *`. The bearer token is the only real boundary.

## Front-end shape

Single page, 5 tabs:

1. **Dashboard** — Cash view. KPI row (this-month / outstanding / next-30d / active count split recurring vs one-off), upcoming (clients + scheduled merged) + overdue, upsell follow-ups due, recent payments. Quick-action buttons up top: "+ Record payment", "+ Add client".
2. **Clients** — All clients with filter pills (All / Recurring / One off with counts). Per-row actions: Pay / Schedule / Edit / Delete. Delete uses type-to-confirm.
3. **Payments** — Inbound payment log.
4. **Expenses** — Recurring expenses list + recent expense payments + 3 buttons: Log payment (for recurring), + Add recurring, + Record expense (one-off shortcut that creates expense + payment in one submit).
5. **Revenue** — Accrual view. Period selector (This month / Last month / 6 months / 12 months / All time) drives 4 KPIs (Revenue / Expenses / Net / Net monthly), a 12-month bar chart, and a top-clients-in-period list.

## Key design decisions

These are non-obvious choices that shaped the build. Don't undo them without thinking about why they exist.

### Dashboard = cash, Revenue = accrual

Different views for different questions. The Dashboard answers "who actually paid me, who's late, who's due soon" using the `payments` table directly. The Revenue tab answers "what's my monthly income trend, what's net profit" using smoothed monthly contributions: a quarterly client's amount is divided by 3 and credited to every month they were active, regardless of when the cheque landed.

Without this split, the bar chart spiked every 3 months for quarterly clients and the period KPIs penalised quarterly clients whose billing happened to fall outside the window.

### Hardcoded API URL on the login screen

The worker URL never changes. Asking the user to type a 50-character URL on every fresh device was friction with no payoff. Login is just the password field.

### Password is the bearer token

No JWT, no session management, no rotation logic. The password is sent verbatim as `Authorization: Bearer <password>` on every request. Worker compares against a CF secret. To rotate, run `wrangler secret put ADMIN_TOKEN` again. For a single-user personal tool this is the right amount of security.

### Per-client reminder method

Different clients need different nudges. Some need WhatsApp (most), some need a polite email draft, some are KRA-invoiced through a separate portal (no reminder), some are paused/automatic (none). The dashboard shows the right action button per row based on `reminder_method`. Templates are in `app.js` so they can be edited without touching the worker.

### Type-to-confirm before delete

Deleting a client cascades through payments and scheduled_payments. Native `confirm()` is too easy to dismiss with reflex Enter. The modal lists exactly what disappears (count + total amount), suggests the gentler "set status to Churned" alternative, and disables the red Delete button until the user types the entity's name verbatim.

### Scheduled payments instead of recurring-with-installments

A staged one-off (deposit + balance) is modelled as a one-off client plus N rows in `scheduled_payments`. Generic: works for any "I'm expecting X amount on date Y" scenario, not just deposits. One-off status only flips to `completed` when there are no unpaid scheduled items remaining.

### Auto-suggest 3-month upsell follow-up

When a one-off completes, the worker auto-sets `upsell_followup_date = paid_on + 3 months` if the user hadn't picked one. Three months out is the sweet spot for "you've used the website for a while, time to talk about adding AI Chat / Ads / CRM." Surfaces on the dashboard with Snooze 30d / Done / Edit actions.

### Vercel design system (Geist + shadow-as-border)

`DESIGN.md` (copied from `awesome-design-md/vercel/`) is the spec. Geist Sans for everything except numbers (Geist Mono with tabular-nums). Shadow-as-border (`rgba(0,0,0,0.08) 0px 0px 0px 1px`) instead of CSS borders for cleaner card edges and smoother hover.

### No em-dashes anywhere user-facing

Replaced with comma+space, period+capital, or middle-dot. Anywhere a buyer or stakeholder would see this UI, em-dashes are the loudest "this was written by an LLM" tell. Code comments are exempt.

---

## Build a fresh instance for a new client

Assuming Cloudflare account + wrangler login + Node installed.

### 1. Fork the repo

```powershell
cd "C:\Users\Joel\Website Designs"
git clone https://github.com/joelmuthee/billing.git <new-project>
cd <new-project>
git remote remove origin
```

Create a new GitHub repo for the client and `git remote add origin <new-url>`.

### 2. Update CF identifiers

Edit `worker/wrangler.toml`:
- `name = "<new-project>-api"`
- `account_id = "<client's CF account id>"`
- `database_id` will be filled in step 4

### 3. Update front-end constants

Edit `app.js`:
- `API_BASE` to the new worker URL (you'll know it after step 6)
- `SERVICES_CATEGORIES` if the client offers a different service catalogue

Edit `index.html`:
- `<title>` and any wordmark text

### 4. Create the D1 database

```powershell
cd worker
npx wrangler d1 create <new-project>
```

Copy the `database_id` from the output into `worker/wrangler.toml`.

### 5. Apply schema

```powershell
npx wrangler d1 execute <new-project> --remote --file=schema.sql
```

`schema.sql` is the consolidated full layout (every migration baked in). Skip the migrations folder for fresh installs — that's for upgrading existing instances.

### 6. Set the admin password

```powershell
npx wrangler secret put ADMIN_TOKEN
```

Type the password the client will use to sign in. Note: don't share this in plain text — send via 1Password / equivalent.

### 7. Deploy the worker

```powershell
npx wrangler deploy
```

Note the URL printed. Update `API_BASE` in `app.js` to match.

### 8. Deploy the front-end

From the project root (not `worker/`):

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = "<client's account id>"
npx wrangler pages project create <new-project> --production-branch=master
npx wrangler pages deploy . --project-name=<new-project> --branch=master --commit-dirty=true
```

### 9. Custom subdomain (optional)

CF dashboard → Pages → `<new-project>` → Custom domains → add `billing.<client-domain>.com` (or whichever subdomain). DNS auto-provisions if the zone is on CF.

### 10. First sign-in

Open the Pages URL or custom domain, enter the password from step 6. Dashboard loads with empty state. Client adds their clients/expenses from the UI.

---

## Migrations

For upgrading an existing instance (don't run on fresh — `schema.sql` already has them baked):

```powershell
cd worker
npx wrangler d1 execute <db-name> --remote --file=migrations/<latest>.sql
```

Each migration is idempotent (uses `IF NOT EXISTS` / `ADD COLUMN`). Run them in order.

## Backup

Free, run weekly:

```powershell
npx wrangler d1 export <db-name> --remote --output=backup-$(Get-Date -Format yyyy-MM-dd).sql
```

Drop into `C:\Users\Joel\Website Backups\<project-name>\`.

## Gotchas (real ones we hit)

- **CF Pages auto-deploy from GitHub silently dies.** Don't rely on it. Every push, run the `wrangler pages deploy` command manually. Known CF bug.
- **Multiple Pages projects can coexist with the same git repo.** When the repo got renamed `clients` → `billing`, CF auto-created a NEW project tied to the new name, while our manual deploys kept hitting the old project. Custom domain pointed to the auto-created one, so deploys looked silent. Fix: always check `wrangler pages project list` and target the right project with `--project-name`.
- **D1 ALTER COLUMN is unsupported.** Schema changes need to be additive (`ADD COLUMN`), or migrate via a temp table swap. We've avoided destructive migrations so far.
- **Cache invalidation on Pages is per-deploy.** Hard refresh (Ctrl+Shift+R) needed after every front-end deploy until you bump a query string or filename hash.
- **`fd.get('field') || ''` is safer than `fd.get('field').trim()`.** When a form field is missing entirely, `.get()` returns null and `.trim()` throws. Always coerce first.

## When to add a feature

Defaults to "no" unless a specific scenario hurts. Specifically don't add:
- Auto-send anything (email, WhatsApp) to clients. Manual on purpose. Drafts and click-to-send only.
- Multi-user / RBAC. Single-user is the right scope.
- Recurring scheduled-payment templates. If the same shape repeats, that's a recurring plan.
- Charts beyond the 12-month bar. Anything more goes in a spreadsheet export, not the UI.

If a feature crosses these lines, it probably belongs in a different tool (QuickBooks, GHL invoicing, Mailchimp, etc.) — not here.
