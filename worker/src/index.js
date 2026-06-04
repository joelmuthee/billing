// Billing API — Cloudflare Worker + D1
//
// Endpoints (all JSON unless noted):
//   GET    /api/health                 → liveness
//   POST   /api/auth                   → { ok: true } if token valid (used by login screen)
//   GET    /api/data                   → { clients, payments } — single bulk fetch
//   POST   /api/clients                → create client
//   PUT    /api/clients/:id            → update client
//   DELETE /api/clients/:id            → delete client (cascades payments)
//   POST   /api/payments               → record payment, auto-bump client.next_due
//                                        Accepts optional scheduled_payment_id to link.
//   DELETE /api/payments/:id           → delete payment
//   POST   /api/scheduled-payments     → create scheduled future payment for a client
//   PUT    /api/scheduled-payments/:id → update
//   DELETE /api/scheduled-payments/:id → delete
//   POST   /api/expenses               → create expense
//   PUT    /api/expenses/:id           → update expense
//   DELETE /api/expenses/:id           → delete expense (cascades payments)
//   POST   /api/expense-payments       → record expense payment, auto-bump next_due
//   DELETE /api/expense-payments/:id   → delete expense payment
//
// Auth: every endpoint except /api/health requires `Authorization: Bearer <ADMIN_TOKEN>`.
// Set the token: npx wrangler secret put ADMIN_TOKEN

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      ...CORS,
      ...extra,
    },
  });

const isAuthed = (req, env) => {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  return env.ADMIN_TOKEN && auth.slice(7).trim() === env.ADMIN_TOKEN;
};

const PLANS = ["monthly", "quarterly", "one-off"];
const STATUSES = ["active", "paused", "churned", "completed"];
const EXPENSE_STATUSES = ["active", "paused", "cancelled", "completed"];
const REMINDER_METHODS = ["whatsapp", "email", "kra_invoice", "none"];
const INVOICE_TYPES = ["kra", "regular", "none"];

// Advance an ISO date (YYYY-MM-DD) by N months. Returns YYYY-MM-DD.
// Handles month-end overflow: 2026-01-31 + 1 month → 2026-02-28.
function addMonths(isoDate, months) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  target.setUTCDate(day);
  return target.toISOString().slice(0, 10);
}

function periodMonths(plan) {
  if (plan === "monthly") return 1;
  if (plan === "quarterly") return 3;
  return 0;
}

function bumpNextDue(plan, currentNextDue, paidOn) {
  if (plan === "one-off") return null;
  const base = currentNextDue || paidOn;
  return addMonths(base, periodMonths(plan));
}

