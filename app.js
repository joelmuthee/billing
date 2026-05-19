// Clients Dashboard — front-end logic
// Talks to the CF Worker over fetch. Single global state, re-render on data change.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const API_BASE = 'https://clients-dashboard-api.stawisystems.workers.dev';
const APP_VERSION = '20260519-16';
console.log(`%c[Billing] app.js loaded — version ${APP_VERSION}`, 'color:#ff8424;font-weight:600');

// Service catalogue, sourced from essenceautomations.com
const SERVICES_CATEGORIES = [
  { name: 'Get Found', items: [
    { value: 'websites', label: 'Website' },
    { value: 'gbp-booster', label: 'GBP Booster' },
    { value: 'seo-content', label: 'SEO Content Engine' },
    { value: 'email-prospecting', label: 'Email Prospecting' },
  ]},
  { name: 'Convert', items: [
    { value: 'ai-chat', label: 'AI Chat' },
    { value: 'google-reviews', label: 'Google Reviews' },
    { value: 'ai-ads', label: 'AI Ads Manager' },
    { value: 'email-automation', label: 'Email Automation' },
  ]},
  { name: 'Retain', items: [
    { value: 'crm', label: 'CRM With App' },
    { value: 'wa-marketing', label: 'WhatsApp Marketing' },
    { value: 'email-marketing', label: 'Email Marketing' },
    { value: 'appointment-calendar', label: 'Appointment Calendar' },
  ]},
  { name: 'Operate', items: [
    { value: 'social-media', label: 'Social Media Management' },
    { value: 'document-management', label: 'Document Management' },
    { value: 'smart-qr', label: 'Smart QR' },
  ]},
];
const SERVICE_LABEL = Object.fromEntries(
  SERVICES_CATEGORIES.flatMap((c) => c.items).map((s) => [s.value, s.label])
);

const state = {
  apiBase: API_BASE,
  token: localStorage.getItem('cd_token') || '',
  clients: [],
  payments: [],
  expenses: [],
  expense_payments: [],
  scheduled_payments: [],
  activeTab: 'dashboard',
  revenuePeriod: '30d',
  clientFilter: 'all',
  upcomingDays: 30,
};

// ────────── Formatting helpers ──────────

const fmtKES = (n) => {
  if (n == null || isNaN(n)) return 'Ksh 0';
  return 'Ksh ' + Math.round(n).toLocaleString('en-KE');
};

const todayISO = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const parseISO = (iso) => {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};

const daysFromToday = (iso) => {
  const target = parseISO(iso);
  if (!target) return null;
  const today = parseISO(todayISO());
  return Math.round((target - today) / 86400000);
};

const fmtDate = (iso) => {
  const d = parseISO(iso);
  if (!d) return '';
  // DD/MM/YYYY
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
};

const fmtDateShort = (iso) => {
  const d = parseISO(iso);
  if (!d) return '';
  // DD/MM
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}`;
};

const fmtRelative = (iso) => {
  const days = daysFromToday(iso);
  if (days === null) return '';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days > 0 && days <= 30) return `in ${days} days`;
  if (days < 0 && days >= -90) return `${Math.abs(days)} days late`;
  return fmtDate(iso);
};

const planLabel = (plan) => {
  if (plan === 'monthly') return 'Monthly';
  if (plan === 'quarterly') return 'Every 3 months';
  return 'One off';
};

const methodLabel = (m) => {
  if (!m) return '';
  if (m === 'mpesa') return 'Mpesa';
  if (m === 'cheque') return 'Cheque';
  if (m === 'bank') return 'Bank';
  if (m === 'cash') return 'Cash';
  return m;
};

// ────────── API ──────────

async function api(path, opts = {}) {
  // Cache-bust GETs with a timestamp so the browser HTTP cache can't serve
  // a stale /api/data response. Also pass cache:'no-store' on the request.
  const method = (opts.method || 'GET').toUpperCase();
  const sep = path.includes('?') ? '&' : '?';
  const url = state.apiBase.replace(/\/$/, '') + path + (method === 'GET' ? `${sep}_t=${Date.now()}` : '');
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${state.token}`,
    ...(opts.headers || {}),
  };
  const res = await fetch(url, { ...opts, headers, cache: 'no-store' });
  let data = null;
  try { data = await res.json(); } catch {}
  if (res.status === 401) {
    logout();
    throw new Error('Session expired. Sign in again.');
  }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

async function loadData() {
  const data = await api('/api/data');
  state.clients = data.clients || [];
  state.payments = data.payments || [];
  state.expenses = data.expenses || [];
  state.expense_payments = data.expense_payments || [];
  state.scheduled_payments = data.scheduled_payments || [];
  renderAll();
}

// Add N months to an ISO date, handling month-end overflow
function addMonthsISO(iso, months) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

// Add N days to an ISO date, staying in local time. The naive
// `new Date(localDate.getTime() + n*86400000).toISOString()` pattern silently
// loses a day in any +UTC timezone (Nairobi is UTC+3) — local midnight goes
// back to the previous day in UTC.
function addDaysISO(iso, n) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(y, m - 1, d + n);
  const yy = target.getFullYear();
  const mm = String(target.getMonth() + 1).padStart(2, '0');
  const dd = String(target.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// ────────── Auth ──────────

function showLogin() {
  $('#login').classList.remove('hidden');
  $('#app').classList.add('hidden');
}
function showApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
}
function logout() {
  state.token = '';
  state.clients = [];
  state.payments = [];
  localStorage.removeItem('cd_token');
  showLogin();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('#password').value;
  const errEl = $('#loginError');
  errEl.classList.add('hidden');
  if (!password) return;
  state.token = password;
  try {
    await api('/api/auth', { method: 'POST' });
    localStorage.setItem('cd_token', password);
    showApp();
    await loadData();
  } catch (err) {
    state.token = '';
    errEl.textContent = err.message || 'Sign in failed.';
    errEl.classList.remove('hidden');
  }
});

$('#logout').addEventListener('click', logout);

// ────────── Tabs ──────────

$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.activeTab = btn.dataset.tab;
    $$('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.tab-panel').forEach((p) => {
      p.classList.toggle('active', p.id === `tab-${state.activeTab}`);
    });
    if (state.activeTab === 'revenue') renderRevenue();
  });
});

// ────────── Toast ──────────

let toastTimer = null;
function toast(msg, kind = 'ok') {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', kind === 'error');
  el.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2400);
}

// ────────── Modal ──────────

