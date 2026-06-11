// Clients Dashboard — front-end logic
// Talks to the CF Worker over fetch. Single global state, re-render on data change.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const API_BASE = 'https://clients-dashboard-api.stawisystems.workers.dev';
const APP_VERSION = '20260611-1';
console.log(`%c[Billing] app.js loaded — version ${APP_VERSION}`, 'color:#ff8424;font-weight:600');

// Service catalogue, sourced from essenceautomations.com
const SERVICES_CATEGORIES = [
  { name: 'Get Found', items: [
    { value: 'websites', label: 'Website' },
    { value: 'catalog-website', label: 'Catalogue Website' },
    { value: 'shopfront-oneoff', label: 'Shopfront (one-off)' },
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
  prospects: [],
  activeTab: 'dashboard',
  revenuePeriod: '30d',
  clientFilter: 'all',
  clientSearch: '',
  prospectFilter: 'open',
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
  state.prospects = data.prospects || [];
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
  renderProspectFollowups();
  renderRecent();
  renderClientsList();
  renderProspects();
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
      invoiceDate: c.invoice_sent_for_next_due === c.next_due ? c.invoice_sent_date : null,
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
      invoiceDate: s.invoice_sent_on || null,
    });
  }
  return items.sort((a, b) => a.due.localeCompare(b.due));
}

