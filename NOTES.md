# Clients Dashboard

Personal billing dashboard for tracking GHL clients (monthly, quarterly, one-off) and revenue. Vercel-inspired UI, Cloudflare Pages + Workers + D1.

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
npx wrangler pages deploy . --project-name=clients-dashboard --branch=master --commit-dirty=true
```

First run will prompt to create the Pages project. After that, the URL is `https://clients-dashboard.pages.dev`.

### 6. (Optional) Custom subdomain

In Cloudflare dashboard → Pages → clients-dashboard → Custom domains → add `billing.essenceautomations.com` (or whichever subdomain). DNS auto-provisions.

### 7. Sign in

Open the Pages URL, enter:
- **API base URL**: the worker URL from step 4
- **Password**: the secret from step 3

Both are saved to localStorage so you sign in once per browser.

## Day-to-day use

- **Add a client**: Clients tab → "+ Add client". Plan + amount + start date are the only required fields. Next-due defaults to start date if blank.
- **Record a payment**: Payments tab → "+ Record payment", OR click "Pay" on any client row, OR click "Mark paid" on dashboard upcoming/overdue lists. The amount auto-fills from the client. After saving, the client's `next_due` advances by one period.
- **Mark a one-off complete**: just record the payment. Status flips to `completed` automatically.
- **Pause a client**: Edit → status → Paused. They drop out of overdue / upcoming lists but stay in the clients list.

## Re-deploy after code changes

```powershell
# Worker changes
cd worker
npx wrangler deploy

# Front-end changes
cd ..
npx wrangler pages deploy . --project-name=clients-dashboard --branch=master --commit-dirty=true
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
- **D1 free tier**: 100k reads/day, 50k writes/day. You'll never hit this for billing.