function openModal(html) {
  $('#modal').innerHTML = html;
  $('#modal').classList.remove('hidden');
  $('#modalBackdrop').classList.remove('hidden');
}
function closeModal() {
  $('#modal').classList.add('hidden');
  $('#modalBackdrop').classList.add('hidden');
  $('#modal').innerHTML = '';
}
$('#modalBackdrop').addEventListener('click', closeModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

// ────────── Renderers ──────────

function renderAll() {
  renderBanner();
  renderKPIs();
  renderUpcoming();
  renderOverdue();
  renderUpsellFollowups();
  renderRecent();
  renderClientsList();
  renderPaymentsList();
  renderExpenses();
  if (state.activeTab === 'revenue') renderRevenue();
}

function renderBanner() {
  const today = todayISO();
  const in7 = addDaysISO(today, 7);
  const overdue = upcomingItems().filter((it) => it.due < today);
  const dueWeek = upcomingItems().filter((it) => it.due >= today && it.due <= in7);
  const upsells = upsellDueClients();

  const el = $('#banner');
  if (overdue.length === 0 && dueWeek.length === 0 && upsells.length === 0) {
    el.classList.add('hidden');
    return;
  }
  const parts = [];
  if (overdue.length) parts.push(`<strong>${overdue.length} overdue</strong>`);
  if (dueWeek.length) parts.push(`${dueWeek.length} due this week`);
  if (upsells.length) parts.push(`${upsells.length} upsell follow-up${upsells.length > 1 ? 's' : ''}`);
  el.innerHTML = `<span>${parts.join(' · ')}</span><span class="banner-hint">↓ scroll for details</span>`;
  el.classList.remove('hidden');
  el.classList.toggle('danger', overdue.length > 0);
}

// Returns a unified list of upcoming things to act on:
//   - recurring client dues (from client.next_due)
//   - unpaid scheduled payments
// Each item: { kind, due, amount, client, label, scheduled?, invoiceSent }
function upcomingItems() {
  const items = [];
  for (const c of state.clients) {
    if (c.status !== 'active' || !c.next_due) continue;
    items.push({
      kind: 'recurring',
      due: c.next_due,
      amount: c.amount,
      client: c,
      invoiceSent: c.invoice_sent_for_next_due === c.next_due,
    });
  }
  for (const s of state.scheduled_payments) {
    if (s.paid_on) continue;
    const c = state.clients.find((x) => x.id === s.client_id);
    if (!c) continue;
    items.push({
      kind: 'scheduled',
      due: s.due_date,
      amount: s.amount,
      client: c,
      scheduled: s,
      label: s.description || 'Scheduled payment',
      invoiceSent: !!s.invoice_sent_on,
    });
  }
  return items.sort((a, b) => a.due.localeCompare(b.due));
}

window.toggleInvoice = async function (kind, id, currentlySent) {
  const sent = !currentlySent;
  const path = kind === 'scheduled'
    ? `/api/scheduled-payments/${id}/invoice`
    : `/api/clients/${id}/invoice`;
  try {
    await api(path, { method: 'POST', body: JSON.stringify({ sent }) });
    await loadData();
    toast(sent ? 'Invoice marked sent' : 'Invoice unmarked');
  } catch (err) {
    toast(err.message, 'error');
  }
};

function upsellDueClients() {
  const today = todayISO();
  return state.clients
    .filter((c) => c.upsell_followup_date && c.upsell_followup_date <= today && c.status !== 'churned')
    .sort((a, b) => a.upsell_followup_date.localeCompare(b.upsell_followup_date));
}

// ────────── Reminder helpers ──────────

function firstName(c) {
  return (c.name || '').split(/\s+/)[0] || c.name || '';
}

function waReminderUrl(c, kind) {
  if (!c.phone) return null;
  const digits = c.phone.replace(/\D/g, '');
  if (!digits) return null;
  const amount = fmtKES(c.amount);
  const dateStr = fmtDate(c.next_due);
  let msg;
  if (kind === 'overdue') {
    msg = `Hi ${firstName(c)}, just a quick reminder that the ${amount} payment was due on ${dateStr} and is still pending. Could you settle it when you get a chance? Thanks.`;
  } else {
    msg = `Hi ${firstName(c)}, friendly reminder that your ${amount} payment is due on ${dateStr}. Thanks.`;
  }
  return `https://wa.me/${digits}?text=${encodeURIComponent(msg)}`;
}

function emailDraft(c, kind) {
  const amount = fmtKES(c.amount);
  const dateStr = fmtDate(c.next_due);
  const subject = kind === 'overdue'
    ? `Payment reminder, ${amount}`
    : `Payment due ${dateStr}`;
  const body = kind === 'overdue'
    ? `Hi ${firstName(c)},\n\nJust a quick reminder that the ${amount} payment was due on ${dateStr} and is still pending. Could you settle it when you get a chance?\n\nThanks,\nJoel\nEssence Automations`
    : `Hi ${firstName(c)},\n\nFriendly reminder that your ${amount} payment is due on ${dateStr}.\n\nThanks,\nJoel\nEssence Automations`;
  return { subject, body };
}

async function copyEmailDraft(clientId, kind) {
  const c = state.clients.find((x) => x.id === clientId);
  if (!c) return;
  const { subject, body } = emailDraft(c, kind);
  const text = `Subject: ${subject}\n\n${body}`;
  try {
    await navigator.clipboard.writeText(text);
    toast('Email draft copied. Paste into Gmail or your mail app.');
  } catch {
    // Fallback: show in a modal so the user can copy manually
    openModal(`
      <h2>Email draft</h2>
      <p class="muted" style="margin-bottom:14px;">Copy this into your email client.</p>
      <textarea readonly style="height: 220px; font-family: 'Geist Mono', monospace; font-size: 13px;">${escapeHtml(text)}</textarea>
      <div class="modal-actions">
        <button type="button" class="btn-primary" onclick="closeModal()">Done</button>
      </div>
    `);
  }
}
window.copyEmailDraft = copyEmailDraft;

// Returns the right reminder element for a row based on the client's preferred method
function reminderAction(c, kind) {
  const m = c.reminder_method || 'whatsapp';
  if (m === 'whatsapp') {
    const url = waReminderUrl(c, kind);
    if (!url) return '<span class="badge muted" title="No phone saved">no phone</span>';
    return `<a class="btn-sm wa" href="${url}" target="_blank" rel="noopener">Remind</a>`;
  }
  if (m === 'email') {
    if (!c.email) return '<span class="badge muted" title="No email saved">no email</span>';
    return `<button class="btn-sm email" onclick="copyEmailDraft(${c.id}, '${kind}')">Copy email</button>`;
  }
  if (m === 'kra_invoice') {
    return '<span class="badge muted">KRA invoice</span>';
  }
  return ''; // 'none'
}

function renderKPIs() {
  const today = todayISO();
  const monthStart = today.slice(0, 7) + '-01';

  const monthRevenue = state.payments
    .filter((p) => p.paid_on >= monthStart && p.paid_on <= today)
    .reduce((s, p) => s + p.amount, 0);

  const activeClients = state.clients.filter((c) => c.status === 'active');

  const overdue = activeClients
    .filter((c) => c.next_due && c.next_due < today)
    .reduce((s, c) => s + c.amount, 0);

  const in30 = addDaysISO(today, 30);
  const expected30 = activeClients
    .filter((c) => c.next_due && c.next_due >= today && c.next_due <= in30)
    .reduce((s, c) => s + c.amount, 0);

  $('#kpiRow').innerHTML = `
    <div class="kpi-card">
      <div class="kpi-label">This month</div>
      <div class="kpi-value">${fmtKES(monthRevenue)}</div>
      <div class="kpi-sub">${countPaymentsThisMonth()} payments received</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Outstanding</div>
      <div class="kpi-value ${overdue > 0 ? 'danger' : ''}">${fmtKES(overdue)}</div>
      <div class="kpi-sub">${countOverdue()} overdue</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Expected next 30d</div>
      <div class="kpi-value">${fmtKES(expected30)}</div>
      <div class="kpi-sub">${countDueSoon()} clients due</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Clients</div>
      <div class="kpi-value">${state.clients.filter((c) => c.status !== 'churned').length}</div>
      <div class="kpi-sub">${state.clients.filter((c) => (c.plan === 'monthly' || c.plan === 'quarterly') && c.status === 'active').length} recurring · ${state.clients.filter((c) => c.plan === 'one-off' && c.status !== 'churned').length} one off</div>
    </div>
  `;
}

function countPaymentsThisMonth() {
  const monthStart = todayISO().slice(0, 7) + '-01';
  return state.payments.filter((p) => p.paid_on >= monthStart).length;
}
function countOverdue() {
  const today = todayISO();
  return state.clients.filter((c) => c.status === 'active' && c.next_due && c.next_due < today).length;
}
function countDueSoon() {
  const today = todayISO();
  const in30 = addDaysISO(today, 30);
  return state.clients.filter((c) => c.status === 'active' && c.next_due && c.next_due >= today && c.next_due <= in30).length;
}

function renderUpcoming() {
  const today = todayISO();
  const days = state.upcomingDays;
  const inN = addDaysISO(today, days);
  const upcoming = upcomingItems().filter((it) => it.due >= today && it.due <= inN);

  const titleEl = $('#upcomingTitle');
  if (titleEl) titleEl.textContent = `Upcoming (next ${days} days)`;

  const el = $('#upcomingList');
  if (upcoming.length === 0) {
    el.innerHTML = `<div class="empty">Nothing due in the next ${days} days.</div>`;
    return;
  }
  el.innerHTML = upcoming.map((it) => upcomingRowHtml(it, 'upcoming')).join('');
}

function invoiceBadge(it) {
  if (it.invoiceSent) {
    return `<span class="badge ok">✓ Invoiced</span>`;
  }
  return `<span class="badge danger">Invoice needed</span>`;
}

function invoiceToggleButton(it) {
  const idArg = it.kind === 'scheduled' ? it.scheduled.id : it.client.id;
  if (it.invoiceSent) {
    return `<button class="btn-sm" onclick="toggleInvoice('${it.kind}', ${idArg}, true)" title="Unmark invoice">↩ Invoice</button>`;
  }
  return `<button class="btn-sm invoice-cta" onclick="toggleInvoice('${it.kind}', ${idArg}, false)">+ Mark invoiced</button>`;
}

function upcomingRowHtml(it, kind) {
  const c = it.client;
  if (it.kind === 'scheduled') {
    return `
      <div class="list-row ${kind === 'overdue' ? 'danger' : ''}">
        <div>
          <div class="primary">${escapeHtml(c.name)} <span class="muted-2" style="font-weight:400;">· ${escapeHtml(it.label)}</span></div>
          <div class="sub">
            <span class="badge plan-one-off">Scheduled</span>
            ${invoiceBadge(it)}
            ${kind === 'overdue'
              ? `<span class="badge danger">${Math.abs(daysFromToday(it.due))} days late</span><span>Was due ${fmtDate(it.due)}</span>`
              : `<span>Due ${fmtDate(it.due)} · ${fmtRelative(it.due)}</span>`}
          </div>
        </div>
        <div class="actions">
          <div class="amount num">${fmtKES(it.amount)}</div>
          ${invoiceToggleButton(it)}
          ${reminderAction(c, kind)}
          <button class="btn-sm" onclick="paySchedule(${it.scheduled.id})">Mark paid</button>
        </div>
      </div>
    `;
  }
  return `
    <div class="list-row ${kind === 'overdue' ? 'danger' : ''}">
      <div>
        <div class="primary">${escapeHtml(c.name)}</div>
        <div class="sub">
          <span class="badge plan-${c.plan}">${planLabel(c.plan)}</span>
          ${invoiceBadge(it)}
          ${kind === 'overdue'
            ? `<span class="badge danger">${Math.abs(daysFromToday(it.due))} days late</span><span>Was due ${fmtDate(it.due)}</span>`
            : `<span>Due ${fmtDate(it.due)} · ${fmtRelative(it.due)}</span>`}
        </div>
      </div>
      <div class="actions">
        <div class="amount num">${fmtKES(it.amount)}</div>
        ${invoiceToggleButton(it)}
        ${reminderAction(c, kind)}
        <button class="btn-sm" onclick="quickPay(${c.id})">Mark paid</button>
      </div>
    </div>
  `;
}

function renderOverdue() {
  const today = todayISO();
  const overdue = upcomingItems().filter((it) => it.due < today);

  const el = $('#overdueList');
  if (overdue.length === 0) {
    el.innerHTML = '<div class="empty">No overdue clients. Nice.</div>';
    return;
  }
  el.innerHTML = overdue.map((it) => upcomingRowHtml(it, 'overdue')).join('');
}

function renderUpsellFollowups() {
  const list = upsellDueClients();
  const card = $('#upsellCard');
  const el = $('#upsellList');
  if (list.length === 0) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  el.innerHTML = list.map((c) => `
    <div class="list-row">
      <div>
        <div class="primary">${escapeHtml(c.name)}${c.business ? ` <span class="muted-2" style="font-weight:400;">· ${escapeHtml(c.business)}</span>` : ''}</div>
        <div class="sub">
          <span class="badge warn">Follow up</span>
          <span>Scheduled ${fmtDate(c.upsell_followup_date)} · ${fmtRelative(c.upsell_followup_date)}</span>
        </div>
        ${c.upsell_notes ? `<div class="sub" style="margin-top:4px;">${escapeHtml(c.upsell_notes)}</div>` : ''}
      </div>
      <div class="actions">
        ${reminderAction(c, 'upcoming')}
        <button class="btn-sm" onclick="snoozeUpsell(${c.id})">Snooze 30d</button>
        <button class="btn-sm" onclick="clearUpsell(${c.id})">Done</button>
        <button class="btn-sm" onclick="editClient(${c.id})">Edit</button>
      </div>
    </div>
  `).join('');
}

window.snoozeUpsell = async function (id) {
  const c = state.clients.find((x) => x.id === id);
  if (!c) return;
  const newDate = addMonthsISO(todayISO(), 1);
  const body = serializeClientForUpdate(c, { upsell_followup_date: newDate });
  try {
    await api(`/api/clients/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    await loadData();
    toast('Snoozed for 30 days');
  } catch (err) { toast(err.message, 'error'); }
};

window.clearUpsell = async function (id) {
  const c = state.clients.find((x) => x.id === id);
  if (!c) return;
  const body = serializeClientForUpdate(c, { upsell_followup_date: null });
  try {
    await api(`/api/clients/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    await loadData();
    toast('Cleared upsell follow-up');
  } catch (err) { toast(err.message, 'error'); }
};

function serializeClientForUpdate(c, overrides = {}) {
  return {
    name: c.name,
    business: c.business,
    plan: c.plan,
    amount: c.amount,
    method: c.method,
    phone: c.phone,
    email: c.email,
    notes: c.notes,
    start_date: c.start_date,
    next_due: c.next_due,
    status: c.status,
    reminder_method: c.reminder_method || 'whatsapp',
    services: c.services || [],
    upsell_notes: c.upsell_notes,
    upsell_followup_date: c.upsell_followup_date,
    ...overrides,
  };
}

function renderRecent() {
  const recent = state.payments.slice(0, 10);
  const el = $('#recentPayments');
  if (recent.length === 0) {
    el.innerHTML = '<div class="empty">No payments recorded yet.</div>';
    return;
  }
  el.innerHTML = recent.map((p) => {
    const c = state.clients.find((x) => x.id === p.client_id);
    return `
      <div class="list-row">
        <div>
          <div class="primary">${escapeHtml(c ? c.name : 'Unknown client')}</div>
          <div class="sub">
            ${p.method ? `<span class="badge muted">${methodLabel(p.method)}</span>` : ''}
            ${p.reference ? `<span class="mono">Ref ${escapeHtml(p.reference)}</span>` : ''}
            <span class="date">${fmtDate(p.paid_on)}</span>
          </div>
        </div>
        <div class="amount num">${fmtKES(p.amount)}</div>
      </div>
    `;
  }).join('');
}

function renderClientsKpis() {
  const today = todayISO();
  const monthStart = today.slice(0, 7) + '-01';
  const last3Start = addMonthsISO(today, -3);
  const last12Start = addMonthsISO(today, -12);

  // "Added" = when the business relationship started, not when the row was
  // created in the dashboard (Joel back-fills old clients with their real
  // start_date going back to 2018).
  const inSince = (start) => state.clients.filter((c) => c.start_date >= start && c.status !== 'churned');
  const isRecurring = (c) => c.plan === 'monthly' || c.plan === 'quarterly';
  const isOneOff = (c) => c.plan === 'one-off';

  const subLine = (list) =>
    `${list.filter(isRecurring).length} recurring · ${list.filter(isOneOff).length} one off`;

  const thisMonth = inSince(monthStart);
  const last3 = inSince(last3Start);
  const last12 = inSince(last12Start);

  $('#clientsKpiRow').innerHTML = `
    <div class="kpi-card clickable" onclick="showClientsAddedBreakdown('thisMonth')">
      <div class="kpi-label">Added this month</div>
      <div class="kpi-value">${thisMonth.length}</div>
      <div class="kpi-sub">${subLine(thisMonth)}</div>
      <div class="breakdown-link">See breakdown →</div>
    </div>
    <div class="kpi-card clickable" onclick="showClientsAddedBreakdown('last3')">
      <div class="kpi-label">Last 3 months</div>
      <div class="kpi-value">${last3.length}</div>
      <div class="kpi-sub">${subLine(last3)}</div>
      <div class="breakdown-link">See breakdown →</div>
    </div>
    <div class="kpi-card clickable" onclick="showClientsAddedBreakdown('last12')">
      <div class="kpi-label">Last 12 months</div>
      <div class="kpi-value">${last12.length}</div>
      <div class="kpi-sub">${subLine(last12)}</div>
      <div class="breakdown-link">See breakdown →</div>
    </div>
    <div class="kpi-card clickable" onclick="showClientsAddedBreakdown('all')">
      <div class="kpi-label">All time</div>
      <div class="kpi-value">${state.clients.filter((c) => c.status !== 'churned').length}</div>
      <div class="kpi-sub">${subLine(state.clients.filter((c) => c.status !== 'churned'))}</div>
      <div class="breakdown-link">See breakdown →</div>
    </div>
  `;
}

window.showClientsAddedBreakdown = function (period) {
  const today = todayISO();
  let startIso, periodLabel;
  if (period === 'thisMonth') {
    startIso = today.slice(0, 7) + '-01';
    periodLabel = '(this month)';
  } else if (period === 'last3') {
    startIso = addMonthsISO(today, -3);
    periodLabel = '(last 3 months)';
  } else if (period === 'last12') {
    startIso = addMonthsISO(today, -12);
    periodLabel = '(last 12 months)';
  } else {
    startIso = '0000-01-01';
    periodLabel = '(all time)';
  }

  const clients = state.clients
    .filter((c) => c.start_date >= startIso && c.status !== 'churned')
    .sort((a, b) => b.start_date.localeCompare(a.start_date));
  const recurring = clients.filter((c) => c.plan === 'monthly' || c.plan === 'quarterly');
  const oneOff = clients.filter((c) => c.plan === 'one-off');

  const clientRow = (c) => `
    <tr>
      <td>
        <div>${escapeHtml(c.name)}${c.business ? ` <span class="muted-2" style="font-weight:400;">· ${escapeHtml(c.business)}</span>` : ''}</div>
        <div class="row-meta">${planLabel(c.plan)} · ${fmtKES(c.amount)}${c.plan !== 'one-off' ? '/period' : ''} · Started ${fmtDate(c.start_date)}</div>
      </td>
      <td class="num strong">${c.status === 'active' ? '<span class="status-paid">Active</span>' : `<span class="status-expected">${c.status}</span>`}</td>
    </tr>
  `;

  const recurringSection = recurring.length ? `
    <div class="breakdown-section">
      <div class="breakdown-section-title">Recurring (${recurring.length})</div>
      <table class="breakdown-table"><tbody>${recurring.map(clientRow).join('')}</tbody></table>
    </div>
  ` : '';

  const oneOffSection = oneOff.length ? `
    <div class="breakdown-section">
      <div class="breakdown-section-title">One off (${oneOff.length})</div>
      <table class="breakdown-table"><tbody>${oneOff.map(clientRow).join('')}</tbody></table>
    </div>
  ` : '';

  const empty = clients.length === 0
    ? '<p class="muted" style="text-align:center; padding:20px 0;">No clients added in this period.</p>'
    : '';

  openModal(`
    <h2>Clients added ${periodLabel}</h2>
    <p class="muted breakdown-note">Clients are placed in a period by their <code>start_date</code> — the actual relationship start, not when the row was created in this dashboard.</p>
    ${empty}
    ${recurringSection}
    ${oneOffSection}
    ${clients.length > 0 ? `
      <div class="breakdown-total">
        <span>Total</span>
        <span class="num">${clients.length}</span>
      </div>
    ` : ''}
    <div class="modal-actions">
      <button type="button" class="btn-primary" onclick="closeModal()">Close</button>
    </div>
  `);
};

function renderClientFilter() {
  const all = state.clients.length;
  const recurring = state.clients.filter((c) => c.plan === 'monthly' || c.plan === 'quarterly').length;
  const oneOff = state.clients.filter((c) => c.plan === 'one-off').length;
  const f = state.clientFilter;
  $('#clientFilter').innerHTML = `
    <button type="button" class="filter-pill${f === 'all' ? ' active' : ''}" data-filter="all">All <span class="filter-count">${all}</span></button>
    <button type="button" class="filter-pill${f === 'recurring' ? ' active' : ''}" data-filter="recurring">Recurring <span class="filter-count">${recurring}</span></button>
    <button type="button" class="filter-pill${f === 'one-off' ? ' active' : ''}" data-filter="one-off">One off <span class="filter-count">${oneOff}</span></button>
  `;
}

function renderClientsList() {
  renderClientsKpis();
  renderClientFilter();
  const el = $('#clientsList');
  if (state.clients.length === 0) {
    el.innerHTML = '<div class="empty">No clients yet. Add your first one.</div>';
    return;
  }
  const filtered = state.clients.filter((c) => {
    if (state.clientFilter === 'recurring') return c.plan === 'monthly' || c.plan === 'quarterly';
    if (state.clientFilter === 'one-off') return c.plan === 'one-off';
    return true;
  });
  if (filtered.length === 0) {
    el.innerHTML = `<div class="empty">No ${state.clientFilter === 'recurring' ? 'recurring' : 'one-off'} clients yet.</div>`;
    return;
  }
  const sorted = [...filtered].sort((a, b) => {
    const sa = a.status === 'active' ? 0 : 1;
    const sb = b.status === 'active' ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return a.name.localeCompare(b.name);
  });
  el.innerHTML = sorted.map((c) => {
    const overdue = c.status === 'active' && c.next_due && c.next_due < todayISO();
    const chips = servicesChips(c.services);
    return `
      <div class="list-row">
        <div>
          <div class="primary">${escapeHtml(c.name)}${c.business ? ` <span class="muted-2" style="font-weight:400;">· ${escapeHtml(c.business)}</span>` : ''}</div>
          <div class="sub">
            <span class="badge plan-${c.plan}">${planLabel(c.plan)}</span>
            ${c.status !== 'active' ? `<span class="badge muted">${c.status}</span>` : ''}
            ${overdue ? `<span class="badge danger">Overdue</span>` : ''}
            ${c.next_due ? `<span>Next due ${fmtDate(c.next_due)}</span>` : `<span>${c.plan === 'one-off' ? 'One off' : 'No due date'}</span>`}
            ${c.phone ? `<span class="mono">${escapeHtml(c.phone)}</span>` : ''}
          </div>
          ${chips ? `<div class="chips">${chips}</div>` : ''}
        </div>
        <div class="actions">
          <div class="amount num">${fmtKES(c.amount)}</div>
          <button class="btn-sm" onclick="quickPay(${c.id})">Pay</button>
          <button class="btn-sm" onclick="addScheduled(${c.id})">Schedule</button>
          <button class="btn-sm" onclick="editClient(${c.id})">Edit</button>
          <button class="btn-sm danger" onclick="deleteClient(${c.id})">Delete</button>
        </div>
      </div>
    `;
  }).join('');
}

// ────────── Scheduled payments ──────────

window.addScheduled = function (clientId) {
  const c = state.clients.find((x) => x.id === clientId);
  if (!c) return;
  openModal(`
    <h2>Schedule a payment</h2>
    <p class="muted" style="margin-bottom:14px;">For ${escapeHtml(c.name)}. Use this for staged invoices like deposit + balance.</p>
    <form id="scheduledForm">
      <label>
        <span>What's it for? <span class="hint">(e.g. "Website balance")</span></span>
        <input type="text" name="description" placeholder="Website balance" autofocus>
      </label>
      <div class="form-row">
        <label>
          <span>Amount (Ksh)</span>
          <input type="number" name="amount" min="1" step="1" required>
        </label>
        <label>
          <span>Due date</span>
          <input type="date" name="due_date" required value="${addMonthsISO(todayISO(), 2)}">
        </label>
      </div>
      <label>
        <span>Notes <span class="hint">(optional)</span></span>
        <textarea name="notes"></textarea>
      </label>
      <p class="error hidden" id="scheduledErr"></p>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn-primary">Schedule</button>
      </div>
    </form>
  `);
  $('#scheduledForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const body = {
      client_id: c.id,
      amount: Number(fd.get('amount')) || 0,
      due_date: fd.get('due_date'),
      description: (fd.get('description') || '').trim() || null,
      notes: (fd.get('notes') || '').trim() || null,
    };
    try {
      const result = await api('/api/scheduled-payments', { method: 'POST', body: JSON.stringify(body) });
      await loadData();
      closeModal();
      if (result && result.reactivated) {
        toast(`${c.name} reactivated, balance due ${fmtDate(body.due_date)}`);
      } else {
        toast('Payment scheduled');
      }
    } catch (err) {
      const errEl = $('#scheduledErr');
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });
};

window.paySchedule = function (scheduledId) {
  const s = state.scheduled_payments.find((x) => x.id === scheduledId);
  if (!s) return;
  const c = state.clients.find((x) => x.id === s.client_id);
  if (!c) return;
  // Re-use the payment modal but pre-fill from the scheduled item
  recordPayment(c.id, { amount: s.amount, scheduled_payment_id: s.id, reference: s.description || '' });
};

function renderPaymentsList() {
  const el = $('#paymentsList');
  if (state.payments.length === 0) {
    el.innerHTML = '<div class="empty">No payments recorded yet.</div>';
    return;
  }
  el.innerHTML = state.payments.map((p) => {
    const c = state.clients.find((x) => x.id === p.client_id);
    return `
      <div class="list-row">
        <div>
          <div class="primary">${escapeHtml(c ? c.name : 'Unknown client')}</div>
          <div class="sub">
            ${p.method ? `<span class="badge muted">${methodLabel(p.method)}</span>` : ''}
            ${p.reference ? `<span class="mono">Ref ${escapeHtml(p.reference)}</span>` : ''}
            ${p.notes ? `<span>${escapeHtml(p.notes)}</span>` : ''}
            <span class="date">${fmtDate(p.paid_on)}</span>
          </div>
        </div>
        <div class="actions">
          <div class="amount num">${fmtKES(p.amount)}</div>
          <button class="btn-sm danger" onclick="deletePayment(${p.id})">Delete</button>
        </div>
      </div>
    `;
  }).join('');
}

// ────────── Expenses tab ──────────

function renderExpenses() {
  renderExpenseKpis();
  renderExpensesList();
  renderRecentExpensePayments();
}

function renderExpenseKpis() {
  const monthlyBurn = state.expenses
    .filter((e) => e.status === 'active' && e.plan === 'monthly')
    .reduce((s, e) => s + e.amount, 0);
  const quarterlyBurn = state.expenses
    .filter((e) => e.status === 'active' && e.plan === 'quarterly')
    .reduce((s, e) => s + e.amount / 3, 0);
  const burn = monthlyBurn + quarterlyBurn;

  const today = todayISO();
  const monthStart = today.slice(0, 7) + '-01';
  const monthSpent = state.expense_payments
    .filter((p) => p.paid_on >= monthStart && p.paid_on <= today)
    .reduce((s, p) => s + p.amount, 0);

  const activeCount = state.expenses.filter((e) => e.status === 'active').length;

  $('#expenseKpis').innerHTML = `
    <div class="kpi-card">
      <div class="kpi-label">Monthly burn</div>
      <div class="kpi-value">${fmtKES(burn)}</div>
      <div class="kpi-sub">${activeCount} active</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Paid this month</div>
      <div class="kpi-value">${fmtKES(monthSpent)}</div>
      <div class="kpi-sub">${state.expense_payments.filter((p) => p.paid_on >= monthStart).length} payments</div>
    </div>
  `;
}

function renderExpensesList() {
  const el = $('#expensesList');
  if (state.expenses.length === 0) {
    el.innerHTML = '<div class="empty">No expenses yet. Add your first one.</div>';
    return;
  }
  const sorted = [...state.expenses].sort((a, b) => {
    const sa = a.status === 'active' ? 0 : 1;
    const sb = b.status === 'active' ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return a.name.localeCompare(b.name);
  });
  el.innerHTML = sorted.map((e) => {
    const overdue = e.status === 'active' && e.next_due && e.next_due < todayISO();
    return `
      <div class="list-row">
        <div>
          <div class="primary">${escapeHtml(e.name)}${e.category ? ` <span class="muted-2" style="font-weight:400;">· ${escapeHtml(e.category)}</span>` : ''}</div>
          <div class="sub">
            <span class="badge plan-${e.plan}">${planLabel(e.plan)}</span>
            ${e.status !== 'active' ? `<span class="badge muted">${e.status}</span>` : ''}
            ${overdue ? `<span class="badge danger">Overdue</span>` : ''}
            ${e.next_due ? `<span>Next due ${fmtDate(e.next_due)}</span>` : `<span>${e.plan === 'one-off' ? 'One off' : 'No due date'}</span>`}
          </div>
        </div>
        <div class="actions">
          <div class="amount num">${fmtKES(e.amount)}</div>
          <button class="btn-sm" onclick="logExpensePayment(${e.id})">Pay</button>
          <button class="btn-sm" onclick="editExpense(${e.id})">Edit</button>
          <button class="btn-sm danger" onclick="deleteExpense(${e.id})">Delete</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderRecentExpensePayments() {
  const recent = state.expense_payments.slice(0, 10);
  const el = $('#recentExpensePayments');
  if (recent.length === 0) {
    el.innerHTML = '<div class="empty">No expense payments recorded yet.</div>';
    return;
  }
  el.innerHTML = recent.map((p) => {
    const e = state.expenses.find((x) => x.id === p.expense_id);
    return `
      <div class="list-row">
        <div>
          <div class="primary">${escapeHtml(e ? e.name : 'Unknown expense')}</div>
          <div class="sub">
            ${p.method ? `<span class="badge muted">${methodLabel(p.method)}</span>` : ''}
            ${p.reference ? `<span class="mono">Ref ${escapeHtml(p.reference)}</span>` : ''}
            <span class="date">${fmtDate(p.paid_on)}</span>
          </div>
        </div>
        <div class="actions">
          <div class="amount num">${fmtKES(p.amount)}</div>
          <button class="btn-sm danger" onclick="deleteExpensePayment(${p.id})">Delete</button>
        </div>
      </div>
    `;
  }).join('');
}

function expenseFormHtml(e) {
  const isEdit = !!e;
  return `
    <h2>${isEdit ? 'Edit expense' : 'Add expense'}</h2>
    <form id="expenseForm">
      <label>
        <span>Name</span>
        <input type="text" name="name" required value="${isEdit ? escapeAttr(e.name) : ''}" autofocus>
      </label>
      <div class="form-row">
        <label>
          <span>Category <span class="hint">(optional)</span></span>
          <input type="text" name="category" placeholder="subscription, tools, rent…" value="${isEdit && e.category ? escapeAttr(e.category) : ''}">
        </label>
        <label>
          <span>Amount (Ksh)</span>
          <input type="number" name="amount" min="0" step="1" value="${isEdit ? e.amount : ''}" required>
        </label>
      </div>
      <div class="form-row">
        <label>
          <span>Plan</span>
          <select name="plan" required>
            <option value="monthly" ${!isEdit || e.plan === 'monthly' ? 'selected' : ''}>Monthly</option>
            <option value="quarterly" ${isEdit && e.plan === 'quarterly' ? 'selected' : ''}>Every 3 months</option>
            <option value="one-off" ${isEdit && e.plan === 'one-off' ? 'selected' : ''}>One off</option>
          </select>
        </label>
        <label>
          <span>Payment method</span>
          <select name="method">
            <option value="">—</option>
            <option value="mpesa" ${isEdit && e.method === 'mpesa' ? 'selected' : ''}>Mpesa</option>
            <option value="card" ${isEdit && e.method === 'card' ? 'selected' : ''}>Card</option>
            <option value="bank" ${isEdit && e.method === 'bank' ? 'selected' : ''}>Bank</option>
            <option value="cash" ${isEdit && e.method === 'cash' ? 'selected' : ''}>Cash</option>
            <option value="cheque" ${isEdit && e.method === 'cheque' ? 'selected' : ''}>Cheque</option>
          </select>
        </label>
      </div>
      <div class="form-row">
        <label>
          <span>Start date</span>
          <input type="date" name="start_date" required value="${isEdit ? e.start_date : todayISO()}">
        </label>
        <label>
          <span>Next due <span class="hint">(auto from start if blank)</span></span>
          <input type="date" name="next_due" value="${isEdit && e.next_due ? e.next_due : ''}">
        </label>
      </div>
      ${isEdit ? `
        <label>
          <span>Status</span>
          <select name="status">
            <option value="active" ${e.status === 'active' ? 'selected' : ''}>Active</option>
            <option value="paused" ${e.status === 'paused' ? 'selected' : ''}>Paused</option>
            <option value="cancelled" ${e.status === 'cancelled' ? 'selected' : ''}>Cancelled</option>
            <option value="completed" ${e.status === 'completed' ? 'selected' : ''}>Completed</option>
          </select>
        </label>
      ` : ''}
      <label>
        <span>Notes <span class="hint">(optional)</span></span>
        <textarea name="notes">${isEdit && e.notes ? escapeHtml(e.notes) : ''}</textarea>
      </label>
      <p class="error hidden" id="expenseFormErr"></p>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn-primary">${isEdit ? 'Save changes' : 'Add expense'}</button>
      </div>
    </form>
  `;
}

window.editExpense = function (id) {
  const e = id != null ? state.expenses.find((x) => x.id === id) : null;
  openModal(expenseFormHtml(e));
  $('#expenseForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const body = {
      name: fd.get('name').trim(),
      category: (fd.get('category') || '').trim() || null,
      amount: Number(fd.get('amount')) || 0,
      plan: fd.get('plan'),
      method: fd.get('method') || null,
      start_date: fd.get('start_date'),
      next_due: fd.get('next_due') || null,
      notes: (fd.get('notes') || '').trim() || null,
      status: fd.get('status') || 'active',
    };
    try {
      if (e) await api(`/api/expenses/${e.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/api/expenses', { method: 'POST', body: JSON.stringify(body) });
      await loadData();
      closeModal();
      toast(e ? 'Expense updated' : 'Expense added');
    } catch (err) {
      const errEl = $('#expenseFormErr');
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });
};

window.deleteExpense = function (id) {
  const e = state.expenses.find((x) => x.id === id);
  if (!e) return;
  const payCount = state.expense_payments.filter((p) => p.expense_id === id).length;
  const totalPaid = state.expense_payments
    .filter((p) => p.expense_id === id)
    .reduce((s, p) => s + p.amount, 0);

  openModal(`
    <h2 style="color: var(--red);">Delete ${escapeHtml(e.name)}?</h2>
    <p class="muted" style="margin-bottom:14px;">This permanently removes:</p>
    <ul class="muted" style="margin: 0 0 14px 20px; font-size: 14px; line-height: 1.7;">
      <li>The expense record</li>
      <li>${payCount} payment record${payCount === 1 ? '' : 's'}${totalPaid > 0 ? ` totalling ${fmtKES(totalPaid)}` : ''}</li>
    </ul>
    <p class="muted" style="margin-bottom:14px;">This can't be undone. If you just want to stop the recurrence, edit it and set status to <strong>Cancelled</strong> instead.</p>
    <form id="deleteExpenseForm">
      <label>
        <span>Type <strong style="font-family: 'Geist Mono', monospace;">${escapeHtml(e.name)}</strong> to confirm</span>
        <input type="text" id="deleteExpConfirmInput" autocomplete="off" autofocus>
      </label>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn-danger-solid" id="deleteExpConfirmBtn" disabled>Delete expense</button>
      </div>
    </form>
  `);
  const input = $('#deleteExpConfirmInput');
  const btn = $('#deleteExpConfirmBtn');
  input.addEventListener('input', () => {
    btn.disabled = input.value.trim() !== e.name;
  });
  $('#deleteExpenseForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (input.value.trim() !== e.name) return;
    btn.disabled = true;
    try {
      await api(`/api/expenses/${id}`, { method: 'DELETE' });
      await loadData();
      closeModal();
      toast(`${e.name} deleted`);
    } catch (err) {
      btn.disabled = false;
      toast(err.message, 'error');
    }
  });
};

function expensePaymentFormHtml(preselect) {
  const opts = state.expenses
    .filter((e) => e.status === 'active' || e.id === (preselect && preselect.id))
    .map((e) => `<option value="${e.id}" ${preselect && preselect.id === e.id ? 'selected' : ''}>${escapeAttr(e.name)} — ${fmtKES(e.amount)}</option>`)
    .join('');
  const amount = preselect ? preselect.amount : '';
  const method = preselect && preselect.method ? preselect.method : '';
  return `
    <h2>Log expense payment</h2>
    <form id="expensePaymentForm">
      <label>
        <span>Expense</span>
        <select name="expense_id" required>
          <option value="">Pick an expense…</option>
          ${opts}
        </select>
      </label>
      <div class="form-row">
        <label>
          <span>Amount (Ksh)</span>
          <input type="number" name="amount" min="1" step="1" required value="${amount}" autofocus>
        </label>
        <label>
          <span>Paid on</span>
          <input type="date" name="paid_on" required value="${todayISO()}">
        </label>
      </div>
      <div class="form-row">
        <label>
          <span>Method</span>
          <select name="method">
            <option value="">—</option>
            <option value="mpesa" ${method === 'mpesa' ? 'selected' : ''}>Mpesa</option>
            <option value="card" ${method === 'card' ? 'selected' : ''}>Card</option>
            <option value="bank" ${method === 'bank' ? 'selected' : ''}>Bank</option>
            <option value="cash" ${method === 'cash' ? 'selected' : ''}>Cash</option>
            <option value="cheque" ${method === 'cheque' ? 'selected' : ''}>Cheque</option>
          </select>
        </label>
        <label>
          <span>Reference <span class="hint">(receipt, txn id)</span></span>
          <input type="text" name="reference">
        </label>
      </div>
      <label>
        <span>Notes <span class="hint">(optional)</span></span>
        <textarea name="notes"></textarea>
      </label>
      <p class="error hidden" id="expensePayFormErr"></p>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn-primary">Log payment</button>
      </div>
    </form>
  `;
}

window.logExpensePayment = function (expenseId) {
  const preselect = expenseId != null ? state.expenses.find((e) => e.id === expenseId) : null;
  openModal(expensePaymentFormHtml(preselect));
  $('#expensePaymentForm select[name="expense_id"]').addEventListener('change', (ev) => {
    const e = state.expenses.find((x) => x.id === Number(ev.target.value));
    if (e) {
      $('#expensePaymentForm input[name="amount"]').value = e.amount;
      if (e.method) $('#expensePaymentForm select[name="method"]').value = e.method;
    }
  });
  $('#expensePaymentForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const body = {
      expense_id: Number(fd.get('expense_id')),
      amount: Number(fd.get('amount')) || 0,
      paid_on: fd.get('paid_on'),
      method: fd.get('method') || null,
      reference: (fd.get('reference') || '').trim() || null,
      notes: (fd.get('notes') || '').trim() || null,
    };
    try {
      await api('/api/expense-payments', { method: 'POST', body: JSON.stringify(body) });
      await loadData();
      closeModal();
      toast('Expense payment logged');
    } catch (err) {
      const errEl = $('#expensePayFormErr');
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });
};