window.toggleInvoice = async function (kind, id, currentlySent) {
  const sent = !currentlySent;
  // Undoing (currentlySent === true) needs a heads-up — it resets the row to
  // "invoice needed" and the client could mistake it for "not yet billed".
  if (currentlySent) {
    const c = kind === 'scheduled'
      ? state.clients.find((x) => x.id === (state.scheduled_payments.find((s) => s.id === id) || {}).client_id)
      : state.clients.find((x) => x.id === id);
    const who = c ? c.name : 'this client';
    const ok = confirm(
      `Undo the invoice mark for ${who}?\n\n` +
      `This does NOT cancel or recall the invoice you already raised — it only resets the dashboard flag back to "invoice needed" for this cycle. ` +
      `Use this only if you ticked it by mistake.`
    );
    if (!ok) return;
  }
  const path = kind === 'scheduled'
    ? `/api/scheduled-payments/${id}/invoice`
    : `/api/clients/${id}/invoice`;
  try {
    await api(path, { method: 'POST', body: JSON.stringify({ sent }) });
    await loadData();
    toast(sent ? 'Marked invoiced' : 'Invoice mark removed');
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
  const type = it.client.invoice_type || 'regular';
  if (type === 'none') return ''; // client doesn't need invoicing
  const isKra = type === 'kra';
  const noun = isKra ? 'KRA invoice' : 'Invoice';
  if (it.invoiceSent) {
    const datePart = it.invoiceDate ? ` · ${fmtDate(it.invoiceDate)}` : '';
    return `<span class="badge ok">✓ ${isKra ? 'KRA invoiced' : 'Invoiced'}${datePart}</span>`;
  }
  return `<span class="badge danger">${noun} needed</span>`;
}

function invoiceToggleButton(it) {
  const type = it.client.invoice_type || 'regular';
  if (type === 'none') return ''; // no invoicing for this client
  const isKra = type === 'kra';
  const idArg = it.kind === 'scheduled' ? it.scheduled.id : it.client.id;
  if (it.invoiceSent) {
    return `<button class="btn-sm" onclick="toggleInvoice('${it.kind}', ${idArg}, true)" title="Mark as not invoiced (undo)">↩ Undo</button>`;
  }
  return `<button class="btn-sm invoice-cta" onclick="toggleInvoice('${it.kind}', ${idArg}, false)">+ ${isKra ? 'Mark KRA invoiced' : 'Mark invoiced'}</button>`;
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
          ${c.subaccount_paused ? `<span class="badge warn">⏸ ${c.catalog_api_base ? 'Website' : 'Subaccount'} paused ${fmtDateShort(c.subaccount_paused)}</span>` : ''}
          ${kind === 'overdue'
            ? `<span class="badge danger">${Math.abs(daysFromToday(it.due))} days late</span><span>Was due ${fmtDate(it.due)}</span>`
            : `<span>Due ${fmtDate(it.due)} · ${fmtRelative(it.due)}</span>`}
        </div>
      </div>
      <div class="actions">
        <div class="amount num">${fmtKES(it.amount)}</div>
        ${invoiceToggleButton(it)}
        ${reminderAction(c, kind)}
        ${kind === 'overdue' && c.plan !== 'one-off'
          ? (c.subaccount_paused
            ? `<button class="btn-sm" onclick="resumeSubaccount(${c.id})" title="${c.catalog_api_base ? 'Bring their website back online' : 'Resume their GHL subaccount'}">Resume ${c.catalog_api_base ? 'web' : 'sub'}</button>`
            : `<button class="btn-sm danger" onclick="pauseSubaccount(${c.id})" title="${c.catalog_api_base ? 'Take their website offline' : 'Pause their GHL subaccount'}">Pause ${c.catalog_api_base ? 'web' : 'sub'}</button>`)
          : ''}
        <button class="btn-sm" onclick="quickPay(${c.id})">Mark paid</button>
      </div>
    </div>
  `;
}

// Catalog kill-switch must be called from the browser, not the worker:
// a worker→worker fetch to a same-zone *.workers.dev returns Cloudflare error 1042.
let _catalogToken = null;
async function getCatalogToken() {
  if (_catalogToken) return _catalogToken;
  const r = await api('/api/catalog-token');
  _catalogToken = r.token;
  return _catalogToken;
}
async function catalogSuspend(client, suspended) {
  if (!client || !client.catalog_api_base) return;
  const token = await getCatalogToken();
  const res = await fetch(`${client.catalog_api_base.replace(/\/+$/, '')}/api/suspend`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ suspended: !!suspended }),
  });
  if (!res.ok) throw new Error(`Catalog ${suspended ? 'suspend' : 'restore'} failed (HTTP ${res.status})`);
}

// Loyalty paid-feature unlock — same browser→catalog-worker path as catalogSuspend
// (worker→worker on a same-zone *.workers.dev is blocked by CF error 1042).
async function catalogLoyaltyUnlock(client, unlocked) {
  if (!client || !client.catalog_api_base) return;
  const token = await getCatalogToken();
  const res = await fetch(`${client.catalog_api_base.replace(/\/+$/, '')}/api/loyalty-unlock`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ unlocked: !!unlocked }),
  });
  if (!res.ok) throw new Error(`Loyalty ${unlocked ? 'unlock' : 'lock'} failed (HTTP ${res.status})`);
}

window.unlockLoyalty = async function (id) {
  const c = state.clients.find((x) => x.id === id);
  if (!c || !c.catalog_api_base) return;
  if (!confirm(`Unlock the Loyalty Program for ${c.name}?\n\nTheir shop admin switches from the locked teaser to the full Loyalty dashboard. Use this once they've paid the Ksh 5,000 one-time fee.`)) return;
  try {
    await catalogLoyaltyUnlock(c, true);
    toast(`${c.name}: Loyalty Program unlocked`);
  } catch (err) {
    toast(err.message, 'error');
  }
};

window.lockLoyalty = async function (id) {
  const c = state.clients.find((x) => x.id === id);
  if (!c || !c.catalog_api_base) return;
  if (!confirm(`Re-lock the Loyalty Program for ${c.name}?\n\nTheir admin goes back to the locked teaser. Only do this to correct a mistake.`)) return;
  try {
    await catalogLoyaltyUnlock(c, false);
    toast(`${c.name}: Loyalty Program locked`);
  } catch (err) {
    toast(err.message, 'error');
  }
};

window.pauseSubaccount = async function (id) {
  const c = state.clients.find((x) => x.id === id);
  if (!c) return;
  const isWeb = !!c.catalog_api_base;
  const msg = isWeb
    ? `Take ${c.name}'s website offline now?\n\nVisitors will immediately see a "temporarily offline" notice (no products, no ordering). It comes straight back when you resume it or record a payment.`
    : `Pause ${c.name}'s GHL subaccount?\n\nMark this once you've paused their subaccount in GHL for non-payment. They STAY in your overdue list (they still owe you) — this just records that their service is off. Recording a payment later resumes them automatically.`;
  if (!confirm(msg)) return;
  try {
    await api(`/api/clients/${id}/subaccount`, { method: 'POST', body: JSON.stringify({ paused: true }) });
    if (isWeb) await catalogSuspend(c, true);
    await loadData();
    toast(isWeb ? `${c.name} website taken offline` : `${c.name} subaccount paused`);
  } catch (err) {
    toast(err.message, 'error');
  }
};

window.resumeSubaccount = async function (id) {
  const c = state.clients.find((x) => x.id === id);
  if (!c) return;
  const isWeb = !!c.catalog_api_base;
  try {
    await api(`/api/clients/${id}/subaccount`, { method: 'POST', body: JSON.stringify({ paused: false }) });
    if (isWeb) await catalogSuspend(c, false);
    await loadData();
    toast(isWeb ? `${c.name} website back online` : `${c.name} subaccount resumed`);
  } catch (err) {
    toast(err.message, 'error');
  }
};

// Trial prospects can carry a catalog_api_base too (demo sites built before they
// commit). Same browser→catalog-worker kill-switch as clients, keyed off the
// prospect's subaccount_paused date. catalogSuspend() is generic over any object
// with a catalog_api_base, so it's reused as-is.
window.pauseProspectWeb = async function (id) {
  const p = state.prospects.find((x) => x.id === id);
  if (!p || !p.catalog_api_base) return;
  if (!confirm(`Take ${p.name}'s trial website offline now?\n\nVisitors will immediately see a "temporarily offline" notice (no products, no ordering). It comes straight back when you resume it.`)) return;
  try {
    await api(`/api/prospects/${id}/subaccount`, { method: 'POST', body: JSON.stringify({ paused: true }) });
    await catalogSuspend(p, true);
    await loadData();
    toast(`${p.name} website taken offline`);
  } catch (err) {
    toast(err.message, 'error');
  }
};

window.resumeProspectWeb = async function (id) {
  const p = state.prospects.find((x) => x.id === id);
  if (!p || !p.catalog_api_base) return;
  try {
    await api(`/api/prospects/${id}/subaccount`, { method: 'POST', body: JSON.stringify({ paused: false }) });
    await catalogSuspend(p, false);
    await loadData();
    toast(`${p.name} website back online`);
  } catch (err) {
    toast(err.message, 'error');
  }
};

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
    invoice_type: c.invoice_type || 'regular',
    catalog_api_base: c.catalog_api_base || null,
    ended_date: c.ended_date || null,
    source: c.source || null,
    source_date: c.source_date || null,
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
  const q = (state.clientSearch || '').trim().toLowerCase();
  const filtered = state.clients.filter((c) => {
    if (state.clientFilter === 'recurring' && !(c.plan === 'monthly' || c.plan === 'quarterly')) return false;
    if (state.clientFilter === 'one-off' && c.plan !== 'one-off') return false;
    if (q && !`${c.name || ''} ${c.business || ''} ${c.phone || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const countEl = $('#clientSearchCount');
  if (countEl) countEl.textContent = q ? `${filtered.length} match${filtered.length === 1 ? '' : 'es'}` : '';
  if (filtered.length === 0) {
    el.innerHTML = q
      ? `<div class="empty">No clients match “${escapeHtml(state.clientSearch.trim())}”.</div>`
      : `<div class="empty">No ${state.clientFilter === 'recurring' ? 'recurring' : 'one-off'} clients yet.</div>`;
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
            ${c.subaccount_paused ? `<span class="badge warn">⏸ ${c.catalog_api_base ? 'Website offline' : 'Subaccount paused'}</span>` : ''}
            ${c.next_due ? `<span>Next due ${fmtDate(c.next_due)}</span>` : `<span>${c.plan === 'one-off' ? 'One off' : 'No due date'}</span>`}
            ${c.phone ? `<span class="mono">${escapeHtml(c.phone)}</span>` : ''}
            ${c.source ? `<span class="badge muted">via ${escapeHtml(c.source)}</span>` : ''}
          </div>
          ${chips ? `<div class="chips">${chips}</div>` : ''}
        </div>
        <div class="actions">
          <div class="amount num">${fmtKES(c.amount)}</div>
          <button class="btn-sm" onclick="quickPay(${c.id})">Pay</button>
          ${c.catalog_api_base
            ? (c.subaccount_paused
              ? `<button class="btn-sm" onclick="resumeSubaccount(${c.id})" title="Bring their website back online">Resume web</button>`
              : `<button class="btn-sm danger" onclick="pauseSubaccount(${c.id})" title="Take their website offline">Pause web</button>`)
            : ''}
          ${c.catalog_api_base
            ? `<button class="btn-sm" onclick="unlockLoyalty(${c.id})" title="Unlock the paid Loyalty Program in their shop admin">🎁 Unlock loyalty</button><button class="btn-sm" onclick="lockLoyalty(${c.id})" title="Re-lock the Loyalty Program (correction only)">Lock</button>`
            : ''}
          <button class="btn-sm" onclick="openReminder(${c.id})">Reminder</button>
          ${c.status === 'active'
            ? `<button class="btn-sm" onclick="lifecycleClient(${c.id},'pause')" title="Stop billing for now, keep them on the books">Pause</button>`
            : (c.status === 'paused' || c.status === 'churned')
              ? `<button class="btn-sm" onclick="resumeClient(${c.id})" title="Bring them back as an active client">Resume</button>`
              : ''}
          <button class="btn-sm" onclick="editClient(${c.id})">Edit</button>
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

// Was this client/expense billing-active during month `monthIso`?
//   - Must have started by the end of the month.
//   - If they have an ended_date (churned/cancelled), they count from start
//     THROUGH the month containing ended_date, then stop — so a churned
//     client's pre-churn months still contribute to historical accrual.
//   - With no ended_date: current/future months need status 'active'; past
//     months also accept 'paused' (we don't track when an open-ended pause began).
function entityActiveInMonth(entity, monthIso) {
  const monthStart = monthIso + '-01';
  const monthEnd = lastDayOfMonth(monthIso);
  if (entity.start_date > monthEnd) return false; // not started yet
  if (entity.ended_date) {
    // Active for any month from start through the ended_date's month.
    return entity.ended_date >= monthStart;
  }
  const todayMonth = todayISO().slice(0, 7);
  if (monthIso >= todayMonth) return entity.status === 'active';
  return entity.status === 'active' || entity.status === 'paused';
}

// Payment IDs that cleared a scheduled item. These are discrete one-off chunks
// (website build fee, deposit, balance) and count as one-off revenue even when
// the client is recurring — e.g. a 5k/mo catalogue client who also paid a 15k
// one-off website build via a scheduled payment.
function scheduledLinkedPaymentIds() {
  return new Set(state.scheduled_payments.filter((s) => s.payment_id).map((s) => s.payment_id));
}

// Is this payment a discrete one-off chunk (vs a recurring cycle payment)?
function isOneOffChunk(p, schedIds) {
  const c = state.clients.find((x) => x.id === p.client_id);
  if (!c) return false;
  return c.plan === 'one-off' || schedIds.has(p.id);
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
  const schedIds = scheduledLinkedPaymentIds();
  for (const p of state.payments) {
    if (p.paid_on < monthStart || p.paid_on > monthEnd) continue;
    if (isOneOffChunk(p, schedIds)) total += p.amount;
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
    // Plus any one-off chunks this recurring client paid (e.g. a website build fee)
    const schedIds = scheduledLinkedPaymentIds();
    state.payments
      .filter((p) => p.client_id === c.id && schedIds.has(p.id) && p.paid_on >= startIso && p.paid_on <= endIso)
      .forEach((p) => { total += p.amount; });
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

  const schedIds = scheduledLinkedPaymentIds();
  const oneOff = state.payments
    .filter((p) => p.paid_on >= startIso && p.paid_on <= endIso && isOneOffChunk(p, schedIds))
    .map((p) => {
      const client = state.clients.find((c) => c.id === p.client_id);
      // For a scheduled-linked payment on a recurring client, label it with the
      // scheduled item's description (e.g. "Website build") so it's clear it's
      // not a recurring cycle payment.
      const sched = state.scheduled_payments.find((s) => s.payment_id === p.id);
      const label = sched && sched.description ? `${client.name} — ${sched.description}` : client.name;
      return { name: label, paid_on: p.paid_on, amount: p.amount, reference: p.reference };
    })
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

$('#clientSearch').addEventListener('input', (e) => {
  state.clientSearch = e.target.value;
  renderClientsList();
});

$('#addProspectBtn').addEventListener('click', () => editProspect(null));

$('#prospectFilter').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.prospectFilter = btn.dataset.filter;
  $$('#prospectFilter .filter-pill').forEach((b) => b.classList.toggle('active', b === btn));
  renderProspects();
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

// Source = how the lead was found (IG / WhatsApp / Referral / ...), plus the
// date they first came in. Shared by the client and prospect forms.
function sourceFieldsHtml(entity) {
  const isEdit = !!entity;
  return `
    <div class="form-row">
      <label>
        <span>Source <span class="hint">(how you found them)</span></span>
        <input type="text" name="source" list="sourceOptions" placeholder="Instagram, WhatsApp, Referral..." value="${isEdit && entity.source ? escapeAttr(entity.source) : ''}">
      </label>
      <label>
        <span>First contact <span class="hint">(when they came in)</span></span>
        <input type="date" name="source_date" value="${isEdit ? (entity.source_date || '') : todayISO()}">
      </label>
    </div>
  `;
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
      ${sourceFieldsHtml(isEdit ? c : null)}
      <div class="form-row">
        <label>
          <span>Invoice type <span class="hint">(how you bill them)</span></span>
          <select name="invoice_type">
            <option value="regular" ${!isEdit || (c.invoice_type || 'regular') === 'regular' ? 'selected' : ''}>Regular invoice</option>
            <option value="kra" ${isEdit && c.invoice_type === 'kra' ? 'selected' : ''}>KRA eTIMS invoice</option>
            <option value="none" ${isEdit && c.invoice_type === 'none' ? 'selected' : ''}>No invoice needed</option>
          </select>
        </label>
        <label>
          <span>Catalog worker URL <span class="hint">(for the suspend kill-switch)</span></span>
          <input type="url" name="catalog_api_base" placeholder="https://shop-api.stawisystems.workers.dev" value="${isEdit && c.catalog_api_base ? escapeAttr(c.catalog_api_base) : ''}">
        </label>
      </div>
      ${isEdit ? `
        <div class="form-row">
          <label>
            <span>Status</span>
            <select name="status">
              <option value="active" ${c.status === 'active' ? 'selected' : ''}>Active</option>
              <option value="paused" ${c.status === 'paused' ? 'selected' : ''}>Paused</option>
              <option value="churned" ${c.status === 'churned' ? 'selected' : ''}>Churned</option>
              <option value="completed" ${c.status === 'completed' ? 'selected' : ''}>Completed</option>
            </select>
          </label>
          <label>
            <span>Ended on <span class="hint">(set when churned — keeps months up to here in revenue)</span></span>
            <input type="date" name="ended_date" value="${c.ended_date || ''}">
          </label>
        </div>
      ` : ''}
      ${servicesFieldHtml(isEdit ? (c.services || []) : [])}
      <label>
        <span>Notes <span class="hint">(optional)</span></span>
        <textarea name="notes">${isEdit && c.notes ? escapeHtml(c.notes) : ''}</textarea>
      </label>
      ${!isEdit ? `
      <div class="form-section">
        <div class="form-section-title">One-off setup fee (optional)</div>
        <div class="form-row">
          <label>
            <span>Amount (Ksh) <span class="hint">e.g. 15,000 website build</span></span>
            <input type="number" name="setup_fee" min="0" step="1" placeholder="Leave blank if none">
          </label>
          <label>
            <span>What for?</span>
            <input type="text" name="setup_fee_label" value="Website build">
          </label>
        </div>
        <p class="hint" style="margin-top:-6px; font-size:10.5px; line-height:1.4; opacity:0.85;">Adds a one-off charge due with the first payment (a scheduled payment on the start date). Mark it paid when they pay it. Skip for clients who dispute the fee.</p>
      </div>
      ` : ''}
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
        ${isEdit ? `<button type="button" class="btn-sm" onclick="addScheduled(${c.id})">+ Schedule payment</button>` : ''}
        ${isEdit ? `<button type="button" class="btn-sm danger" style="margin-right:auto;" onclick="deleteClient(${c.id})">Delete client</button>` : ''}
        <button type="button" class="btn-ghost" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn-primary">${isEdit ? 'Save changes' : 'Add client'}</button>
      </div>
    </form>
  `;
}

window.editClient = function (id, opts = {}) {
  const c = id != null ? state.clients.find((x) => x.id === id) : null;
  openModal(clientFormHtml(c));
  // Convert-to-client and similar flows can pre-fill the add form.
  if (!c && opts.prefill) {
    const f = $('#clientForm');
    ['name', 'business', 'phone', 'email', 'source', 'source_date'].forEach((k) => {
      const input = f.querySelector(`[name="${k}"]`);
      if (input && opts.prefill[k]) input.value = opts.prefill[k];
    });
  }
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
      invoice_type: fd.get('invoice_type') || 'regular',
      catalog_api_base: (fd.get('catalog_api_base') || '').trim() || null,
      ended_date: fd.get('ended_date') || null,
      source: (fd.get('source') || '').trim() || null,
      source_date: fd.get('source_date') || null,
    };
    try {
      if (c) {
        await api(`/api/clients/${c.id}`, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        const res = await api('/api/clients', { method: 'POST', body: JSON.stringify(body) });
        // Optional one-off setup fee → create a scheduled payment due with the
        // first recurring payment (the new client's next_due, which defaults to
        // start_date). Only on create; skipped if left blank.
        const setupFee = Number(fd.get('setup_fee')) || 0;
        if (setupFee > 0 && res && res.client) {
          await api('/api/scheduled-payments', {
            method: 'POST',
            body: JSON.stringify({
              client_id: res.client.id,
              amount: setupFee,
              due_date: res.client.next_due || body.start_date,
              description: (fd.get('setup_fee_label') || '').trim() || 'Setup fee',
            }),
          });
        }
        if (opts.onCreated && res && res.client) {
          await opts.onCreated(res.client);
        }
      }
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

// ────────── Client lifecycle: pause / churn / resume ──────────

function monthLabelFromISO(yyyymm) {
  if (!yyyymm) return '';
  const [y, m] = yyyymm.split('-');
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[Number(m) - 1]} ${y}`;
}

// Pause = temporary, stays on the books, resumable. Churn = gone for good,
// drops out of the active-client count. Both stop future billing/reminders and
// bound revenue to the "counts through" date (start → that month, then stop).
window.lifecycleClient = function (id, mode) {
  const c = state.clients.find((x) => x.id === id);
  if (!c) return;
  const isChurn = mode === 'churn';
  const defaultEnd = c.next_due || lastDayOfMonth(todayISO().slice(0, 7));
  const lead = isChurn
    ? `Marks ${escapeHtml(c.name)} as gone for good. They drop out of your active-client count and all future billing and reminders stop, but every shilling they've already paid stays in your revenue. You can still bring them back later if they return.`
    : `Stops billing and reminders for ${escapeHtml(c.name)} for now. They stay on your books (still counted as a client) and you can resume any time. Use this for a client taking a break.`;
  openModal(`
    <h2${isChurn ? ' style="color: var(--red);"' : ''}>${isChurn ? 'Churn' : 'Pause'} ${escapeHtml(c.name)}?</h2>
    <p class="muted" style="margin-bottom:14px;">${lead}</p>
    <form id="lifecycleForm">
      <label>
        <span>Counts toward revenue through <span class="hint">(their last paid due date)</span></span>
        <input type="date" name="ended_date" value="${defaultEnd}" required>
      </label>
      <p class="muted" id="lifecycleHint" style="font-size:13px;margin:6px 2px 14px;"></p>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" onclick="closeModal()">Cancel</button>
        <button type="submit" class="${isChurn ? 'btn-danger-solid' : 'btn-primary'}">${isChurn ? 'Churn client' : 'Pause client'}</button>
      </div>
    </form>
  `);
  const dateInput = $('#lifecycleForm [name="ended_date"]');
  const hint = $('#lifecycleHint');
  const updateHint = () => {
    hint.textContent = dateInput.value
      ? `Revenue counts through ${monthLabelFromISO(dateInput.value.slice(0, 7))}, then stops.`
      : '';
  };
  dateInput.addEventListener('input', updateHint);
  updateHint();
  $('#lifecycleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = serializeClientForUpdate(c, {
      status: isChurn ? 'churned' : 'paused',
      ended_date: dateInput.value || defaultEnd,
      next_due: null,
    });
    try {
      await api(`/api/clients/${id}`, { method: 'PUT', body: JSON.stringify(body) });
      await loadData();
      closeModal();
      toast(`${c.name} ${isChurn ? 'churned' : 'paused'}`);
    } catch (err) { toast(err.message, 'error'); }
  });
};

window.resumeClient = function (id) {
  const c = state.clients.find((x) => x.id === id);
  if (!c) return;
  openModal(`
    <h2>Resume ${escapeHtml(c.name)}?</h2>
    <p class="muted" style="margin-bottom:14px;">Brings them back as an active client. Pick the date their next bill is due. Revenue starts counting again from that month.</p>
    <form id="resumeForm">
      <label>
        <span>Next due date</span>
        <input type="date" name="next_due" value="${todayISO()}" required>
      </label>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn-primary">Resume client</button>
      </div>
    </form>
  `);
  $('#resumeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const nd = $('#resumeForm [name="next_due"]').value;
    const body = serializeClientForUpdate(c, {
      status: 'active',
      ended_date: null,
      next_due: nd || null,
    });
    try {
      await api(`/api/clients/${id}`, { method: 'PUT', body: JSON.stringify(body) });
      await loadData();
      closeModal();
      toast(`${c.name} resumed`);
    } catch (err) { toast(err.message, 'error'); }
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
      // A recorded payment brings a suspended catalog back online (best-effort).
      const payClient = state.clients.find((x) => x.id === clientIdValue);
      if (payClient && payClient.catalog_api_base && payClient.subaccount_paused) {
        try { await catalogSuspend(payClient, false); } catch (_) { /* Resume web is the manual fallback */ }
      }
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

window.openReminder = function (id) {
  const c = state.clients.find((x) => x.id === id);
  if (!c) return;
  const isCatalog = !!c.catalog_api_base;
  const autoStage = c.subaccount_paused ? 'paused' : (c.next_due && c.next_due === todayISO() ? 'due' : 'before');
  const pill = (val, label) => `<button type="button" class="filter-pill reminder-stage${val === autoStage ? ' active' : ''}" data-stage="${val}">${label}</button>`;
  openModal(`
    <h2>Payment reminder</h2>
    <p class="muted" style="margin-bottom:12px;">For ${escapeHtml(c.name)} · ${fmtKES(c.amount)}. Pick the stage, tweak the text if you like, then copy or open WhatsApp.</p>
    <div class="filter-pills" id="reminderStages" style="margin-bottom:12px;">
      ${pill('before', '3 days before')}
      ${pill('due', 'Due today')}
      ${isCatalog ? pill('paused', 'Site paused') : ''}
    </div>
    <textarea id="reminderText" rows="7" style="width:100%;padding:10px 12px;border:1px solid #e5e5e5;border-radius:8px;font:inherit;resize:vertical;" placeholder="Generating…"></textarea>
    <div class="modal-actions" style="margin-top:14px;">
      <button type="button" class="btn-primary" id="reminderCopy">Copy</button>
      ${c.phone ? '<button type="button" class="btn-sm" id="reminderWa">Open WhatsApp</button>' : ''}
      <button type="button" class="btn-sm" id="reminderRegen">Regenerate</button>
      <button type="button" class="btn-ghost" onclick="closeModal()">Close</button>
    </div>
  `);
  let stage = autoStage;
  const ta = $('#reminderText');
  async function gen() {
    ta.value = '';
    ta.placeholder = 'Generating…';
    try {
      const r = await api('/api/reminder', { method: 'POST', body: JSON.stringify({ client_id: id, stage }) });
      ta.value = r.message || '';
    } catch (e) {
      ta.placeholder = 'Could not generate: ' + e.message;
    }
  }
  $$('#reminderStages .reminder-stage').forEach((b) => b.addEventListener('click', () => {
    stage = b.dataset.stage;
    $$('#reminderStages .reminder-stage').forEach((x) => x.classList.toggle('active', x === b));
    gen();
  }));
  $('#reminderRegen').addEventListener('click', gen);
  $('#reminderCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(ta.value); toast('Reminder copied'); }
    catch { ta.select(); toast('Select + copy manually', 'error'); }
  });
  const waBtn = $('#reminderWa');
  if (waBtn) waBtn.addEventListener('click', () => {
    const digits = (c.phone || '').replace(/\D/g, '');
    window.open(`https://wa.me/${digits}?text=${encodeURIComponent(ta.value)}`, '_blank', 'noopener');
  });
  gen();
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

// ────────── Prospects (demo pipeline) ──────────

const PROSPECT_STAGE = {
  requested: { label: 'Demo requested', cls: 'warn' },
  demo_sent: { label: 'Demo sent', cls: 'plan-monthly' },
  won: { label: 'Won', cls: 'ok' },
  lost: { label: 'Lost', cls: 'muted' },
};
const PROSPECT_OPEN = ['requested', 'demo_sent'];

function prospectMatchesFilter(p, f) {
  if (f === 'all') return true;
  if (f === 'open') return PROSPECT_OPEN.includes(p.stage);
  return p.stage === f;
}

function renderProspectKPIs() {
  const el = $('#prospectKpiRow');
  if (!el) return;
  const today = todayISO();
  const open = state.prospects.filter((p) => PROSPECT_OPEN.includes(p.stage));
  const toFollow = open.filter((p) => p.followup_date && p.followup_date <= today);
  const requested = state.prospects.filter((p) => p.stage === 'requested').length;
  const sent = state.prospects.filter((p) => p.stage === 'demo_sent').length;
  const won = state.prospects.filter((p) => p.stage === 'won').length;
  const lost = state.prospects.filter((p) => p.stage === 'lost').length;
  el.innerHTML = `
    <div class="kpi-card">
      <div class="kpi-label">Open pipeline</div>
      <div class="kpi-value">${open.length}</div>
      <div class="kpi-sub">${requested} awaiting demo · ${sent} sent</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">To follow up</div>
      <div class="kpi-value ${toFollow.length ? 'danger' : ''}">${toFollow.length}</div>
      <div class="kpi-sub">due today or overdue</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Won</div>
      <div class="kpi-value">${won}</div>
      <div class="kpi-sub">became clients</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Lost</div>
      <div class="kpi-value">${lost}</div>
      <div class="kpi-sub">didn't go ahead</div>
    </div>
  `;
}

function prospectRowHtml(p) {
  const today = todayISO();
  const st = PROSPECT_STAGE[p.stage] || PROSPECT_STAGE.requested;
  const isOpen = PROSPECT_OPEN.includes(p.stage);
  const overdue = isOpen && p.followup_date && p.followup_date <= today;
  const fu = p.followup_date
    ? `<span class="badge ${overdue ? 'danger' : 'muted'}">Follow up ${fmtDateShort(p.followup_date)}${isOpen ? ` · ${fmtRelative(p.followup_date)}` : ''}</span>`
    : '';
  return `
    <div class="list-row">
      <div>
        <div class="primary">${escapeHtml(p.name)}${p.business ? ` <span class="muted-2" style="font-weight:400;">· ${escapeHtml(p.business)}</span>` : ''}</div>
        <div class="sub">
          <span class="badge ${st.cls}">${st.label}</span>
          ${isOpen ? fu : ''}
          ${p.phone ? `<span class="mono">${escapeHtml(p.phone)}</span>` : ''}
          ${p.source ? `<span class="badge muted">via ${escapeHtml(p.source)}</span>` : ''}
          ${p.demo_url ? `<a href="${escapeAttr(p.demo_url)}" target="_blank" rel="noopener" style="color:var(--brand-orange-deep);">Demo ↗</a>` : ''}
          ${p.catalog_api_base && p.subaccount_paused ? `<span class="badge warn">⏸ Website offline ${fmtDateShort(p.subaccount_paused)}</span>` : ''}
        </div>
        ${p.notes ? `<div class="sub" style="margin-top:4px;">${escapeHtml(p.notes)}</div>` : ''}
      </div>
      <div class="actions">
        ${p.catalog_api_base ? (p.subaccount_paused
          ? `<button class="btn-sm" onclick="resumeProspectWeb(${p.id})" title="Bring their trial website back online">Resume web</button>`
          : `<button class="btn-sm danger" onclick="pauseProspectWeb(${p.id})" title="Take their trial website offline">Pause web</button>`) : ''}
        ${p.stage === 'requested' ? `<button class="btn-sm" onclick="setProspectStage(${p.id},'demo_sent')" title="Mark the demo as sent">Mark demo sent</button>` : ''}
        ${isOpen && p.phone ? `<button class="btn-sm" onclick="prospectFollowupWA(${p.id})" title="Open WhatsApp with a follow-up draft">Follow up</button>` : ''}
        ${isOpen ? `<button class="btn-sm" onclick="convertProspect(${p.id})" title="They committed, create their client record">Won → client</button>` : ''}
        ${isOpen ? `<button class="btn-sm danger" onclick="setProspectStage(${p.id},'lost')" title="They didn't go ahead">Lost</button>` : ''}
        ${!isOpen ? `<button class="btn-sm" onclick="reopenProspect(${p.id})" title="Move back to the open pipeline">Reopen</button>` : ''}
        <button class="btn-sm" onclick="editProspect(${p.id})">Edit</button>
      </div>
    </div>
  `;
}

function renderProspects() {
  renderProspectKPIs();
  const el = $('#prospectsList');
  if (!el) return;
  const f = state.prospectFilter;
  const list = state.prospects.filter((p) => prospectMatchesFilter(p, f));
  list.sort((a, b) => {
    const ao = PROSPECT_OPEN.includes(a.stage);
    const bo = PROSPECT_OPEN.includes(b.stage);
    if (ao !== bo) return ao ? -1 : 1;
    const af = a.followup_date || '9999-99-99';
    const bf = b.followup_date || '9999-99-99';
    if (ao && af !== bf) return af < bf ? -1 : 1;
    return (b.created_at || '').localeCompare(a.created_at || '');
  });
  if (list.length === 0) {
    const label = f === 'all' ? 'prospects' : f === 'open' ? 'open prospects' : `prospects in "${(PROSPECT_STAGE[f] || {}).label || f}"`;
    el.innerHTML = `<div class="empty">No ${label} yet.</div>`;
    return;
  }
  el.innerHTML = list.map(prospectRowHtml).join('');
}

function renderProspectFollowups() {
  const card = $('#prospectFollowupCard');
  const el = $('#prospectFollowupList');
  if (!card || !el) return;
  const today = todayISO();
  const due = state.prospects
    .filter((p) => PROSPECT_OPEN.includes(p.stage) && p.followup_date && p.followup_date <= today)
    .sort((a, b) => (a.followup_date < b.followup_date ? -1 : 1));
  if (due.length === 0) { card.hidden = true; return; }
  card.hidden = false;
  el.innerHTML = due.map((p) => {
    const st = PROSPECT_STAGE[p.stage] || PROSPECT_STAGE.requested;
    return `
    <div class="list-row">
      <div>
        <div class="primary">${escapeHtml(p.name)}${p.business ? ` <span class="muted-2" style="font-weight:400;">· ${escapeHtml(p.business)}</span>` : ''}</div>
        <div class="sub">
          <span class="badge ${st.cls}">${st.label}</span>
          <span class="badge danger">Follow up ${fmtDateShort(p.followup_date)} · ${fmtRelative(p.followup_date)}</span>
          ${p.phone ? `<span class="mono">${escapeHtml(p.phone)}</span>` : ''}
        </div>
      </div>
      <div class="actions">
        ${p.phone ? `<button class="btn-sm" onclick="prospectFollowupWA(${p.id})">Follow up</button>` : ''}
        <button class="btn-sm" onclick="snoozeProspect(${p.id})">Snooze 3d</button>
        <button class="btn-sm" onclick="editProspect(${p.id})">Edit</button>
      </div>
    </div>`;
  }).join('');
}

function serializeProspect(p, overrides = {}) {
  return {
    name: p.name,
    business: p.business,
    phone: p.phone,
    email: p.email,
    demo_url: p.demo_url,
    stage: p.stage,
    followup_date: p.followup_date,
    notes: p.notes,
    converted_client_id: p.converted_client_id || null,
    source: p.source || null,
    source_date: p.source_date || null,
    catalog_api_base: p.catalog_api_base || null,
    ...overrides,
  };
}

window.setProspectStage = async function (id, stage) {
  const p = state.prospects.find((x) => x.id === id);
  if (!p) return;
  try {
    await api(`/api/prospects/${id}`, { method: 'PUT', body: JSON.stringify(serializeProspect(p, { stage })) });
    await loadData();
    toast(`Marked ${(PROSPECT_STAGE[stage] || {}).label || stage}`);
  } catch (err) { toast(err.message, 'error'); }
};

window.reopenProspect = function (id) {
  setProspectStage(id, 'demo_sent');
};

window.snoozeProspect = async function (id) {
  const p = state.prospects.find((x) => x.id === id);
  if (!p) return;
  try {
    await api(`/api/prospects/${id}`, { method: 'PUT', body: JSON.stringify(serializeProspect(p, { followup_date: addDaysISO(todayISO(), 3) })) });
    await loadData();
    toast('Snoozed 3 days');
  } catch (err) { toast(err.message, 'error'); }
};

window.prospectFollowupWA = function (id) {
  const p = state.prospects.find((x) => x.id === id);
  if (!p || !p.phone) return;
  const digits = (p.phone || '').replace(/\D/g, '');
  const biz = p.business ? ` for ${p.business}` : '';
  const msg = `Hi ${p.name}, following up on the demo I put together${biz}. Happy to walk you through it whenever suits you, no rush. Let me know your thoughts.\n\nJoel, Essence Automations`;
  window.open(`https://wa.me/${digits}?text=${encodeURIComponent(msg)}`, '_blank', 'noopener');
};

window.convertProspect = function (id) {
  const p = state.prospects.find((x) => x.id === id);
  if (!p) return;
  editClient(null, {
    prefill: { name: p.name, business: p.business, phone: p.phone, email: p.email, source: p.source, source_date: p.source_date },
    onCreated: async (client) => {
      await api(`/api/prospects/${id}`, {
        method: 'PUT',
        body: JSON.stringify(serializeProspect(p, { stage: 'won', converted_client_id: client.id })),
      });
    },
  });
};

window.deleteProspect = async function (id) {
  const p = state.prospects.find((x) => x.id === id);
  if (!p) return;
  if (!confirm(`Delete prospect "${p.name}"? This can't be undone.`)) return;
  try {
    await api(`/api/prospects/${id}`, { method: 'DELETE' });
    await loadData();
    closeModal();
    toast('Prospect deleted');
  } catch (err) { toast(err.message, 'error'); }
};

function prospectFormHtml(p) {
  const isEdit = !!p;
  const stageOpt = (val, label) => `<option value="${val}" ${(isEdit ? p.stage : 'requested') === val ? 'selected' : ''}>${label}</option>`;
  return `
    <h2>${isEdit ? 'Edit prospect' : 'Add prospect'}</h2>
    <form id="prospectForm">
      <label>
        <span>Name</span>
        <input type="text" name="name" required value="${isEdit ? escapeAttr(p.name) : ''}" autofocus>
      </label>
      <div class="form-row">
        <label>
          <span>Business <span class="hint">(optional)</span></span>
          <input type="text" name="business" value="${isEdit && p.business ? escapeAttr(p.business) : ''}">
        </label>
        <label>
          <span>Phone <span class="hint">(for WhatsApp)</span></span>
          <input type="text" name="phone" value="${isEdit && p.phone ? escapeAttr(p.phone) : ''}">
        </label>
      </div>
      <div class="form-row">
        <label>
          <span>Email <span class="hint">(optional)</span></span>
          <input type="email" name="email" value="${isEdit && p.email ? escapeAttr(p.email) : ''}">
        </label>
        <label>
          <span>Stage</span>
          <select name="stage">
            ${stageOpt('requested', 'Demo requested')}
            ${stageOpt('demo_sent', 'Demo sent')}
            ${stageOpt('won', 'Won')}
            ${stageOpt('lost', 'Lost')}
          </select>
        </label>
      </div>
      <div class="form-row">
        <label>
          <span>Demo link <span class="hint">(optional)</span></span>
          <input type="url" name="demo_url" placeholder="https://..." value="${isEdit && p.demo_url ? escapeAttr(p.demo_url) : ''}">
        </label>
        <label>
          <span>Follow up on <span class="hint">(so it doesn't slip)</span></span>
          <input type="date" name="followup_date" value="${isEdit ? (p.followup_date || '') : addDaysISO(todayISO(), 3)}">
        </label>
      </div>
      ${sourceFieldsHtml(isEdit ? p : null)}
      <label>
        <span>Catalog API base <span class="hint">(only for trial catalog sites — enables the Pause/Resume-web button)</span></span>
        <input type="url" name="catalog_api_base" placeholder="https://shop-api.stawisystems.workers.dev" value="${isEdit && p.catalog_api_base ? escapeAttr(p.catalog_api_base) : ''}">
      </label>
      <label>
        <span>Notes <span class="hint">(what they want, context)</span></span>
        <textarea name="notes">${isEdit && p.notes ? escapeHtml(p.notes) : ''}</textarea>
      </label>
      <p class="error hidden" id="prospectFormErr"></p>
      <div class="modal-actions">
        ${isEdit ? `<button type="button" class="btn-sm danger" style="margin-right:auto;" onclick="deleteProspect(${p.id})">Delete</button>` : ''}
        <button type="button" class="btn-ghost" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn-primary">${isEdit ? 'Save changes' : 'Add prospect'}</button>
      </div>
    </form>
  `;
}

window.editProspect = function (id) {
  const p = id != null ? state.prospects.find((x) => x.id === id) : null;
  openModal(prospectFormHtml(p));
  $('#prospectForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      name: fd.get('name').trim(),
      business: (fd.get('business') || '').trim() || null,
      phone: (fd.get('phone') || '').trim() || null,
      email: (fd.get('email') || '').trim() || null,
      demo_url: (fd.get('demo_url') || '').trim() || null,
      stage: fd.get('stage') || 'requested',
      followup_date: fd.get('followup_date') || null,
      notes: (fd.get('notes') || '').trim() || null,
      converted_client_id: p ? (p.converted_client_id || null) : null,
      source: (fd.get('source') || '').trim() || null,
      source_date: fd.get('source_date') || null,
      catalog_api_base: (fd.get('catalog_api_base') || '').trim() || null,
    };
    try {
      if (p) await api(`/api/prospects/${p.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/api/prospects', { method: 'POST', body: JSON.stringify(body) });
      await loadData();
      closeModal();
      toast(p ? 'Prospect updated' : 'Prospect added');
    } catch (err) {
      const errEl = $('#prospectFormErr');
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });
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
