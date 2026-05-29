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
    ├── wrangler.toml       CF worker config (account_id, D1 binding, cron trigger)
    ├── schema.sql          full table layout for fresh installs
    ├── migrations/         dated, idempotent SQL files
    │   ├── 001_reminder_method.sql
    │   ├── 002_expenses.sql
    │   ├── 003_services.sql
    │   ├── 004_upsell_and_scheduled.sql
    │   ├── 005_invoice_tracking.sql
    │   ├── 006_invoice_type.sql
    │   ├── 007_subaccount_paused.sql
    │   └── 008_ended_date.sql
    └── src/index.js        worker entry (auth + CRUD + bump logic + scheduled digest)
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
reminder_method TEXT NOT NULL DEFAULT 'whatsapp'         -- 'whatsapp' | 'email' | 'kra_invoice' | 'none' (how to remind the client)
services TEXT NOT NULL DEFAULT '[]'                      -- JSON array of service slugs
upsell_notes TEXT                                        -- free text for upsell ideas
upsell_followup_date TEXT                                -- ISO date to remind
invoice_type TEXT NOT NULL DEFAULT 'regular'             -- 'kra' | 'regular' | 'none' (how the client is invoiced — independent of reminder_method)
invoice_sent_for_next_due TEXT                           -- the next_due value an invoice was raised for; matches next_due => invoice sent for this cycle. Goes stale (auto-resets) when next_due bumps.
invoice_sent_date TEXT                                   -- the actual date the invoice was raised (for display)
subaccount_paused TEXT                                   -- date the GHL subaccount / catalog site was paused for non-payment (orthogonal to status; null = live)
catalog_api_base TEXT                                    -- catalog client's shop worker URL, for the pause-website kill switch (null for non-catalog clients)
ended_date TEXT                                          -- date the client churned / went on a break; bounds the accrual active-window (start_date THROUGH this month, then stops). Null = still running. See "Client lifecycle" below.
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
invoice_sent_on TEXT                                     -- date the invoice for this scheduled payment was raised (null = not yet)
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
ended_date TEXT                                          -- date the expense was cancelled; same accrual-window role as on clients
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
| POST | `/api/payments` | Record payment, bumps client.next_due. Accepts optional `scheduled_payment_id` to clear a scheduled item in the same call. For one-off completion: only flips status to `completed` if no unpaid scheduled remain. Clears `subaccount_paused` (service resumes) and reactivates a `status='paused'` recurring client. Auto-sets upsell_followup_date to paid_on + 3 months if not already set. |
| POST | `/api/clients/:id/subaccount` | Body `{ paused: bool }`. Pauses/resumes the client's GHL subaccount (`subaccount_paused` date). Independent of billing status — does not remove them from overdue. |
| DELETE | `/api/payments/:id` | |
| POST | `/api/clients/:id/invoice` | Body `{ sent: bool }`. Marks/unmarks the invoice for the client's current cycle. Stamps `invoice_sent_for_next_due` (= next_due) and `invoice_sent_date` (= today). |
| POST | `/api/scheduled-payments/:id/invoice` | Body `{ sent: bool }`. Marks/unmarks the invoice for a scheduled payment (`invoice_sent_on`). |
| POST | `/api/test-digest` | Manually fire the overdue/due-soon email digest (for testing). No-ops with a preview if `RESEND_API_KEY` unset. |
| POST | `/api/scheduled-payments` | Create future scheduled payment. Auto-reactivates a `completed` one-off client back to `active` (since scheduling more money contradicts "all paid"). Returns `{ scheduled_payment, client, reactivated }`. |
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
2. **Clients** — Growth KPI row (Added this month / Last 3 months / Last 12 months / All time, each click-drillable to the client list for that window). Filter pills (All / Recurring / One off with counts). Search box. Per-row actions kept lean to the frequent + reversible ones: Pay / Reminder / Pause (active) or Resume (paused/churned) / Edit (+ catalog-only buttons for shop clients). The rare or destructive actions live inside the Edit modal, not on the row: **Churn** is the Status dropdown (+ "Ended on" date), **Delete** is the bottom-left button (type-to-confirm), and **+ Schedule payment** (for staged deposit/balance billing) sits in the same action bar. Keeps the everyday row clean and stops accidental destructive clicks.
3. **Payments** — Inbound payment log.
4. **Expenses** — Recurring expenses list + recent expense payments + 3 buttons: Log payment (for recurring), + Add recurring, + Record expense (one-off shortcut that creates expense + payment in one submit).
5. **Revenue** — Accrual view. Period selector (This month / Last month / 6 months / 12 months / All time) drives 4 KPIs (Revenue / Expenses / Net / Net monthly), a 12-month bar chart with **clickable bars** (each opens that month's revenue breakdown modal), and a top-clients-in-period list whose title shows the active period (e.g. "Top clients (May 2026)").

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

**Order-independent state.** The dashboard handles both natural workflows:

- *Schedule first, then record payment.* The payment endpoint counts unpaid scheduled items at record time and keeps status `active` if any remain.
- *Record payment first, then schedule.* The payment endpoint flips status to `completed` (no scheduled exist yet), but POST `/api/scheduled-payments` checks the target client and reactivates a `completed` one-off back to `active`. Front-end shows a toast ("BKM reactivated, balance due 06 Jul").

Net result: status is correct regardless of which action the user does first. Caught the BKM Properties incident where the 40k deposit was logged before the 35k balance was scheduled, leaving the project visually "completed" with money still owed.

### Auto-suggest 3-month upsell follow-up

When a one-off completes, the worker auto-sets `upsell_followup_date = paid_on + 3 months` if the user hadn't picked one. Three months out is the sweet spot for "you've used the website for a while, time to talk about adding AI Chat / Ads / CRM." Surfaces on the dashboard with Snooze 30d / Done / Edit actions.

### Invoice tracking is per-cycle and decoupled from reminders

`invoice_type` (kra / regular / none) says HOW a client is billed; `reminder_method` says how they're nudged. These started coupled (a `kra_invoice` reminder method) and had to be split, because a client can be WhatsApp-reminded AND KRA-invoiced (OnePlumbing, Rajshyn, St. Christopher's). Per-cycle invoice state lives in `invoice_sent_for_next_due` (a staleness marker that holds the next_due value) so it auto-resets when the cycle rolls — no manual "un-invoice" step at month start.