// Ad-hoc / one-off expense: creates the expense AND its payment in one go.
window.recordQuickExpense = function () {
  openModal(`
    <h2>Record expense</h2>
    <p class="muted" style="margin-bottom:14px;">For one-off costs that just came up. For recurring bills like GHL, use "+ Add recurring" instead.</p>
    <form id="quickExpenseForm">
      <label>
        <span>What was it?</span>
        <input type="text" name="name" required placeholder="Printer toner, taxi, lunch with client…" autofocus>
      </label>
      <div class="form-row">
        <label>
          <span>Amount (Ksh)</span>
          <input type="number" name="amount" min="1" step="1" required>
        </label>
        <label>
          <span>Paid on</span>
          <input type="date" name="paid_on" required value="${todayISO()}">
        </label>
      </div>
      <div class="form-row">
        <label>
          <span>Category <span class="hint">(optional)</span></span>
          <input type="text" name="category" placeholder="supplies, transport, food…">
        </label>
        <label>
          <span>Method</span>
          <select name="method">
            <option value="">—</option>
            <option value="mpesa">Mpesa</option>
            <option value="card">Card</option>
            <option value="bank">Bank</option>
            <option value="cash">Cash</option>
            <option value="cheque">Cheque</option>
          </select>
        </label>
      </div>
      <label>
        <span>Reference <span class="hint">(receipt, txn id — optional)</span></span>
        <input type="text" name="reference">
      </label>
      <label>
        <span>Notes <span class="hint">(optional)</span></span>
        <textarea name="notes"></textarea>
      </label>
      <p class="error hidden" id="quickExpenseErr"></p>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn-primary">Record</button>
      </div>
    </form>
  `);
  $('#quickExpenseForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const name = fd.get('name').trim();
    const amount = Number(fd.get('amount')) || 0;
    const paid_on = fd.get('paid_on');
    const method = fd.get('method') || null;
    const category = (fd.get('category') || '').trim() || null;
    const reference = (fd.get('reference') || '').trim() || null;
    const notes = (fd.get('notes') || '').trim() || null;
    try {
      const expenseRes = await api('/api/expenses', {
        method: 'POST',
        body: JSON.stringify({
          name,
          category,
          amount,
          plan: 'one-off',
          method,
          start_date: paid_on,
          next_due: null,
          notes,
          status: 'active',
        }),
      });
      const expenseId = expenseRes.expense.id;
      await api('/api/expense-payments', {
        method: 'POST',
        body: JSON.stringify({
          expense_id: expenseId,
          amount,
          paid_on,
          method,
          reference,
          notes,
        }),
      });
      await loadData();
      closeModal();
      toast('Expense recorded');
    } catch (err) {
      const errEl = $('#quickExpenseErr');
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });
};

