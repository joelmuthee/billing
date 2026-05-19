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

function validateExpensePayment(p) {
  if (!p || typeof p !== "object") return "body must be an object";
  if (!Number.isInteger(p.expense_id)) return "expense_id is required";
  if (typeof p.amount !== "number" || p.amount <= 0) return "amount must be a positive number";
  if (!p.paid_on || !/^\d{4}-\d{2}-\d{2}$/.test(p.paid_on)) return "paid_on must be YYYY-MM-DD";
  return null;
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

    if (request.method === "POST" && path === "/api/auth") {
      return json({ ok: true });
    }

    if (request.method === "GET" && path === "/api/data") {
      const clientsRs = await env.DB.prepare("SELECT * FROM clients ORDER BY name COLLATE NOCASE").all();
      const payments = await env.DB.prepare("SELECT * FROM payments ORDER BY paid_on DESC, id DESC").all();
      const expenses = await env.DB.prepare("SELECT * FROM expenses ORDER BY name COLLATE NOCASE").all();
      const expensePayments = await env.DB.prepare("SELECT * FROM expense_payments ORDER BY paid_on DESC, id DESC").all();
      const scheduled = await env.DB.prepare("SELECT * FROM scheduled_payments ORDER BY due_date ASC").all();
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
      });
    }

    if (request.method === "POST" && path === "/api/clients") {
      const body = await readBody(request);
      const err = validateClient(body);
      if (err) return json({ error: err }, 400);
      const next_due = body.next_due || (body.plan === "one-off" ? null : body.start_date);
      const status = body.status || (body.plan === "one-off" ? "active" : "active");
      const result = await env.DB.prepare(
        `INSERT INTO clients (name, business, plan, amount, method, phone, email, notes, start_date, next_due, status, reminder_method, services, upsell_notes, upsell_followup_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          body.upsell_followup_date || null
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
               upsell_notes = ?, upsell_followup_date = ?
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
      await env.DB.prepare("UPDATE clients SET next_due = ?, status = ? WHERE id = ?")
        .bind(newNextDue, newStatus, body.client_id)
        .run();

      const payment = await env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(paymentId).first();
      const updatedClient = await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(body.client_id).first();
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
      // When sent, stamp with the client's current next_due. When unsent, null.
      const newValue = body && body.sent ? client.next_due : null;
      await env.DB.prepare("UPDATE clients SET invoice_sent_for_next_due = ? WHERE id = ?")
        .bind(newValue, id).run();
      const updated = await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(id).first();
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

    return json({ error: "not found" }, 404);
  },
};
