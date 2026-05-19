// Clients Dashboard API — Cloudflare Worker + D1
//
// Endpoints (all JSON unless noted):
//   GET    /api/health                 → liveness
//   POST   /api/auth                   → { ok: true } if token valid (used by login screen)
//   GET    /api/data                   → { clients, payments } — single bulk fetch
//   POST   /api/clients                → create client
//   PUT    /api/clients/:id            → update client
//   DELETE /api/clients/:id            → delete client (cascades payments)
//   POST   /api/payments               → record payment, auto-bump client.next_due
//   DELETE /api/payments/:id           → delete payment
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
    headers: { "Content-Type": "application/json", ...CORS, ...extra },
  });

const isAuthed = (req, env) => {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  return env.ADMIN_TOKEN && auth.slice(7).trim() === env.ADMIN_TOKEN;
};

const PLANS = ["monthly", "quarterly", "one-off"];
const STATUSES = ["active", "paused", "churned", "completed"];

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
  return null;
}

function validatePayment(p) {
  if (!p || typeof p !== "object") return "body must be an object";
  if (!Number.isInteger(p.client_id)) return "client_id is required";
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
      const clients = await env.DB.prepare("SELECT * FROM clients ORDER BY name COLLATE NOCASE").all();
      const payments = await env.DB.prepare("SELECT * FROM payments ORDER BY paid_on DESC, id DESC").all();
      return json({ clients: clients.results || [], payments: payments.results || [] });
    }

    if (request.method === "POST" && path === "/api/clients") {
      const body = await readBody(request);
      const err = validateClient(body);
      if (err) return json({ error: err }, 400);
      const next_due = body.next_due || (body.plan === "one-off" ? null : body.start_date);
      const status = body.status || (body.plan === "one-off" ? "active" : "active");
      const result = await env.DB.prepare(
        `INSERT INTO clients (name, business, plan, amount, method, phone, notes, start_date, next_due, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          body.name.trim(),
          body.business || null,
          body.plan,
          Math.round(body.amount || 0),
          body.method || null,
          body.phone || null,
          body.notes || null,
          body.start_date,
          next_due,
          status
        )
        .run();
      const id = result.meta.last_row_id;
      const created = await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(id).first();
      return json({ client: created }, 201);
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
           SET name = ?, business = ?, plan = ?, amount = ?, method = ?, phone = ?, notes = ?,
               start_date = ?, next_due = ?, status = ?
           WHERE id = ?`
        )
          .bind(
            body.name.trim(),
            body.business || null,
            body.plan,
            Math.round(body.amount || 0),
            body.method || null,
            body.phone || null,
            body.notes || null,
            body.start_date,
            body.next_due || null,
            body.status || "active",
            id
          )
          .run();
        const updated = await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(id).first();
        if (!updated) return json({ error: "not found" }, 404);
        return json({ client: updated });
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

      // Advance client.next_due (or mark one-off completed)
      const newNextDue = bumpNextDue(client.plan, client.next_due, body.paid_on);
      const newStatus = client.plan === "one-off" ? "completed" : client.status;
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

    return json({ error: "not found" }, 404);
  },
};