async function readBody(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function validateClient(c) {
  if (!c || typeof c !== "object") return "body must be an object";
  if (!c.name || typeof c.name !== "string") return "name is required";
  if (!PLANS.includes(c.plan)) return `plan must be one of ${PLANS.join(", ")}`;
  if (!c.start_date || !/^\d{4}-\d{2}-\d{2}$/.test(c.start_date)) return "start_date must be YYYY-MM-DD";
  if (c.next_due && !/^\d{4}-\d{2}-\d{2}$/.test(c.next_due)) return "next_due must be YYYY-MM-DD";
  if (c.amount != null && (typeof c.amount !== "number" || c.amount < 0)) return "amount must be a non-negative number";
  if (c.status && !STATUSES.includes(c.status)) return `status must be one of ${STATUSES.join(", ")}`;
  if (c.reminder_method && !REMINDER_METHODS.includes(c.reminder_method)) {
    return `reminder_method must be one of ${REMINDER_METHODS.join(", ")}`;
  }
  if (c.upsell_followup_date && !/^\d{4}-\d{2}-\d{2}$/.test(c.upsell_followup_date)) {
    return "upsell_followup_date must be YYYY-MM-DD";
  }
  if (c.invoice_type && !INVOICE_TYPES.includes(c.invoice_type)) {
    return `invoice_type must be one of ${INVOICE_TYPES.join(", ")}`;
  }
  if (c.ended_date && !/^\d{4}-\d{2}-\d{2}$/.test(c.ended_date)) {
    return "ended_date must be YYYY-MM-DD";
  }
  if (c.source_date && !/^\d{4}-\d{2}-\d{2}$/.test(c.source_date)) {
    return "source_date must be YYYY-MM-DD";
  }
  return null;
}

function validateScheduledPayment(s) {
  if (!s || typeof s !== "object") return "body must be an object";
  if (!Number.isInteger(s.client_id)) return "client_id is required";
  if (typeof s.amount !== "number" || s.amount <= 0) return "amount must be a positive number";
  if (!s.due_date || !/^\d{4}-\d{2}-\d{2}$/.test(s.due_date)) return "due_date must be YYYY-MM-DD";
  return null;
}

function parseServices(s) {
  if (!s) return [];
  try {
    const arr = JSON.parse(s);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function serializeServices(arr) {
  if (!Array.isArray(arr)) return '[]';
  return JSON.stringify(arr.filter((s) => typeof s === 'string'));
}

function validatePayment(p) {
  if (!p || typeof p !== "object") return "body must be an object";
  if (!Number.isInteger(p.client_id)) return "client_id is required";
  if (typeof p.amount !== "number" || p.amount <= 0) return "amount must be a positive number";
  if (!p.paid_on || !/^\d{4}-\d{2}-\d{2}$/.test(p.paid_on)) return "paid_on must be YYYY-MM-DD";
  return null;
}

function validateExpense(e) {
  if (!e || typeof e !== "object") return "body must be an object";
  if (!e.name || typeof e.name !== "string") return "name is required";
  if (!PLANS.includes(e.plan)) return `plan must be one of ${PLANS.join(", ")}`;
  if (!e.start_date || !/^\d{4}-\d{2}-\d{2}$/.test(e.start_date)) return "start_date must be YYYY-MM-DD";
  if (e.next_due && !/^\d{4}-\d{2}-\d{2}$/.test(e.next_due)) return "next_due must be YYYY-MM-DD";
  if (e.amount != null && (typeof e.amount !== "number" || e.amount < 0)) return "amount must be a non-negative number";
  if (e.status && !EXPENSE_STATUSES.includes(e.status)) return `status must be one of ${EXPENSE_STATUSES.join(", ")}`;
  return null;
}

const PROSPECT_STAGES = ["requested", "demo_sent", "won", "lost"];
function validateProspect(p) {
  if (!p || typeof p !== "object") return "body must be an object";
  if (!p.name || typeof p.name !== "string") return "name is required";
  if (p.stage && !PROSPECT_STAGES.includes(p.stage)) return `stage must be one of ${PROSPECT_STAGES.join(", ")}`;
  if (p.followup_date && !/^\d{4}-\d{2}-\d{2}$/.test(p.followup_date)) return "followup_date must be YYYY-MM-DD";
  if (p.source_date && !/^\d{4}-\d{2}-\d{2}$/.test(p.source_date)) return "source_date must be YYYY-MM-DD";
  return null;
}

function validateExpensePayment(p) {
  if (!p || typeof p !== "object") return "body must be an object";
  if (!Number.isInteger(p.expense_id)) return "expense_id is required";
  if (typeof p.amount !== "number" || p.amount <= 0) return "amount must be a positive number";
  if (!p.paid_on || !/^\d{4}-\d{2}-\d{2}$/.test(p.paid_on)) return "paid_on must be YYYY-MM-DD";
  return null;
}

// Generate a polite, personalized WhatsApp payment reminder via Workers AI.
// stage: "before" (≈3 days out) | "due" (due today) | "paused" (overdue, site offline).
async function generateReminder(env, client, stage) {
  const amount = `Ksh ${Number(client.amount || 0).toLocaleString("en-US")}`;
  const planWord = client.plan === "monthly" ? "monthly" : client.plan === "quarterly" ? "quarterly" : "one-off";
  const stageCtx = {
    before: "Their payment is due in about 3 days. This is a gentle, friendly early heads-up, nothing urgent.",
    due: "Their payment is due today. Give a warm, polite nudge.",
    paused: "Their payment is now overdue and, as a result, their website is temporarily paused and offline. Politely and warmly let them know the site is paused for now and will be switched back on as soon as the payment comes through. Stay kind, never harsh.",
  }[stage] || "Their payment is coming up soon. Send a friendly reminder.";
  const sys = "You write short, warm, professional WhatsApp payment-reminder messages for Joel of Essence Automations (a Kenyan web-design agency) to send to his clients. Rules: plain text only, no markdown, NO dashes of any kind (use commas or full stops), 2 to 4 short sentences, friendly and respectful, never aggressive or robotic. Currency is Kenyan Shillings (Ksh). Address the client by their business name naturally. End with a short sign-off from Joel, Essence Automations. Output ONLY the message text: no preamble, no surrounding quotes, no notes.";
  const user = `Client business: ${client.business || client.name}. Service: their catalogue website. Amount due: ${amount} (${planWord} plan). Due date: ${client.next_due || "soon"}. Situation: ${stageCtx}`;
  const r = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [{ role: "system", content: sys }, { role: "user", content: user }],
    max_tokens: 240,
  });
  let msg = (typeof r.response === "string" ? r.response : "").trim();
  msg = msg.replace(/^["'“”]+|["'“”]+$/g, "").trim();
  msg = msg.replace(/^(sure[,!]?\s*)?here(?:'?s| is)[^\n:]*:\s*/i, "").trim();
  msg = msg.replace(/[—–‒]/g, ", "); // strip em/en dashes per house style
  if (!/essence\s*automations/i.test(msg)) msg += "\n\nJoel, Essence Automations";
  return msg;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/health") {
      return json({ ok: true, time: new Date().toISOString() });
    }

    // All routes below require auth
    if (!isAuthed(request, env)) {
      return json({ error: "unauthorized" }, 401);
    }

    // The browser does the catalog suspend call directly (a worker→worker fetch to a
    // same-zone *.workers.dev hits Cloudflare error 1042). This hands the master token
    // to the already-authenticated billing session so the page can call /api/suspend.
    if (request.method === "GET" && path === "/api/catalog-token") {
      return json({ token: (env.MASTER_TOKEN || "").trim() });
    }

    // AI-generated payment reminder for the copy/paste-to-WhatsApp button.
    if (request.method === "POST" && path === "/api/reminder") {
      const body = await readBody(request);
      const client = await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(body.client_id).first();
      if (!client) return json({ error: "client not found" }, 404);
      const stage = ["before", "due", "paused"].includes(body.stage) ? body.stage : "due";
      try {
        return json({ message: await generateReminder(env, client, stage), stage });
      } catch (e) {
        return json({ error: "AI generation failed: " + (e && e.message || e) }, 502);
      }
    }

    if (request.method === "POST" && path === "/api/auth") {
      return json({ ok: true });
    }

    if (request.method === "GET" && path === "/api/data") {
      const clientsRs = await env.DB.prepare("SELECT * FROM clients ORDER BY name COLLATE NOCASE").all();
      const payments = await env.DB.prepare("SELECT * FROM payments ORDER BY paid_on DESC, id DESC").all();
      const expenses = await env.DB.prepare("SELECT * FROM expenses ORDER BY name COLLATE NOCASE").all();
      const expensePayments = await env.DB.prepare("SELECT * FROM expense_payments ORDER BY paid_on DESC, id DESC").all();
      const scheduled = await env.DB.prepare("SELECT * FROM scheduled_payments ORDER BY due_date ASC").all();
      const prospects = await env.DB.prepare("SELECT * FROM prospects ORDER BY created_at DESC").all();
      const clients = (clientsRs.results || []).map((c) => ({
        ...c,
        services: parseServices(c.services),
      }));
      return json({
        clients,
        payments: payments.results || [],
        expenses: expenses.results || [],
        expense_payments: expensePayments.results || [],
        scheduled_payments: scheduled.results || [],
        prospects: prospects.results || [],
      });
    }

    if (request.method === "POST" && path === "/api/clients") {
      const body = await readBody(request);
      const err = validateClient(body);
      if (err) return json({ error: err }, 400);
      const next_due = body.next_due || (body.plan === "one-off" ? null : body.start_date);
      const status = body.status || (body.plan === "one-off" ? "active" : "active");
      const result = await env.DB.prepare(
        `INSERT INTO clients (name, business, plan, amount, method, phone, email, notes, start_date, next_due, status, reminder_method, services, upsell_notes, upsell_followup_date, invoice_type, catalog_api_base, ended_date, source, source_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          body.name.trim(),
          body.business || null,
          body.plan,
          Math.round(body.amount || 0),
          body.method || null,
          body.phone || null,
          body.email || null,
          body.notes || null,
          body.start_date,
          next_due,
          status,
          body.reminder_method || "whatsapp",
          serializeServices(body.services),
          body.upsell_notes || null,
          body.upsell_followup_date || null,
          body.invoice_type || "regular",
          body.catalog_api_base || null,
          body.ended_date || null,
          body.source || null,
          body.source_date || null
        )
        .run();
      const id = result.meta.last_row_id;
      const created = await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(id).first();
      return json({ client: { ...created, services: parseServices(created.services) } }, 201);
    }

    const clientMatch = path.match(/^\/api\/clients\/(\d+)$/);
    if (clientMatch) {
      const id = Number(clientMatch[1]);
      if (request.method === "PUT") {
        const body = await readBody(request);
        const err = validateClient(body);
        if (err) return json({ error: err }, 400);
        await env.DB.prepare(
          `UPDATE clients
           SET name = ?, business = ?, plan = ?, amount = ?, method = ?, phone = ?, email = ?, notes = ?,
               start_date = ?, next_due = ?, status = ?, reminder_method = ?, services = ?,
               upsell_notes = ?, upsell_followup_date = ?, invoice_type = ?, catalog_api_base = ?, ended_date = ?,
               source = ?, source_date = ?
           WHERE id = ?`
        )
          .bind(
            body.name.trim(),
            body.business || null,
            body.plan,
            Math.round(body.amount || 0),
            body.method || null,
            body.phone || null,
            body.email || null,
            body.notes || null,
            body.start_date,
            body.next_due || null,
            body.status || "active",
            body.reminder_method || "whatsapp",
            serializeServices(body.services),
            body.upsell_notes || null,
            body.upsell_followup_date || null,
            body.invoice_type || "regular",
            body.catalog_api_base || null,
            body.ended_date || null,
            body.source || null,
            body.source_date || null,
            id
          )
          .run();
        const updated = await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(id).first();
        if (!updated) return json({ error: "not found" }, 404);
        return json({ client: { ...updated, services: parseServices(updated.services) } });
      }
      if (request.method === "DELETE") {
        await env.DB.prepare("DELETE FROM clients WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }
    }

    if (request.method === "POST" && path === "/api/payments") {
      const body = await readBody(request);
      const err = validatePayment(body);
      if (err) return json({ error: err }, 400);

      const client = await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(body.client_id).first();
      if (!client) return json({ error: "client not found" }, 404);

      // Insert payment
      const insertResult = await env.DB.prepare(
        `INSERT INTO payments (client_id, amount, paid_on, method, reference, notes)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(
          body.client_id,
          Math.round(body.amount),
          body.paid_on,
          body.method || null,
          body.reference || null,
          body.notes || null
        )
        .run();
      const paymentId = insertResult.meta.last_row_id;

      // If linked to a scheduled payment, mark it paid
      if (Number.isInteger(body.scheduled_payment_id)) {
        await env.DB.prepare(
          "UPDATE scheduled_payments SET paid_on = ?, payment_id = ? WHERE id = ? AND client_id = ?"
        )
          .bind(body.paid_on, paymentId, body.scheduled_payment_id, body.client_id)
          .run();
      }

      // Advance client.next_due (or mark one-off completed only if no unpaid scheduled remain)
      const newNextDue = bumpNextDue(client.plan, client.next_due, body.paid_on);
      let newStatus = client.status;
      // A suspended (paused) recurring client who just paid gets reactivated.
      if (client.plan !== "one-off" && client.status === "paused") {
        newStatus = "active";
      }
      if (client.plan === "one-off") {
        const remainingRs = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM scheduled_payments WHERE client_id = ? AND paid_on IS NULL"
        ).bind(body.client_id).first();
        const remaining = remainingRs ? remainingRs.n : 0;
        if (remaining === 0) {
          newStatus = "completed";
          // Suggest a 3-month upsell follow-up if not already set
          const existing = await env.DB.prepare(
            "SELECT upsell_followup_date FROM clients WHERE id = ?"
          ).bind(body.client_id).first();
          if (existing && !existing.upsell_followup_date) {
            const followup = addMonths(body.paid_on, 3);
            await env.DB.prepare("UPDATE clients SET upsell_followup_date = ? WHERE id = ?")
              .bind(followup, body.client_id).run();
          }
        }
      }
      // Recording a payment also resumes a paused GHL subaccount (they've paid).
      await env.DB.prepare("UPDATE clients SET next_due = ?, status = ?, subaccount_paused = NULL WHERE id = ?")
        .bind(newNextDue, newStatus, body.client_id)
        .run();

      const payment = await env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(paymentId).first();
      const updatedClient = await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(body.client_id).first();
      // The browser restores the catalog after recording a payment (worker→worker blocked by CF 1042).
      return json({ payment, client: updatedClient }, 201);
    }

    const paymentMatch = path.match(/^\/api\/payments\/(\d+)$/);
    if (paymentMatch && request.method === "DELETE") {
      const id = Number(paymentMatch[1]);
      await env.DB.prepare("DELETE FROM payments WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }

    // ─────────── Invoice toggle ───────────
    const clientInvoiceMatch = path.match(/^\/api\/clients\/(\d+)\/invoice$/);
    if (clientInvoiceMatch && request.method === "POST") {
      const id = Number(clientInvoiceMatch[1]);
      const body = await readBody(request);
      const client = await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(id).first();
      if (!client) return json({ error: "not found" }, 404);
      // When sent, stamp with the client's current next_due (staleness marker)
      // and today's date (for display). When unsent, clear both.
      const sent = body && body.sent;
      const stale = sent ? client.next_due : null;
      const sentDate = sent ? new Date().toISOString().slice(0, 10) : null;
      await env.DB.prepare("UPDATE clients SET invoice_sent_for_next_due = ?, invoice_sent_date = ? WHERE id = ?")
        .bind(stale, sentDate, id).run();
      const updated = await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(id).first();
      return json({ client: updated });
    }

    // Pause / resume a client's GHL subaccount (independent of billing status)
    const subaccountMatch = path.match(/^\/api\/clients\/(\d+)\/subaccount$/);
    if (subaccountMatch && request.method === "POST") {
      const id = Number(subaccountMatch[1]);
      const body = await readBody(request);
      const newValue = body && body.paused ? new Date().toISOString().slice(0, 10) : null;
      await env.DB.prepare("UPDATE clients SET subaccount_paused = ? WHERE id = ?")
        .bind(newValue, id).run();
      const updated = await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(id).first();
      if (!updated) return json({ error: "not found" }, 404);
      // The browser handles the catalog suspend call (worker→worker is blocked by CF 1042).
      return json({ client: updated });
    }

    const scheduledInvoiceMatch = path.match(/^\/api\/scheduled-payments\/(\d+)\/invoice$/);
    if (scheduledInvoiceMatch && request.method === "POST") {
      const id = Number(scheduledInvoiceMatch[1]);
      const body = await readBody(request);
      const newValue = body && body.sent ? new Date().toISOString().slice(0, 10) : null;
      await env.DB.prepare("UPDATE scheduled_payments SET invoice_sent_on = ? WHERE id = ?")
        .bind(newValue, id).run();
      const updated = await env.DB.prepare("SELECT * FROM scheduled_payments WHERE id = ?").bind(id).first();
      if (!updated) return json({ error: "not found" }, 404);
      return json({ scheduled_payment: updated });
    }

    // ─────────── Scheduled payments ───────────

    if (request.method === "POST" && path === "/api/scheduled-payments") {
      const body = await readBody(request);
      const err = validateScheduledPayment(body);
      if (err) return json({ error: err }, 400);
      const result = await env.DB.prepare(
        `INSERT INTO scheduled_payments (client_id, amount, due_date, description, notes)
         VALUES (?, ?, ?, ?, ?)`
      )
        .bind(
          body.client_id,
          Math.round(body.amount),
          body.due_date,
          body.description || null,
          body.notes || null
        )
        .run();
      const id = result.meta.last_row_id;

      // If this scheduled payment is being added to a completed one-off
      // client, reactivate them, since "more money expected" contradicts
      // "completed". Catches the case where a user records the first
      // payment of an installment project before adding the balance schedule.
      const client = await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(body.client_id).first();
      let reactivated = false;
      if (client && client.plan === "one-off" && client.status === "completed") {
        await env.DB.prepare("UPDATE clients SET status = 'active' WHERE id = ?").bind(body.client_id).run();
        reactivated = true;
      }

      const created = await env.DB.prepare("SELECT * FROM scheduled_payments WHERE id = ?").bind(id).first();
      const updatedClient = reactivated
        ? await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(body.client_id).first()
        : client;
      return json({ scheduled_payment: created, client: updatedClient, reactivated }, 201);
    }

    const scheduledMatch = path.match(/^\/api\/scheduled-payments\/(\d+)$/);
    if (scheduledMatch) {
      const id = Number(scheduledMatch[1]);
      if (request.method === "PUT") {
        const body = await readBody(request);
        const err = validateScheduledPayment(body);
        if (err) return json({ error: err }, 400);
        await env.DB.prepare(
          `UPDATE scheduled_payments
           SET client_id = ?, amount = ?, due_date = ?, description = ?, notes = ?
           WHERE id = ?`
        )
          .bind(
            body.client_id,
            Math.round(body.amount),
            body.due_date,
            body.description || null,
            body.notes || null,
            id
          )
          .run();
        const updated = await env.DB.prepare("SELECT * FROM scheduled_payments WHERE id = ?").bind(id).first();
        if (!updated) return json({ error: "not found" }, 404);
        return json({ scheduled_payment: updated });
      }
      if (request.method === "DELETE") {
        await env.DB.prepare("DELETE FROM scheduled_payments WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }
    }

    // ─────────── Expenses ───────────

    if (request.method === "POST" && path === "/api/expenses") {
      const body = await readBody(request);
      const err = validateExpense(body);
      if (err) return json({ error: err }, 400);
      const next_due = body.next_due || (body.plan === "one-off" ? null : body.start_date);
      const status = body.status || "active";
      const result = await env.DB.prepare(
        `INSERT INTO expenses (name, category, amount, method, plan, start_date, next_due, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          body.name.trim(),
          body.category || null,
          Math.round(body.amount || 0),
          body.method || null,
          body.plan,
          body.start_date,
          next_due,
          status,
          body.notes || null
        )
        .run();
      const id = result.meta.last_row_id;
      const created = await env.DB.prepare("SELECT * FROM expenses WHERE id = ?").bind(id).first();
      return json({ expense: created }, 201);
    }

    const expenseMatch = path.match(/^\/api\/expenses\/(\d+)$/);
    if (expenseMatch) {
      const id = Number(expenseMatch[1]);
      if (request.method === "PUT") {
        const body = await readBody(request);
        const err = validateExpense(body);
        if (err) return json({ error: err }, 400);
        await env.DB.prepare(
          `UPDATE expenses
           SET name = ?, category = ?, amount = ?, method = ?, plan = ?,
               start_date = ?, next_due = ?, status = ?, notes = ?
           WHERE id = ?`
        )
          .bind(
            body.name.trim(),
            body.category || null,
            Math.round(body.amount || 0),
            body.method || null,
            body.plan,
            body.start_date,
            body.next_due || null,
            body.status || "active",
            body.notes || null,
            id
          )
          .run();
        const updated = await env.DB.prepare("SELECT * FROM expenses WHERE id = ?").bind(id).first();
        if (!updated) return json({ error: "not found" }, 404);
        return json({ expense: updated });
      }
      if (request.method === "DELETE") {
        await env.DB.prepare("DELETE FROM expenses WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }
    }

    if (request.method === "POST" && path === "/api/expense-payments") {
      const body = await readBody(request);
      const err = validateExpensePayment(body);
      if (err) return json({ error: err }, 400);

      const expense = await env.DB.prepare("SELECT * FROM expenses WHERE id = ?").bind(body.expense_id).first();
      if (!expense) return json({ error: "expense not found" }, 404);

      const insertResult = await env.DB.prepare(
        `INSERT INTO expense_payments (expense_id, amount, paid_on, method, reference, notes)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(
          body.expense_id,
          Math.round(body.amount),
          body.paid_on,
          body.method || null,
          body.reference || null,
          body.notes || null
        )
        .run();
      const paymentId = insertResult.meta.last_row_id;

      const newNextDue = bumpNextDue(expense.plan, expense.next_due, body.paid_on);
      const newStatus = expense.plan === "one-off" ? "completed" : expense.status;
      await env.DB.prepare("UPDATE expenses SET next_due = ?, status = ? WHERE id = ?")
        .bind(newNextDue, newStatus, body.expense_id)
        .run();

      const payment = await env.DB.prepare("SELECT * FROM expense_payments WHERE id = ?").bind(paymentId).first();
      const updatedExpense = await env.DB.prepare("SELECT * FROM expenses WHERE id = ?").bind(body.expense_id).first();
      return json({ payment, expense: updatedExpense }, 201);
    }

    const expensePaymentMatch = path.match(/^\/api\/expense-payments\/(\d+)$/);
    if (expensePaymentMatch && request.method === "DELETE") {
      const id = Number(expensePaymentMatch[1]);
      await env.DB.prepare("DELETE FROM expense_payments WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }

    // ─────────── Prospects (demo pipeline) ───────────
    if (request.method === "POST" && path === "/api/prospects") {
      const body = await readBody(request);
      const err = validateProspect(body);
      if (err) return json({ error: err }, 400);
      const result = await env.DB.prepare(
        `INSERT INTO prospects (name, business, phone, email, demo_url, stage, followup_date, notes, converted_client_id, source, source_date, catalog_api_base)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          body.name.trim(),
          body.business || null,
          body.phone || null,
          body.email || null,
          body.demo_url || null,
          body.stage || "requested",
          body.followup_date || null,
          body.notes || null,
          Number.isInteger(body.converted_client_id) ? body.converted_client_id : null,
          body.source || null,
          body.source_date || null,
          body.catalog_api_base || null
        )
        .run();
      const id = result.meta.last_row_id;
      const created = await env.DB.prepare("SELECT * FROM prospects WHERE id = ?").bind(id).first();
      return json({ prospect: created }, 201);
    }

    const prospectMatch = path.match(/^\/api\/prospects\/(\d+)$/);
    if (prospectMatch) {
      const id = Number(prospectMatch[1]);
      if (request.method === "PUT") {
        const body = await readBody(request);
        const err = validateProspect(body);
        if (err) return json({ error: err }, 400);
        await env.DB.prepare(
          `UPDATE prospects
           SET name = ?, business = ?, phone = ?, email = ?, demo_url = ?, stage = ?, followup_date = ?, notes = ?, converted_client_id = ?, source = ?, source_date = ?, catalog_api_base = ?
           WHERE id = ?`
        )
          .bind(
            body.name.trim(),
            body.business || null,
            body.phone || null,
            body.email || null,
            body.demo_url || null,
            body.stage || "requested",
            body.followup_date || null,
            body.notes || null,
            Number.isInteger(body.converted_client_id) ? body.converted_client_id : null,
            body.source || null,
            body.source_date || null,
            body.catalog_api_base || null,
            id
          )
          .run();
        const updated = await env.DB.prepare("SELECT * FROM prospects WHERE id = ?").bind(id).first();
        if (!updated) return json({ error: "not found" }, 404);
        return json({ prospect: updated });
      }
      if (request.method === "DELETE") {
        await env.DB.prepare("DELETE FROM prospects WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }
    }

    // Pause / resume a trial prospect's catalog website (kill-switch for demos).
    // Records the paused date; the browser makes the actual catalog /api/suspend call
    // (worker→worker is blocked by CF 1042). Mirrors /api/clients/:id/subaccount.
    const prospectSubMatch = path.match(/^\/api\/prospects\/(\d+)\/subaccount$/);
    if (prospectSubMatch && request.method === "POST") {
      const id = Number(prospectSubMatch[1]);
      const body = await readBody(request);
      const newValue = body && body.paused ? new Date().toISOString().slice(0, 10) : null;
      await env.DB.prepare("UPDATE prospects SET subaccount_paused = ? WHERE id = ?")
        .bind(newValue, id).run();
      const updated = await env.DB.prepare("SELECT * FROM prospects WHERE id = ?").bind(id).first();
      if (!updated) return json({ error: "not found" }, 404);
      return json({ prospect: updated });
    }

    // Manually trigger the digest (for testing without waiting for the cron)
    if (request.method === "POST" && path === "/api/test-digest") {
      const result = await runOverdueDigest(env);
      return json({ ok: true, result });
    }

    return json({ error: "not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runOverdueDigest(env));
  },
};

// ─────────── Daily overdue / due-soon digest (self-notification) ───────────

function nairobiTodayISO() {
  const nairobi = new Date(Date.now() + 3 * 3600 * 1000);
  return nairobi.toISOString().slice(0, 10);
}
function addDaysISO_(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function daysLate(today, due) {
  const a = today.split("-").map(Number);
  const b = due.split("-").map(Number);
  return Math.round((Date.UTC(a[0], a[1] - 1, a[2]) - Date.UTC(b[0], b[1] - 1, b[2])) / 86400000);
}
function fmtKES_(n) {
  return "Ksh " + Math.round(n || 0).toLocaleString("en-KE");
}
function fmtDMY(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

async function runOverdueDigest(env) {
  const today = nairobiTodayISO();
  const in3 = addDaysISO_(today, 3);

  const cl = await env.DB.prepare(
    "SELECT * FROM clients WHERE status = 'active' AND next_due IS NOT NULL ORDER BY next_due ASC"
  ).all();
  const clients = cl.results || [];
  const overdue = clients.filter((c) => c.next_due < today);
  const dueSoon = clients.filter((c) => c.next_due >= today && c.next_due <= in3);

  // Unpaid scheduled payments (deposit/balance) that are overdue or due soon
  const sp = await env.DB.prepare(
    "SELECT s.*, c.name AS client_name FROM scheduled_payments s JOIN clients c ON c.id = s.client_id WHERE s.paid_on IS NULL ORDER BY s.due_date ASC"
  ).all();
  const scheduled = sp.results || [];
  const schedOverdue = scheduled.filter((s) => s.due_date < today);
  const schedSoon = scheduled.filter((s) => s.due_date >= today && s.due_date <= in3);

  if (overdue.length === 0 && dueSoon.length === 0 && schedOverdue.length === 0 && schedSoon.length === 0) {
    return { sent: false, reason: "nothing overdue or due soon" };
  }

  const invStatus = (c) =>
    c.invoice_type === "none"
      ? ""
      : c.invoice_sent_for_next_due === c.next_due
        ? (c.invoice_type === "kra" ? " KRA invoice raised." : " Invoice raised.")
        : (c.invoice_type === "kra" ? " KRA invoice NOT yet raised." : " Invoice NOT yet raised.");

  const lines = ["Morning Joel,", ""];

  if (overdue.length || schedOverdue.length) {
    lines.push("OVERDUE — suspend or chase:");
    for (const c of overdue) {
      const late = daysLate(today, c.next_due);
      lines.push(`  - ${c.name} (${fmtKES_(c.amount)}), ${late} day${late === 1 ? "" : "s"} late, was due ${fmtDMY(c.next_due)}.${invStatus(c)}`);
    }
    for (const s of schedOverdue) {
      const late = daysLate(today, s.due_date);
      lines.push(`  - ${s.client_name} — ${s.description || "scheduled payment"} (${fmtKES_(s.amount)}), ${late} day${late === 1 ? "" : "s"} late, was due ${fmtDMY(s.due_date)}.`);
    }
    lines.push("");
  }

  if (dueSoon.length || schedSoon.length) {
    lines.push("Due in the next 3 days:");
    for (const c of dueSoon) {
      lines.push(`  - ${c.name} (${fmtKES_(c.amount)}), due ${fmtDMY(c.next_due)}.${invStatus(c)}`);
    }
    for (const s of schedSoon) {
      lines.push(`  - ${s.client_name} — ${s.description || "scheduled payment"} (${fmtKES_(s.amount)}), due ${fmtDMY(s.due_date)}.`);
    }
    lines.push("");
  }

  lines.push("Open the dashboard: https://billing.essenceautomations.com");
  const text = lines.join("\n");

  // Catchy, money-led subject. Lead with the cash to collect so it stands out
  // in a crowded inbox and answers "how much / who" at a glance.
  const overdueItems = [...overdue, ...schedOverdue];
  const soonItems = [...dueSoon, ...schedSoon];
  const overdueCount = overdueItems.length;
  const soonCount = soonItems.length;
  const totalToCollect = [...overdueItems, ...soonItems].reduce((s, x) => s + (x.amount || 0), 0);

  let subject;
  if (overdueCount + soonCount === 1) {
    const only = overdueItems[0] || soonItems[0];
    const who = only.name || only.client_name;
    const amt = fmtKES_(only.amount);
    subject = overdueCount === 1
      ? `⚠ ${who} hasn't paid · ${amt} to collect`
      : `💰 ${who} due soon · ${amt}`;
  } else {
    const parts = [];
    if (overdueCount) parts.push(`${overdueCount} overdue`);
    if (soonCount) parts.push(`${soonCount} due soon`);
    const lead = overdueCount ? "⚠" : "💰";
    subject = `${lead} ${parts.join(", ")} · ${fmtKES_(totalToCollect)} to collect`;
  }

  if (!env.RESEND_API_KEY) {
    return { sent: false, reason: "RESEND_API_KEY not set", preview: { subject, text } };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      // onboarding@resend.dev is Resend's shared test sender — works with no
      // domain verification, but can only deliver to the email the Resend
      // account was created with. So sign up for Resend with joelmuthee@gmail.com.
      // To send to other recipients or use a branded From, verify
      // essenceautomations.com in Resend and switch these two lines.
      from: "Essence Billing <onboarding@resend.dev>",
      to: ["joelmuthee@gmail.com"],
      subject,
      text,
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { sent: res.ok, status: res.status, body };
}
