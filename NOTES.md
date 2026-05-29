# Billing

Personal billing dashboard for tracking GHL clients (monthly, quarterly, one-off) and revenue. Vercel-inspired UI, Cloudflare Pages + Workers + D1.

**Live**: https://billing.essenceautomations.com
**Worker API**: https://clients-dashboard-api.stawisystems.workers.dev
**Repo**: https://github.com/joelmuthee/billing

## Cloudflare project naming

The repo is `billing`. The CF Pages project is also `billing` (auto-created via GitHub integration). The CF Worker is still `clients-dashboard-api` — renaming the worker would invalidate `wrangler.toml` and the bearer-token secret, so leave it.

**GitHub → Pages auto-deploy is unreliable** (silently stops after hours/days — known CF bug). Don't rely on it. Every code change needs a manual `wrangler pages deploy` from your machine. The commands below are the source of truth.

## What it does

- **Clients**: name, plan (monthly / quarterly / one-off), amount, payment method (Mpesa / cheque / bank / cash), start date, next due date, status.
- **Payments**: log every payment received. Auto-advances `next_due` by the plan period when you record a payment. One-off clients auto-flip to `completed` after first payment.
- **Dashboard**: this-month revenue, total outstanding (overdue), expected in next 30 days, active client count. Lists of upcoming dues and overdue clients with one-click "Mark paid".
- **Revenue tab**: 30-day / 6-month / 12-month / all-time totals, recurring vs one-off split, MRR (monthly + quarterly/3), 12-month bar chart, top clients in period.

## Stack

```
clients-dashboard/
├── index.html           public dashboard shell
├── styles.css           Vercel-inspired (Geist + shadow-as-border)
├── app.js               all front-end logic, single global state
├── DESIGN.md            Vercel design system spec
└── worker/
    ├── wrangler.toml    CF worker config
    ├── schema.sql       D1 schema
    └── src/index.js     worker entry (auth + CRUD + bump logic)
```

## First-time deploy

### 1. Create the D1 database

```powershell
cd worker
npx wrangler d1 create clients-dashboard
```

Copy the `database_id` it prints into `worker/wrangler.toml` (replace `REPLACE_WITH_DB_ID_AFTER_CREATE`).

### 2. Apply the schema

```powershell
npx wrangler d1 execute clients-dashboard --remote --file=schema.sql
```

### 3. Set the admin password

```powershell
npx wrangler secret put ADMIN_TOKEN
# Paste your password when prompted. This is what you'll type on the login screen.
```

### 4. Deploy the worker

```powershell
npx wrangler deploy
```

Note the worker URL it prints (e.g. `https://clients-dashboard-api.<sub>.workers.dev`). That's the **API base URL** you'll enter on the login screen.

### 5. Deploy the front-end (Cloudflare Pages)

From the project root (not `worker/`):

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = "58685495706b973821d77208248c66fc"
npx wrangler pages deploy . --project-name=billing --branch=master --commit-dirty=true
```

First run will prompt to create the Pages project. After that, the URL is `https://clients-dashboard.pages.dev`.

### 6. (Optional) Custom subdomain

In Cloudflare dashboard → Pages → clients-dashboard → Custom domains → add `billing.essenceautomations.com` (or whichever subdomain). DNS auto-provisions.

### 7. Sign in

Open the Pages URL, enter:
- **API base URL**: the worker URL from step 4
- **Password**: the secret from step 3

Both are saved to localStorage so you sign in once per browser.

## Reminders (per-client)

Each client has a **Reminder method** in the Add/Edit form:

| Method | What the row's action button does |
|---|---|
| **WhatsApp** (default) | "Remind" opens WhatsApp with a polite message pre-filled. Needs the client's phone saved. |
| **Email (copy draft)** | "Copy email" puts a subject + body in your clipboard. Paste into Gmail/your mail app and hit send. Needs the client's email saved. |
| **KRA invoice (no reminder)** | Shows a small "KRA invoice" tag instead of a reminder button. Use for clients you handle through the KRA portal — no nudge from this app. |
| **None** | No reminder button at all. Use for clients who pay on auto-pilot. |

Templates live in `app.js` → `waReminderUrl()` and `emailDraft()`. Edit them to change tone or sign-off.

## Invoice tracking (per cycle)

Separate from reminder method. Each client has an **Invoice type** in the Add/Edit form:

- **Regular invoice** (default) — standard invoice you email/hand over.
- **KRA eTIMS invoice** — raised through the KRA portal. Use for OnePlumbing, Rajshyn, St. Christopher's, etc.
- **No invoice needed** — cash/informal. No invoice badge or button shows.

On every upcoming/overdue row, before payment lands you'll see a red **"Invoice needed"** / **"KRA invoice needed"** badge plus a button (**"+ Mark invoiced"** / **"+ Mark KRA invoiced"**). When you've raised the invoice, click the button — the badge flips to green **"✓ Invoiced · DD/MM/YYYY"** showing the date you raised it. When the payment lands and `next_due` bumps to the next cycle, the flag auto-resets to "needed" for the new period.

A client can have WhatsApp reminders AND KRA invoicing — the two are independent fields.

## Pausing a non-paying client's subaccount

When a client (e.g. OnePlumbing) blows past the due date and you pause their GHL subaccount, click the red **"Pause sub"** button on their overdue row. This records that their service is off — but they **stay in the Overdue list** because they still owe you. The row shows a "⏸ Subaccount paused DD/MM" badge.

- **Resume sub** button turns it back on manually.
- Recording a payment (**Mark paid**) auto-resumes them — clears the paused flag and advances next-due in one step.

