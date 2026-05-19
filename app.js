// Clients Dashboard — front-end logic
// Talks to the CF Worker over fetch. Single global state, re-render on data change.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const API_BASE = 'https://clients-dashboard-api.stawisystems.workers.dev';

const state = {
  apiBase: API_BASE,
  token: localStorage.getItem('cd_token') || '',
  clients: [],
  payments: [],
  activeTab: 'dashboard',
  revenuePeriod: '30d',
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
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

const fmtDateShort = (iso) => {
  const d = parseISO(iso);
  if (!d) return '';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
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
  if (plan === 'quarterly') return 'Quarterly';
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
  const url = state.apiBase.replace(/\/$/, '') + path;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${state.token}`,
    ...(opts.headers || {}),
  };
  const res = await fetch(url, { ...opts, headers });
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
  renderAll();
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
  renderRecent();
  renderClientsList();
  renderPaymentsList();
  if (state.activeTab === 'revenue') renderRevenue();
}

function renderBanner() {
  const today = todayISO();
  const in7 = new Date(parseISO(today).getTime() + 7 * 86400000).toISOString().slice(0, 10);
  const overdue = state.clients.filter((c) => c.status === 'active' && c.next_due && c.next_due < today);
  const dueWeek = state.clients.filter((c) => c.status === 'active' && c.next_due && c.next_due >= today && c.next_due <= in7);

  const el = $('#banner');
  if (overdue.length === 0 && dueWeek.length === 0) {
    el.classList.add('hidden');
    return;
  }
  const parts = [];
  if (overdue.length) parts.push(`<strong>${overdue.length} overdue</strong>`);
  if (dueWeek.length) parts.push(`${dueWeek.length} due this week`);
  el.innerHTML = `<span>${parts.join(' · ')}</span><span class="banner-hint">↓ scroll for details</span>`;
  el.classList.remove('hidden');
  el.classList.toggle('danger', overdue.length > 0);
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

  const in30 = new Date(parseISO(today).getTime() + 30 * 86400000)
    .toISOString().slice(0, 10);
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
      <div class="kpi-label">Active clients</div>
      <div class="kpi-value">${activeClients.length}</div>
      <div class="kpi-sub">${state.clients.length} total</div>
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
  const in30 = new Date(parseISO(today).getTime() + 30 * 86400000).toISOString().slice(0, 10);
  return state.clients.filter((c) => c.status === 'active' && c.next_due && c.next_due >= today && c.next_due <= in30).length;
}

function renderUpcoming() {
  const today = todayISO();
  const in30 = new Date(parseISO(today).getTime() + 30 * 86400000).toISOString().slice(0, 10);
  const upcoming = state.clients
    .filter((c) => c.status === 'active' && c.next_due && c.next_due >= today && c.next_due <= in30)
    .sort((a, b) => a.next_due.localeCompare(b.next_due));

  const el = $('#upcomingList');
  if (upcoming.length === 0) {
    el.innerHTML = '<div class="empty">Nothing due in the next 30 days.</div>';
    return;
  }
  el.innerHTML = upcoming.map((c) => `
    <div class="list-row">
      <div>
        <div class="primary">${escapeHtml(c.name)}</div>
        <div class="sub">
          <span class="badge plan-${c.plan}">${planLabel(c.plan)}</span>
          <span>Due ${fmtDate(c.next_due)} · ${fmtRelative(c.next_due)}</span>
        </div>
      </div>
      <div class="actions">
        <div class="amount num">${fmtKES(c.amount)}</div>
        ${reminderAction(c, 'upcoming')}
        <button class="btn-sm" onclick="quickPay(${c.id})">Mark paid</button>
      </div>
    </div>
  `).join('');
}

function renderOverdue() {
  const today = todayISO();
  const overdue = state.clients
    .filter((c) => c.status === 'active' && c.next_due && c.next_due < today)
    .sort((a, b) => a.next_due.localeCompare(b.next_due));

  const el = $('#overdueList');
  if (overdue.length === 0) {
    el.innerHTML = '<div class="empty">No overdue clients. Nice.</div>';
    return;
  }
  el.innerHTML = overdue.map((c) => `
    <div class="list-row danger">
      <div>
        <div class="primary">${escapeHtml(c.name)}</div>
        <div class="sub">
          <span class="badge danger">${Math.abs(daysFromToday(c.next_due))} days late</span>
          <span>Was due ${fmtDate(c.next_due)}</span>
        </div>
      </div>
      <div class="actions">
        <div class="amount num">${fmtKES(c.amount)}</div>
        ${reminderAction(c, 'overdue')}
        <button class="btn-sm" onclick="quickPay(${c.id})">Mark paid</button>
      </div>
    </div>
  `).join('');
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

function renderClientsList() {
  const el = $('#clientsList');
  if (state.clients.length === 0) {
    el.innerHTML = '<div class="empty">No clients yet. Add your first one.</div>';
    return;
  }
  const sorted = [...state.clients].sort((a, b) => {
    const sa = a.status === 'active' ? 0 : 1;
    const sb = b.status === 'active' ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return a.name.localeCompare(b.name);
  });
  el.innerHTML = sorted.map((c) => {
    const overdue = c.status === 'active' && c.next_due && c.next_due < todayISO();
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
        </div>
        <div class="actions">
          <div class="amount num">${fmtKES(c.amount)}</div>
          <button class="btn-sm" onclick="quickPay(${c.id})">Pay</button>
          <button class="btn-sm" onclick="editClient(${c.id})">Edit</button>
          <button class="btn-sm danger" onclick="deleteClient(${c.id})">Delete</button>
        </div>
      </div>
    `;
  }).join('');
}

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