### Subaccount pause is a flag, NOT a status (corrected)

First cut made "Suspend" set `status = 'paused'`, reusing the existing state. **That was wrong** and got reverted: setting status to paused dropped the non-payer out of the overdue list (which filters on `status = 'active'`), hiding exactly the people you most need to keep chasing. They still owe you — they belong in Overdue.

Fix: a separate `subaccount_paused` date field, independent of `status`. The "Pause sub" button (overdue recurring rows) stamps it; the client stays `active` so they remain in Overdue with a "⏸ Subaccount paused" badge. "Resume sub" clears it; recording a payment clears it automatically (service resumes) alongside the next_due bump.

The lesson (see Obsidian): two things are only "the same state" if they behave identically in *every* view. Paused-by-choice (don't bill, hide from overdue) and paused-for-nonpayment (still owed, keep in overdue) diverge in the overdue view, so they can't share a state. `status = 'paused'` now means only the intentional-break case.

Terminology: "pause" not "suspend", matching GHL.

### Client lifecycle: pause vs churn, and `ended_date` as the accrual boundary

A recurring client leaves in two flavours, and the accrual must not lose their history either way:

- **Pause** (`status='paused'`) — a temporary break, resumable. They stay in the active-client count (KPIs filter out `churned` only, not `paused`). Use for "client X is taking June off."
- **Churn** (`status='churned'`) — gone for good. Drops out of the active-client count. Their past revenue stays.

Both stop future billing (clear `next_due`) and set `ended_date`. `ended_date` is the key: `entityActiveInMonth()` treats a client as contributing to accrual from `start_date` THROUGH the month containing `ended_date`, then stops. So churning/pausing a client **keeps their pre-exit months in the revenue trend** instead of erasing them — the failure mode if you keyed accrual off live `status` alone (a churned client would vanish from every historical month).

Active-window rule (`entityActiveInMonth`):
- `start_date > month-end` → not started, skip.
- has `ended_date` → active iff `ended_date >= month-start` (counts through the end month, ignores status).
- no `ended_date`, current/future month → needs `status='active'`.
- no `ended_date`, past month → `active` OR `paused` both count (we don't track when an open-ended pause began).

**UI**: per-row **Pause** / **Resume** buttons run this in one click (set status + `ended_date` + clear `next_due`), with a live hint "Revenue counts through May 2026, then stops." Churn is the Status dropdown in Edit. **Resume** clears `ended_date`, sets a new `next_due`, status back to `active`.

Worked examples (May 2026):
- *Beauttah Kihara* got his own GHL account → churned. One 13k payment on 16 May. `ended_date` set to **31 May** (his last paid month-end), NOT his 16 June due date — see the gotcha below.
- *Rajshyn Jewellers* asked to pause FB ads + GHL for June (maybe leaving) → **paused**, not churned (slight chance they return). Sequence: send/collect the May KRA invoice first (keeps them in overdue tracking), record the payment, then Pause with `ended_date=31 May`. June shows zero, they stay on the books, one-click Resume if they come back.

**Subaccount-pause vs status-pause are different axes.** `subaccount_paused` (above) = "we switched their service off because they didn't pay, but keep billing them." `status='paused'` = "they're on an intentional break, don't bill them." A non-payer is `status='active'` + `subaccount_paused` set; a break-taker is `status='paused'` + `ended_date` set. Don't conflate.

### Daily digest is a self-notification, not client outreach

The cron-emailed overdue digest goes to the owner's own inbox, never to clients. This is the one place the app sends email automatically, and it's allowed precisely because it isn't client-facing — it doesn't violate the "no auto-send to clients" rule. Sends only when something is overdue or due within 3 days; quiet days are silent. Needs `RESEND_API_KEY`; no-ops cleanly without it.

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
- **`Cache-Control: no-store` on every worker JSON response, or `/api/data` gets browser-cached for hours.** Without it, browsers apply heuristic caching to fetch responses with no cache headers, sometimes for the whole session. Symptom: you add a new client / payment, page renders, the new entry doesn't appear in totals or charts even after logout/login (logout/login clears in-memory state but the fresh `loadData()` call still pulls a cached HTTP response). Worker fix: set `Cache-Control: no-store, no-cache, must-revalidate` in the `json()` helper. Front-end belt-and-braces: append `?_t=${Date.now()}` to GET URLs and pass `cache: 'no-store'` on the fetch.
- **Pages custom-domain ignores `_headers` for static files.** The Pages `_headers` config works on the direct `*.pages.dev` URL but a custom domain proxied through your zone applies Browser Cache TTL on top, often re-setting `max-age=14400`. Effectively: index.html, app.js, styles.css can be browser-cached for 4 hours regardless of `_headers`. Fix: append `?v=<datestamp>` to `<script>` and `<link>` tags in index.html. Bump the version when shipping a front-end change that has to land immediately. Yes, this is manual; no, CF doesn't have a better answer.
- **`new Date(y, m, 1).toISOString().slice(0, 7)` shifts the month one back in any +UTC timezone.** Nairobi is UTC+3, so local midnight on the 1st of a month is the previous day in UTC, and `toISOString()` returns the previous month's YYYY-MM. Affects every bar chart key, period boundary, and `in7`/`in30` calculation if you write naive date math. Fix: build YYYY-MM keys from local `getFullYear()` + `getMonth() + 1` directly, never via `toISOString()`. For day arithmetic, use a helper that does `new Date(y, m-1, d + n)` and reads local components back — avoid the `getTime() + n * 86400000` + `toISOString()` pattern.
- **Version badge in the corner pays for itself.** Drop an `APP_VERSION` constant in `app.js`, render it as a tiny fixed-position label bottom-right with low opacity (hovers to full). When a user reports "X is broken" but the code looks right, the first question is "what does the badge say?" — 3-second cache-vs-bug diagnosis. Worth the 10 lines.
- **Hover affordances must match click affordances.** The 12-month bar chart hover-tinted to brand orange (because the global motion system did that to every bar), so users assumed clicking would drill in. It didn't. Two paths to resolve: either drop the hover effect (no, the motion looks good) or honor the implication by wiring an onclick. We went with onclick — bars open the month's breakdown modal. Rule: anything that hovers like a button must do something on click.
- **`ended_date` is whole-month, so a mid-month due date double-counts the final payment.** Accrual credits a recurring client's full monthly amount to every calendar month where `ended_date >= month-start`. If you set `ended_date` to a client's *due date* and that date is mid-month (e.g. Beauttah's 16 June), the end month (June) gets a full month's credit on top of the previous month — the single final payment is counted twice. Set `ended_date` to the **last paid month-end** (31 May for Beauttah) so the one payment lands once. Only when the due date happens to fall on a month-end (Rajshyn's 31 May) is "due date" and "last paid month-end" the same value. The Pause/Resume modal shows a live "counts through {month}" hint precisely so this is visible before you commit.

## When to add a feature

Defaults to "no" unless a specific scenario hurts. Specifically don't add:
- Auto-send anything (email, WhatsApp) to clients. Manual on purpose. Drafts and click-to-send only.
- Multi-user / RBAC. Single-user is the right scope.
- Recurring scheduled-payment templates. If the same shape repeats, that's a recurring plan.
- Charts beyond the 12-month bar. Anything more goes in a spreadsheet export, not the UI.

If a feature crosses these lines, it probably belongs in a different tool (QuickBooks, GHL invoicing, Mailchimp, etc.) — not here.