This is tracked by a `subaccount_paused` date field that's independent of billing `status`. Pausing the subaccount does NOT change status to `paused` — that would drop them out of the overdue list, which is the opposite of what you want for a non-payer. Use the status `Paused` (via the row Pause button, below) only for clients on an intentional break who genuinely shouldn't be billed.

## Client lifecycle: pause, churn, resume

When a recurring client leaves, you don't delete them — that wipes their payment history and their contribution to past revenue. Instead:

- **Pause** (row button) — a temporary break. They stay counted as a client; billing and reminders stop. Use when a client takes time off and might come back (e.g. Rajshyn pausing FB ads + GHL for June). One-click **Resume** brings them back: you pick the next due date and they're active again.
- **Churn** (Edit → Status → Churned) — gone for good. They drop out of your active-client count, but every shilling they paid stays in your revenue history.

Both set an **"Ended on"** date. That date is the accrual cut-off: the client keeps contributing to the monthly revenue trend from their start date *through the month of that date*, then stops. So your historical charts stay honest — a client who churned in May still shows in Jan–May, just not afterwards.

**Set "Ended on" to their last paid month-end, not a mid-month due date.** Revenue counts in whole months, so an end date of, say, 16 June would credit June a full month on top of May — double-counting a single final payment. Use 31 May instead. The Pause modal shows a live "Revenue counts through {month}, then stops" line so you can see which month is the last one counted. (Beauttah paid once for May → ended 31 May. Rajshyn's due date was already 31 May, so for him due-date and month-end were the same.)

To pause a client who's just paid: send + collect their current invoice first (so they stay on the overdue/upcoming list while you chase it), then hit Pause. Pausing clears their next due date, so doing it too early would drop them off the chase list.

## Daily overdue email digest

The worker runs a cron at **5am UTC = 8am Nairobi**. If anything is overdue or due in the next 3 days, it emails chat@essenceautomations.com a digest with each item's amount, days late, and invoice status. Quiet days send nothing. This is a self-notification, not client outreach.

**One-time setup** (free, ~5 min) — needed because Cloudflare can't send email:
1. Sign up at https://resend.com
2. Add `essenceautomations.com` as a sending domain → copy the 3 DNS records into Cloudflare DNS → Verify
3. Resend → API Keys → Create → copy
4. `cd worker && npx wrangler secret put RESEND_API_KEY` → paste
5. Test without waiting:
   ```powershell
   curl -X POST https://clients-dashboard-api.stawisystems.workers.dev/api/test-digest -H "Authorization: Bearer YOUR_PASSWORD"
   ```

Skip this and everything else still works — the cron no-ops without the key.

## In-app banner

When you open the dashboard, a strip at the top of the Dashboard tab summarises "N overdue · M due this week" — amber when due-soon only, red when there's overdue. Hidden on quiet days.

## Day-to-day use

- **Add a client**: Clients tab → "+ Add client". Plan + amount + start date are the only required fields. Next-due defaults to start date if blank.
- **Record a payment**: Payments tab → "+ Record payment", OR click "Pay" on any client row, OR click "Mark paid" on dashboard upcoming/overdue lists. The amount auto-fills from the client. After saving, the client's `next_due` advances by one period.
- **Mark a one-off complete**: just record the payment. Status flips to `completed` automatically.
- **Pause a non-payer's subaccount**: "Pause sub" button on their overdue row (catalog/GHL clients). They stay in Overdue (still owed). Recording a payment auto-resumes them. This is the kill-switch, NOT a billing pause — see the subaccount section above.
- **Pause a client on a break**: "Pause" button on their client row. Stops billing + reminders, keeps them in your active count, one-click "Resume" later. See "Client lifecycle" below.
- **Churn / delete a client**: both live inside **Edit** (not on the row). Churn = Status dropdown → Churned + set "Ended on". Delete = the button bottom-left of the Edit modal (type-to-confirm).
- **Narrow the Upcoming list**: the Dashboard's Upcoming card has a 3 days / 7 days / 30 days toggle for how far ahead to look.

## Re-deploy after code changes

```powershell
# Worker changes
cd worker
npx wrangler deploy

# Front-end changes
cd ..
npx wrangler pages deploy . --project-name=billing --branch=master --commit-dirty=true
```

## Schema migrations later

Edit `worker/schema.sql` for the new shape, then write a one-shot migration SQL file (e.g. `migrations/001_add_invoice_url.sql`) and run:

```powershell
npx wrangler d1 execute clients-dashboard --remote --file=migrations/001_add_invoice_url.sql
```

## Backup

```powershell
npx wrangler d1 export clients-dashboard --remote --output=backup-$(Get-Date -Format yyyy-MM-dd).sql
```

Drop the file into `C:\Users\Joel\Website Backups\clients-dashboard\`.

## Gotchas

- **Password is the bearer token.** No JWT, no rotation. If you suspect leak, run `npx wrangler secret put ADMIN_TOKEN` again to overwrite, then re-sign in everywhere.
- **One-off completion is sticky.** Once a one-off is marked `completed` by recording a payment, recording another payment won't change status back. Edit the client to flip status manually if a one-off client comes back for round two.
- **Deleting a payment does NOT roll back the client's `next_due` bump.** Edit the client to fix the date manually.
- **Churn/pause keeps history via `ended_date`; don't delete a client to "stop" them.** Delete cascades their payments and erases them from past revenue. Churn (status + "Ended on") preserves all of it. Set "Ended on" to the last paid month-end so the final payment counts once, not twice.
- **D1 free tier**: 100k reads/day, 50k writes/day. You'll never hit this for billing.