// ────────── Revenue tab ──────────

function periodStart(period) {
  const today = parseISO(todayISO());
  if (period === '30d') return new Date(today.getTime() - 30 * 86400000).toISOString().slice(0, 10);
  if (period === '6mo') {
    const d = new Date(today);
    d.setMonth(d.getMonth() - 6);
    return d.toISOString().slice(0, 10);
  }
  if (period === '1yr') {
    const d = new Date(today);
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  }
  return '0000-01-01';
}

function renderRevenue() {
  const p = state.revenuePeriod;
  const start = periodStart(p);
  const inPeriod = state.payments.filter((x) => x.paid_on >= start);
  const total = inPeriod.reduce((s, x) => s + x.amount, 0);

  const recurringClientIds = new Set(
    state.clients.filter((c) => c.plan === 'monthly' || c.plan === 'quarterly').map((c) => c.id)
  );
  const recurring = inPeriod.filter((x) => recurringClientIds.has(x.client_id)).reduce((s, x) => s + x.amount, 0);
  const oneOff = total - recurring;

  const monthlyMrr = state.clients
    .filter((c) => c.status === 'active' && c.plan === 'monthly')
    .reduce((s, c) => s + c.amount, 0);
  const quarterlyMrr = state.clients
    .filter((c) => c.status === 'active' && c.plan === 'quarterly')
    .reduce((s, c) => s + c.amount / 3, 0);
  const mrr = monthlyMrr + quarterlyMrr;

  $('#revenueSummary').innerHTML = `
    <div class="kpi-card">
      <div class="kpi-label">Total ${periodWord(p)}</div>
      <div class="kpi-value">${fmtKES(total)}</div>
      <div class="kpi-sub">${inPeriod.length} payments</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Recurring</div>
      <div class="kpi-value">${fmtKES(recurring)}</div>
      <div class="kpi-sub">${pct(recurring, total)}% of total</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">One off</div>
      <div class="kpi-value">${fmtKES(oneOff)}</div>
      <div class="kpi-sub">${pct(oneOff, total)}% of total</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">MRR (avg)</div>
      <div class="kpi-value">${fmtKES(mrr)}</div>
      <div class="kpi-sub">monthly + quarterly/3</div>
    </div>
  `;

  renderBarChart();
  renderTopClients(inPeriod);
}

function periodWord(p) {
  if (p === '30d') return '(30 days)';
  if (p === '6mo') return '(6 months)';
  if (p === '1yr') return '(12 months)';
  return '(all time)';
}

function pct(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 100);
}