window.deleteExpensePayment = async function (id) {
  if (!confirm('Delete this expense payment record? Does not reverse the next-due bump.')) return;
  try {
    await api(`/api/expense-payments/${id}`, { method: 'DELETE' });
    await loadData();
    toast('Expense payment deleted');
  } catch (err) {
    toast(err.message, 'error');
  }
};

// ────────── Revenue tab ──────────

// Period boundaries snap to calendar-month starts so accrual math is clean.
// Returns { start, end } so "Last month" can cut off before today.
function periodRange(period) {
  const today = parseISO(todayISO());
  const ymStart = (y, m) => `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const ymEnd = (y, m) => new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
  if (period === '30d') {
    return { start: ymStart(today.getFullYear(), today.getMonth()), end: todayISO() };
  }
  if (period === 'lastmo') {
    const d = new Date(today);
    d.setMonth(d.getMonth() - 1);
    return {
      start: ymStart(d.getFullYear(), d.getMonth()),
      end: ymEnd(d.getFullYear(), d.getMonth()),
    };
  }
  if (period === '6mo') {
    const d = new Date(today);
    d.setMonth(d.getMonth() - 5);
    return { start: ymStart(d.getFullYear(), d.getMonth()), end: todayISO() };
  }
  if (period === '1yr') {
    const d = new Date(today);
    d.setMonth(d.getMonth() - 11);
    return { start: ymStart(d.getFullYear(), d.getMonth()), end: todayISO() };
  }
  return { start: '0000-01-01', end: todayISO() };
}

// ────────── Accrual helpers ──────────
// "Accrual" = smooth quarterly billings across 3 months, count income for the
// period a client was active even if cash hasn't actually landed yet.

function lastDayOfMonth(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
function nextMonth(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
}
function monthsInPeriod(startIso, endIso) {
  const months = [];
  let cursor = startIso.slice(0, 7);
  const endMonth = endIso.slice(0, 7);
  while (cursor <= endMonth) {
    months.push(cursor);
    cursor = nextMonth(cursor);
  }
  return months;
}

function clientMonthlyContribution(c) {
  if (c.plan === 'monthly') return c.amount;
  if (c.plan === 'quarterly') return c.amount / 3;
  return 0; // one-off handled via actual payments
}
function expenseMonthlyContribution(e) {
  if (e.plan === 'monthly') return e.amount;
  if (e.plan === 'quarterly') return e.amount / 3;
  return 0;
}

// For current/future months: only `active` status counts.
// For past months: include `active` + `paused` (we don't track when status
// changed, so we assume past months had them on).
function entityActiveInMonth(entity, monthIso) {
  const monthEnd = lastDayOfMonth(monthIso);
  if (entity.start_date > monthEnd) return false;
  const todayMonth = todayISO().slice(0, 7);
  if (monthIso >= todayMonth) return entity.status === 'active';
  return entity.status === 'active' || entity.status === 'paused';
}

function accrualRevenueForMonth(monthIso) {
  let total = 0;
  for (const c of state.clients) {
    if (c.plan === 'one-off') continue;
    if (!entityActiveInMonth(c, monthIso)) continue;
    total += clientMonthlyContribution(c);
  }
  const monthStart = monthIso + '-01';
  const monthEnd = lastDayOfMonth(monthIso);
  for (const p of state.payments) {
    const c = state.clients.find((x) => x.id === p.client_id);
    if (c && c.plan === 'one-off' && p.paid_on >= monthStart && p.paid_on <= monthEnd) {
      total += p.amount;
    }
  }
  return total;
}

function accrualExpenseForMonth(monthIso) {
  let total = 0;
  for (const e of state.expenses) {
    if (e.plan === 'one-off') continue;
    if (!entityActiveInMonth(e, monthIso)) continue;
    total += expenseMonthlyContribution(e);
  }
  const monthStart = monthIso + '-01';
  const monthEnd = lastDayOfMonth(monthIso);
  for (const p of state.expense_payments) {
    const e = state.expenses.find((x) => x.id === p.expense_id);
    if (e && e.plan === 'one-off' && p.paid_on >= monthStart && p.paid_on <= monthEnd) {
      total += p.amount;
    }
  }
  return total;
}

function accrualRevenueForPeriod(startIso, endIso = todayISO()) {
  return monthsInPeriod(startIso, endIso).reduce((s, m) => s + accrualRevenueForMonth(m), 0);
}
function accrualExpenseForPeriod(startIso, endIso = todayISO()) {
  return monthsInPeriod(startIso, endIso).reduce((s, m) => s + accrualExpenseForMonth(m), 0);
}

function clientPeriodAccrual(c, startIso, endIso = todayISO()) {
  let total = 0;
  if (c.plan !== 'one-off') {
    for (const m of monthsInPeriod(startIso, endIso)) {
      if (entityActiveInMonth(c, m)) total += clientMonthlyContribution(c);
    }
  } else {
    state.payments
      .filter((p) => p.client_id === c.id && p.paid_on >= startIso && p.paid_on <= endIso)
      .forEach((p) => { total += p.amount; });
  }
  return total;
}

function renderRevenue() {
  const p = state.revenuePeriod;
  const { start, end } = periodRange(p);
  const total = accrualRevenueForPeriod(start, end);
  const totalExpenses = accrualExpenseForPeriod(start, end);
  const net = total - totalExpenses;

  const mrr = state.clients
    .filter((c) => c.status === 'active' && c.plan !== 'one-off')
    .reduce((s, c) => s + clientMonthlyContribution(c), 0);
  const burn = state.expenses
    .filter((e) => e.status === 'active' && e.plan !== 'one-off')
    .reduce((s, e) => s + expenseMonthlyContribution(e), 0);
  const netMonthly = mrr - burn;

  $('#revenueSummary').innerHTML = `
    <div class="kpi-card clickable" onclick="showRevenueBreakdown()">
      <div class="kpi-label">Revenue ${periodWord(p)}</div>
      <div class="kpi-value">${fmtKES(total)}</div>
      <div class="kpi-sub">expected (quarterly /3)</div>
      <div class="breakdown-link">See breakdown →</div>
    </div>
    <div class="kpi-card clickable" onclick="showExpenseBreakdown()">
      <div class="kpi-label">Expenses ${periodWord(p)}</div>
      <div class="kpi-value">${fmtKES(totalExpenses)}</div>
      <div class="kpi-sub">expected</div>
      <div class="breakdown-link">See breakdown →</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Net ${periodWord(p)}</div>
      <div class="kpi-value ${net < 0 ? 'danger' : ''}">${fmtKES(net)}</div>
      <div class="kpi-sub">${total > 0 ? pct(net, total) + '% margin' : '—'}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Net monthly</div>
      <div class="kpi-value ${netMonthly < 0 ? 'danger' : ''}">${fmtKES(netMonthly)}</div>
      <div class="kpi-sub">MRR ${fmtKES(mrr)} − burn ${fmtKES(burn)}</div>
    </div>
  `;

  renderBarChart();
  renderTopClients(start, end);
}

function periodWord(p) {
  const today = parseISO(todayISO());
  if (p === '30d') {
    return `(${today.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })})`;
  }
  if (p === 'lastmo') {
    const d = new Date(today);
    d.setMonth(d.getMonth() - 1);
    return `(${d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })})`;
  }
  if (p === '6mo') return '(6 months)';
  if (p === '1yr') return '(12 months)';
  return '(all time)';
}

function pct(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 100);
}

function renderBarChart() {
  const today = parseISO(todayISO());
  const todayMonth = todayISO().slice(0, 7);

  // 12 months ending with the current month.
  // Build the YYYY-MM key from local year/month (not toISOString) — in Nairobi
  // UTC+3, toISOString() of a local-midnight Date lands in the previous day's
  // UTC, shifting the month key one back. That bug made every bar label one
  // month ahead of the data it was showing.
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    months.push({ key: `${y}-${m}`, label: d.toLocaleDateString('en-GB', { month: 'short' }), total: 0 });
  }
  for (const m of months) {
    m.total = accrualRevenueForMonth(m.key);
  }
  const max = Math.max(...months.map((m) => m.total), 1);

  $('#revenueChart').innerHTML = `
    <div class="bar-chart">
      ${months.map((m) => {
        const pct = (m.total / max) * 100;
        const isCurrent = m.key === todayMonth;
        return `
          <div class="bar-col${isCurrent ? ' current' : ''}${m.total > 0 ? ' clickable-bar' : ''}" ${m.total > 0 ? `onclick="showMonthBreakdown('${m.key}')"` : ''}>
            <div class="bar-value">${m.total > 0 ? shortNum(m.total) : ''}</div>
            ${m.total > 0
              ? `<div class="bar" style="height: ${pct}%; min-height: 4px;" title="${m.label}: ${fmtKES(m.total)} — click to see breakdown"></div>`
              : `<div class="bar-spacer"></div>`}
            <div class="bar-label">${m.label}</div>
          </div>
        `;
      }).join('')}
    </div>`;
}

function shortNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return Math.round(n / 1000) + 'k';
  return String(n);
}

function renderTopClients(startIso, endIso) {
  const titleEl = $('#topClientsTitle');
  if (titleEl) titleEl.textContent = `Top clients ${periodWord(state.revenuePeriod)}`;
  const rows = state.clients
    .map((c) => ({ name: c.name, total: clientPeriodAccrual(c, startIso, endIso) }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  const el = $('#topClients');
  if (rows.length === 0) {
    el.innerHTML = '<div class="empty">No clients active in this period.</div>';
    return;
  }
  el.innerHTML = rows.map((r) => `
    <div class="list-row">
      <div class="primary">${escapeHtml(r.name)}</div>
      <div class="amount num">${fmtKES(r.total)}</div>
    </div>
  `).join('');
}

// ────────── Breakdowns ──────────

function buildRevenueBreakdownData(startIso, endIso) {
  const months = monthsInPeriod(startIso, endIso);
  const recurring = state.clients
    .filter((c) => c.plan !== 'one-off')
    .map((c) => {
      const monthsActive = months.filter((m) => entityActiveInMonth(c, m)).length;
      const perMonth = clientMonthlyContribution(c);
      const paymentsInPeriod = state.payments
        .filter((p) => p.client_id === c.id && p.paid_on >= startIso && p.paid_on <= endIso)
        .sort((a, b) => b.paid_on.localeCompare(a.paid_on));
      return {
        name: c.name,
        plan: c.plan,
        amount: c.amount,
        perMonth,
        monthsActive,
        paidCount: paymentsInPeriod.length,
        lastPaidOn: paymentsInPeriod[0]?.paid_on || null,
        next_due: c.next_due,
        total: perMonth * monthsActive,
      };
    })
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total);

  const oneOff = state.payments
    .filter((p) => p.paid_on >= startIso && p.paid_on <= endIso)
    .map((p) => ({ payment: p, client: state.clients.find((c) => c.id === p.client_id) }))
    .filter((x) => x.client && x.client.plan === 'one-off')
    .map((x) => ({ name: x.client.name, paid_on: x.payment.paid_on, amount: x.payment.amount, reference: x.payment.reference }))
    .sort((a, b) => b.paid_on.localeCompare(a.paid_on));

  return {
    recurring,
    oneOff,
    recurringTotal: recurring.reduce((s, r) => s + r.total, 0),
    oneOffTotal: oneOff.reduce((s, r) => s + r.amount, 0),
    monthCount: months.length,
  };
}

function buildExpenseBreakdownData(startIso, endIso) {
  const months = monthsInPeriod(startIso, endIso);
  const recurring = state.expenses
    .filter((e) => e.plan !== 'one-off')
    .map((e) => {
      const monthsActive = months.filter((m) => entityActiveInMonth(e, m)).length;
      const perMonth = expenseMonthlyContribution(e);
      const paymentsInPeriod = state.expense_payments
        .filter((p) => p.expense_id === e.id && p.paid_on >= startIso && p.paid_on <= endIso)
        .sort((a, b) => b.paid_on.localeCompare(a.paid_on));
      return {
        name: e.name,
        plan: e.plan,
        amount: e.amount,
        perMonth,
        monthsActive,
        paidCount: paymentsInPeriod.length,
        lastPaidOn: paymentsInPeriod[0]?.paid_on || null,
        next_due: e.next_due,
        total: perMonth * monthsActive,
      };
    })
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total);

  const oneOff = state.expense_payments
    .filter((p) => p.paid_on >= startIso && p.paid_on <= endIso)
    .map((p) => ({ payment: p, expense: state.expenses.find((e) => e.id === p.expense_id) }))
    .filter((x) => x.expense && x.expense.plan === 'one-off')
    .map((x) => ({ name: x.expense.name, paid_on: x.payment.paid_on, amount: x.payment.amount, reference: x.payment.reference }))
    .sort((a, b) => b.paid_on.localeCompare(a.paid_on));

  return {
    recurring,
    oneOff,
    recurringTotal: recurring.reduce((s, r) => s + r.total, 0),
    oneOffTotal: oneOff.reduce((s, r) => s + r.amount, 0),
    monthCount: months.length,
  };
}

function paymentStatusLabel(r) {
  if (r.paidCount > 0) {
    const datePart = fmtDate(r.lastPaidOn);
    if (r.paidCount === 1) return `<span class="status-paid">Paid ${datePart}</span>`;
    return `<span class="status-paid">Paid ${r.paidCount}×, latest ${datePart}</span>`;
  }
  if (r.next_due) {
    const today = todayISO();
    if (r.next_due < today) return `<span class="status-overdue">Overdue ${fmtDate(r.next_due)}</span>`;
    return `<span class="status-expected">Due ${fmtDate(r.next_due)}</span>`;
  }
  return `<span class="status-expected">Expected</span>`;
}

function breakdownTableHtml(title, recurring, oneOff, recurringTotal, oneOffTotal, monthCount) {
  const showMonthsCol = monthCount > 1;
  const recurringSection = recurring.length ? `
    <div class="breakdown-section">
      <div class="breakdown-section-title">Recurring (smoothed)</div>
      <table class="breakdown-table">
        <tbody>
          ${recurring.map((r) => `
            <tr>
              <td>
                <div>${escapeHtml(r.name)}</div>
                <div class="row-meta">${planLabel(r.plan)}${r.plan === 'quarterly' ? ` · ${fmtKES(r.amount)}/3 = ${fmtKES(r.perMonth)}/mo` : ` · ${fmtKES(r.perMonth)}/mo`} · ${paymentStatusLabel(r)}</div>
              </td>
              ${showMonthsCol ? `<td class="num muted-2">× ${r.monthsActive}</td>` : ''}
              <td class="num strong">${fmtKES(r.total)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div class="breakdown-subtotal">Subtotal · <span class="num">${fmtKES(recurringTotal)}</span></div>
    </div>
  ` : '';

  const oneOffSection = oneOff.length ? `
    <div class="breakdown-section">
      <div class="breakdown-section-title">One-off (actuals)</div>
      <table class="breakdown-table">
        <tbody>
          ${oneOff.map((p) => `
            <tr>
              <td>
                <div>${escapeHtml(p.name)}</div>
                <div class="row-meta"><span class="status-paid">Paid ${fmtDate(p.paid_on)}</span>${p.reference ? ` · ref ${escapeHtml(p.reference)}` : ''}</div>
              </td>
              <td class="num strong">${fmtKES(p.amount)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div class="breakdown-subtotal">Subtotal · <span class="num">${fmtKES(oneOffTotal)}</span></div>
    </div>
  ` : '';

  const total = recurringTotal + oneOffTotal;
  const emptyState = recurring.length === 0 && oneOff.length === 0
    ? `<p class="muted" style="text-align:center; padding:20px 0;">Nothing recorded in this period.</p>` : '';

  return `
    <h2>${title}</h2>
    <p class="muted breakdown-note">Recurring contributions are smoothed (quarterly ÷ 3) across active months. One-offs count as actual cash on the date paid.</p>
    ${emptyState}
    ${recurringSection}
    ${oneOffSection}
    ${(recurring.length || oneOff.length) ? `
      <div class="breakdown-total">
        <span>Total</span>
        <span class="num">${fmtKES(total)}</span>
      </div>
    ` : ''}
    <div class="modal-actions">
      <button type="button" class="btn-primary" onclick="closeModal()">Close</button>
    </div>
  `;
}

// Drill into one specific calendar month (used when clicking a bar in the chart)
window.showMonthBreakdown = function (monthIso) {
  const start = monthIso + '-01';
  const end = lastDayOfMonth(monthIso);
  const d = buildRevenueBreakdownData(start, end);
  // Pretty title: "Revenue (May 2026)"
  const [y, m] = monthIso.split('-').map(Number);
  const label = new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  openModal(breakdownTableHtml(`Revenue (${label})`, d.recurring, d.oneOff, d.recurringTotal, d.oneOffTotal, d.monthCount));
};

window.showRevenueBreakdown = function () {
  const { start, end } = periodRange(state.revenuePeriod);
  const d = buildRevenueBreakdownData(start, end);
  openModal(breakdownTableHtml(`Revenue ${periodWord(state.revenuePeriod)}`, d.recurring, d.oneOff, d.recurringTotal, d.oneOffTotal, d.monthCount));
};

window.showExpenseBreakdown = function () {
  const { start, end } = periodRange(state.revenuePeriod);
  const d = buildExpenseBreakdownData(start, end);
  openModal(breakdownTableHtml(`Expenses ${periodWord(state.revenuePeriod)}`, d.recurring, d.oneOff, d.recurringTotal, d.oneOffTotal, d.monthCount));
};

// Segmented period control
$('#revenuePeriod').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.revenuePeriod = btn.dataset.p;
  $$('#revenuePeriod button').forEach((b) => b.classList.toggle('active', b === btn));
  renderRevenue();
});

// ────────── Forms ──────────

$('#addClientBtn').addEventListener('click', () => editClient(null));
$('#addPaymentBtn').addEventListener('click', () => recordPayment(null));
$('#addExpenseBtn').addEventListener('click', () => editExpense(null));
$('#logExpensePaymentBtn').addEventListener('click', () => logExpensePayment(null));
$('#quickExpenseBtn').addEventListener('click', () => recordQuickExpense());
$('#dashAddClientBtn').addEventListener('click', () => editClient(null));
$('#dashRecordPaymentBtn').addEventListener('click', () => recordPayment(null));

$('#upcomingWindow').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.upcomingDays = Number(btn.dataset.days);
  $$('#upcomingWindow button').forEach((b) => b.classList.toggle('active', b === btn));
  renderUpcoming();
});

$('#clientFilter').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.clientFilter = btn.dataset.filter;
  $$('#clientFilter .filter-pill').forEach((b) => b.classList.toggle('active', b === btn));
  renderClientsList();
});

function servicesFieldHtml(selected) {
  const sel = new Set(selected || []);
  return `
    <label>
      <span>Services <span class="hint">(what they pay for, pick any)</span></span>
      <div class="services-grid">
        ${SERVICES_CATEGORIES.map((cat) => `
          <div class="service-group">
            <div class="service-group-name">${cat.name}</div>
            ${cat.items.map((s) => `
              <label class="check">
                <input type="checkbox" name="services" value="${s.value}" ${sel.has(s.value) ? 'checked' : ''}>
                <span>${escapeHtml(s.label)}</span>
              </label>
            `).join('')}
          </div>
        `).join('')}
      </div>
    </label>
  `;
}

function servicesChips(services) {
  if (!services || !services.length) return '';
  return services
    .map((s) => `<span class="service-chip">${escapeHtml(SERVICE_LABEL[s] || s)}</span>`)
    .join('');
}

function clientFormHtml(c) {
  const isEdit = !!c;
  return `
    <h2>${isEdit ? 'Edit client' : 'Add client'}</h2>
    <form id="clientForm">
      <label>
        <span>Name</span>
        <input type="text" name="name" required value="${isEdit ? escapeAttr(c.name) : ''}" autofocus>
      </label>
      <label>
        <span>Business <span class="hint">(optional)</span></span>
        <input type="text" name="business" value="${isEdit && c.business ? escapeAttr(c.business) : ''}">
      </label>
      <div class="form-row">
        <label>
          <span>Plan</span>
          <select name="plan" required>
            <option value="monthly" ${isEdit && c.plan === 'monthly' ? 'selected' : ''}>Monthly</option>
            <option value="quarterly" ${isEdit && c.plan === 'quarterly' ? 'selected' : ''}>Every 3 months</option>
            <option value="one-off" ${isEdit && c.plan === 'one-off' ? 'selected' : ''}>One off</option>
          </select>
        </label>
        <label>
          <span>Amount (Ksh)</span>
          <input type="number" name="amount" min="0" step="1" value="${isEdit ? c.amount : ''}" required>
        </label>
      </div>
      <div class="form-row">
        <label>
          <span>Start date</span>
          <input type="date" name="start_date" required value="${isEdit ? c.start_date : todayISO()}">
        </label>
        <label>
          <span>Next due <span class="hint">(auto from start if blank)</span></span>
          <input type="date" name="next_due" value="${isEdit && c.next_due ? c.next_due : ''}">
        </label>
      </div>
      <div class="form-row">
        <label>
          <span>Payment method</span>
          <select name="method">
            <option value="">—</option>
            <option value="mpesa" ${isEdit && c.method === 'mpesa' ? 'selected' : ''}>Mpesa</option>
            <option value="cheque" ${isEdit && c.method === 'cheque' ? 'selected' : ''}>Cheque</option>
            <option value="bank" ${isEdit && c.method === 'bank' ? 'selected' : ''}>Bank</option>
            <option value="cash" ${isEdit && c.method === 'cash' ? 'selected' : ''}>Cash</option>
          </select>
        </label>
        <label>
          <span>Reminder method</span>
          <select name="reminder_method">
            <option value="whatsapp" ${!isEdit || c.reminder_method === 'whatsapp' ? 'selected' : ''}>WhatsApp</option>
            <option value="email" ${isEdit && c.reminder_method === 'email' ? 'selected' : ''}>Email (copy draft)</option>
            <option value="kra_invoice" ${isEdit && c.reminder_method === 'kra_invoice' ? 'selected' : ''}>KRA invoice (no reminder)</option>
            <option value="none" ${isEdit && c.reminder_method === 'none' ? 'selected' : ''}>None</option>
          </select>
        </label>
      </div>
      <div class="form-row">
        <label>
          <span>Phone <span class="hint">(needed for WhatsApp reminders)</span></span>
          <input type="tel" name="phone" placeholder="+254712345678" value="${isEdit && c.phone ? escapeAttr(c.phone) : ''}">
        </label>
        <label>
          <span>Email <span class="hint">(needed for email reminders)</span></span>
          <input type="email" name="email" value="${isEdit && c.email ? escapeAttr(c.email) : ''}">
        </label>
      </div>
      ${isEdit ? `
        <label>
          <span>Status</span>
          <select name="status">
            <option value="active" ${c.status === 'active' ? 'selected' : ''}>Active</option>
            <option value="paused" ${c.status === 'paused' ? 'selected' : ''}>Paused</option>
            <option value="churned" ${c.status === 'churned' ? 'selected' : ''}>Churned</option>
            <option value="completed" ${c.status === 'completed' ? 'selected' : ''}>Completed</option>
          </select>
        </label>
      ` : ''}
      ${servicesFieldHtml(isEdit ? (c.services || []) : [])}
      <label>
        <span>Notes <span class="hint">(optional)</span></span>
        <textarea name="notes">${isEdit && c.notes ? escapeHtml(c.notes) : ''}</textarea>
      </label>
      <div class="form-section">
        <div class="form-section-title">Upsell follow-up</div>
        <label>
          <span>What could you offer them next? <span class="hint">(optional)</span></span>
          <textarea name="upsell_notes" placeholder="AI Chat, CRM, Social Planner, Ads…">${isEdit && c.upsell_notes ? escapeHtml(c.upsell_notes) : ''}</textarea>
        </label>
        <label>
          <span>Remind me to follow up on <span class="hint">(defaults to 3 months out for new one-offs)</span></span>
          <input type="date" name="upsell_followup_date" value="${isEdit && c.upsell_followup_date ? c.upsell_followup_date : (!isEdit ? addMonthsISO(todayISO(), 3) : '')}">
        </label>
      </div>
      <p class="error hidden" id="clientFormErr"></p>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn-primary">${isEdit ? 'Save changes' : 'Add client'}</button>
      </div>
    </form>
  `;
}

window.editClient = function (id) {
  const c = id != null ? state.clients.find((x) => x.id === id) : null;
  openModal(clientFormHtml(c));
  $('#clientForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      name: fd.get('name').trim(),
      business: fd.get('business').trim() || null,
      plan: fd.get('plan'),
      amount: Number(fd.get('amount')) || 0,
      start_date: fd.get('start_date'),
      next_due: fd.get('next_due') || null,
      method: fd.get('method') || null,
      phone: (fd.get('phone') || '').trim() || null,
      email: (fd.get('email') || '').trim() || null,
      notes: (fd.get('notes') || '').trim() || null,
      status: fd.get('status') || 'active',
      reminder_method: fd.get('reminder_method') || 'whatsapp',
      services: fd.getAll('services'),
      upsell_notes: (fd.get('upsell_notes') || '').trim() || null,
      upsell_followup_date: fd.get('upsell_followup_date') || null,
    };
    try {
      if (c) await api(`/api/clients/${c.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/api/clients', { method: 'POST', body: JSON.stringify(body) });
      await loadData();
      closeModal();
      toast(c ? 'Client updated' : 'Client added');
    } catch (err) {
      const errEl = $('#clientFormErr');
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });
};

window.deleteClient = function (id) {
  const c = state.clients.find((x) => x.id === id);
  if (!c) return;
  const paymentCount = state.payments.filter((p) => p.client_id === id).length;
  const scheduledCount = state.scheduled_payments.filter((s) => s.client_id === id).length;
  const totalReceived = state.payments
    .filter((p) => p.client_id === id)
    .reduce((s, p) => s + p.amount, 0);

  openModal(`
    <h2 style="color: var(--red);">Delete ${escapeHtml(c.name)}?</h2>
    <p class="muted" style="margin-bottom:14px;">This permanently removes:</p>
    <ul class="muted" style="margin: 0 0 14px 20px; font-size: 14px; line-height: 1.7;">
      <li>The client record itself</li>
      <li>${paymentCount} payment record${paymentCount === 1 ? '' : 's'}${totalReceived > 0 ? ` totalling ${fmtKES(totalReceived)}` : ''}</li>
      ${scheduledCount > 0 ? `<li>${scheduledCount} scheduled payment${scheduledCount === 1 ? '' : 's'}</li>` : ''}
    </ul>
    <p class="muted" style="margin-bottom:14px;">This can't be undone. If you just want to stop tracking them, edit the client and set status to <strong>Churned</strong> instead.</p>
    <form id="deleteClientForm">
      <label>
        <span>Type <strong style="font-family: 'Geist Mono', monospace;">${escapeHtml(c.name)}</strong> to confirm</span>
        <input type="text" id="deleteConfirmInput" autocomplete="off" autofocus>
      </label>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn-danger-solid" id="deleteConfirmBtn" disabled>Delete client</button>
      </div>
    </form>
  `);
  const input = $('#deleteConfirmInput');
  const btn = $('#deleteConfirmBtn');
  input.addEventListener('input', () => {
    btn.disabled = input.value.trim() !== c.name;
  });
  $('#deleteClientForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (input.value.trim() !== c.name) return;
    btn.disabled = true;
    try {
      await api(`/api/clients/${id}`, { method: 'DELETE' });
      await loadData();
      closeModal();
      toast(`${c.name} deleted`);
    } catch (err) {
      btn.disabled = false;
      toast(err.message, 'error');
    }
  });
};