function renderBarChart() {
  const months = [];
  const today = parseISO(todayISO());
  for (let i = 11; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const key = d.toISOString().slice(0, 7);
    months.push({ key, label: d.toLocaleDateString('en-GB', { month: 'short' }), total: 0 });
  }
  state.payments.forEach((p) => {
    const k = p.paid_on.slice(0, 7);
    const m = months.find((x) => x.key === k);
    if (m) m.total += p.amount;
  });
  const max = Math.max(...months.map((m) => m.total), 1);

  $('#revenueChart').innerHTML = `
    <div class="bar-chart">
      ${months.map((m) => {
        const pct = (m.total / max) * 100;
        return `
          <div class="bar-col">
            <div class="bar-value">${m.total > 0 ? shortNum(m.total) : ''}</div>
            ${m.total > 0
              ? `<div class="bar" style="height: ${pct}%; min-height: 4px;" title="${m.label}: ${fmtKES(m.total)}"></div>`
              : `<div class="bar-spacer"></div>`}
            <div class="bar-label">${m.label}</div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function shortNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return Math.round(n / 1000) + 'k';
  return String(n);
}

function renderTopClients(payments) {
  const byClient = {};
  payments.forEach((p) => {
    byClient[p.client_id] = (byClient[p.client_id] || 0) + p.amount;
  });
  const rows = Object.entries(byClient)
    .map(([id, total]) => {
      const c = state.clients.find((x) => x.id === Number(id));
      return { name: c ? c.name : 'Unknown', total };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  const el = $('#topClients');
  if (rows.length === 0) {
    el.innerHTML = '<div class="empty">No payments in this period.</div>';
    return;
  }
  el.innerHTML = rows.map((r) => `
    <div class="list-row">
      <div class="primary">${escapeHtml(r.name)}</div>
      <div class="amount num">${fmtKES(r.total)}</div>
    </div>
  `).join('');
}

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
            <option value="quarterly" ${isEdit && c.plan === 'quarterly' ? 'selected' : ''}>Quarterly</option>
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
      <label>
        <span>Notes <span class="hint">(optional)</span></span>
        <textarea name="notes">${isEdit && c.notes ? escapeHtml(c.notes) : ''}</textarea>
      </label>
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

window.deleteClient = async function (id) {
  const c = state.clients.find((x) => x.id === id);
  if (!c) return;
  if (!confirm(`Delete ${c.name}? This also deletes all their payments.`)) return;
  try {
    await api(`/api/clients/${id}`, { method: 'DELETE' });
    await loadData();
    toast('Client deleted');
  } catch (err) {
    toast(err.message, 'error');
  }
};

function paymentFormHtml(preselect) {
  const opts = state.clients
    .filter((c) => c.status === 'active' || c.id === (preselect && preselect.id))
    .map((c) => `<option value="${c.id}" ${preselect && preselect.id === c.id ? 'selected' : ''}>${escapeAttr(c.name)} — ${fmtKES(c.amount)}</option>`)
    .join('');
  const amount = preselect ? preselect.amount : '';
  const method = preselect && preselect.method ? preselect.method : '';
  return `
    <h2>Record payment</h2>
    <form id="paymentForm">
      <label>
        <span>Client</span>
        <select name="client_id" required>
          <option value="">Pick a client…</option>
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
            <option value="cheque" ${method === 'cheque' ? 'selected' : ''}>Cheque</option>
            <option value="bank" ${method === 'bank' ? 'selected' : ''}>Bank</option>
            <option value="cash" ${method === 'cash' ? 'selected' : ''}>Cash</option>
          </select>
        </label>
        <label>
          <span>Reference <span class="hint">(Mpesa code, cheque #)</span></span>
          <input type="text" name="reference">
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

window.recordPayment = function (clientId) {
  const preselect = clientId != null ? state.clients.find((c) => c.id === clientId) : null;
  openModal(paymentFormHtml(preselect));
  // Auto-fill amount when client changes
  $('#paymentForm select[name="client_id"]').addEventListener('change', (e) => {
    const c = state.clients.find((x) => x.id === Number(e.target.value));
    if (c) {
      $('#paymentForm input[name="amount"]').value = c.amount;
      if (c.method) $('#paymentForm select[name="method"]').value = c.method;
    }
  });
  $('#paymentForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      client_id: Number(fd.get('client_id')),
      amount: Number(fd.get('amount')) || 0,
      paid_on: fd.get('paid_on'),
      method: fd.get('method') || null,
      reference: fd.get('reference').trim() || null,
      notes: fd.get('notes').trim() || null,
    };
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