function paymentFormHtml(preselect, opts) {
  const clientOpts = state.clients
    .filter((c) => c.status === 'active' || c.id === (preselect && preselect.id))
    .map((c) => `<option value="${c.id}" ${preselect && preselect.id === c.id ? 'selected' : ''}>${escapeAttr(c.name)} — ${fmtKES(c.amount)}</option>`)
    .join('');
  const amount = (opts && opts.amount != null) ? opts.amount : (preselect ? preselect.amount : '');
  const method = preselect && preselect.method ? preselect.method : '';
  const refDefault = opts && opts.reference ? opts.reference : '';
  const scheduledId = opts && opts.scheduled_payment_id ? opts.scheduled_payment_id : '';
  return `
    <h2>Record payment</h2>
    ${scheduledId ? '<p class="muted" style="margin-bottom:14px;">This will also clear the scheduled item.</p>' : ''}
    <form id="paymentForm">
      <input type="hidden" name="scheduled_payment_id" value="${scheduledId}">
      <label>
        <span>Client</span>
        <select name="client_id" required ${scheduledId ? 'disabled' : ''}>
          <option value="">Pick a client…</option>
          ${clientOpts}
        </select>
      </label>
      <div class="form-row">
        <label>
          <span>Amount (Ksh)</span>
          <input type="number" name="amount" min="1" step="1" required value="${amount}" autofocus>
        </label>
        <label>
          <span>Paid on</span>
          <input type="date" name="paid_on" required value="${todayISO()}">
        </label>
      </div>
      <div class="form-row">
        <label>
          <span>Method</span>
          <select name="method">
            <option value="">—</option>
            <option value="mpesa" ${method === 'mpesa' ? 'selected' : ''}>Mpesa</option>
            <option value="cheque" ${method === 'cheque' ? 'selected' : ''}>Cheque</option>
            <option value="bank" ${method === 'bank' ? 'selected' : ''}>Bank</option>
            <option value="cash" ${method === 'cash' ? 'selected' : ''}>Cash</option>
          </select>
        </label>
        <label>
          <span>Reference <span class="hint">(Mpesa code, cheque #)</span></span>
          <input type="text" name="reference" value="${escapeAttr(refDefault)}">
        </label>
      </div>
      <label>
        <span>Notes <span class="hint">(optional)</span></span>
        <textarea name="notes"></textarea>
      </label>
      <p class="error hidden" id="payFormErr"></p>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn-primary">Record payment</button>
      </div>
    </form>
  `;
}

window.recordPayment = function (clientId, opts) {
  const preselect = clientId != null ? state.clients.find((c) => c.id === clientId) : null;
  openModal(paymentFormHtml(preselect, opts));
  // Auto-fill amount when client changes (only when no scheduled preset)
  if (!opts || !opts.scheduled_payment_id) {
    $('#paymentForm select[name="client_id"]').addEventListener('change', (e) => {
      const c = state.clients.find((x) => x.id === Number(e.target.value));
      if (c) {
        $('#paymentForm input[name="amount"]').value = c.amount;
        if (c.method) $('#paymentForm select[name="method"]').value = c.method;
      }
    });
  }
  $('#paymentForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const clientIdValue = preselect && opts && opts.scheduled_payment_id
      ? preselect.id
      : Number(fd.get('client_id'));
    const sId = fd.get('scheduled_payment_id');
    const body = {
      client_id: clientIdValue,
      amount: Number(fd.get('amount')) || 0,
      paid_on: fd.get('paid_on'),
      method: fd.get('method') || null,
      reference: (fd.get('reference') || '').trim() || null,
      notes: (fd.get('notes') || '').trim() || null,
    };
    if (sId) body.scheduled_payment_id = Number(sId);
    try {
      await api('/api/payments', { method: 'POST', body: JSON.stringify(body) });
      await loadData();
      closeModal();
      toast('Payment recorded');
    } catch (err) {
      const errEl = $('#payFormErr');
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });
};

window.quickPay = function (clientId) {
  recordPayment(clientId);
};

window.deletePayment = async function (id) {
  if (!confirm('Delete this payment record? This does not reverse the client next-due bump.')) return;
  try {
    await api(`/api/payments/${id}`, { method: 'DELETE' });
    await loadData();
    toast('Payment deleted');
  } catch (err) {
    toast(err.message, 'error');
  }
};

// ────────── HTML escape ──────────

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ────────── Boot ──────────

(async function boot() {
  // Tiny version badge in bottom-right corner so cache issues are self-diagnosable
  const badge = document.createElement('div');
  badge.id = 'versionBadge';
  badge.textContent = 'v' + APP_VERSION;
  badge.title = 'App build — useful for diagnosing cache issues. If this doesn\'t match the latest deployed version, hard refresh.';
  document.body.appendChild(badge);

  if (state.token) {
    try {
      await api('/api/auth', { method: 'POST' });
      showApp();
      await loadData();
    } catch {
      showLogin();
    }
  } else {
    showLogin();
  }
})();
