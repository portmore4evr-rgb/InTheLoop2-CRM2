let STAGES = [];
let LEADS = [];
let currentTab = 'pipeline';

const stageColors = {
  0: 'border-hair',
  1: 'border-hair',
  2: 'border-hair',
  3: 'border-amber/50',
  4: 'border-teal/50',
};

async function init() {
  STAGES = await fetch('/api/stages').then((r) => r.json());
  populateStageSelect();
  await refreshLeads();
  bindEvents();
  renderCurrentTab();
}

async function refreshLeads() {
  LEADS = await fetch('/api/leads').then((r) => r.json());
}

function populateStageSelect() {
  const sel = document.getElementById('f-stage');
  sel.innerHTML = STAGES.map((s) => `<option value="${s}">${s}</option>`).join('');
}

function bindEvents() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('btn-add-lead').addEventListener('click', () => openModal());
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'modal-backdrop') closeModal();
  });

  document.getElementById('lead-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveLead();
  });

  document.getElementById('btn-delete').addEventListener('click', async () => {
    const id = document.getElementById('f-id').value;
    if (!id) return;
    if (!confirm('Delete this restaurant record? This cannot be undone.')) return;
    await fetch(`/api/leads/${id}`, { method: 'DELETE' });
    closeModal();
    await refreshLeads();
    renderCurrentTab();
  });

  document.getElementById('btn-copy-checkin').addEventListener('click', () => {
    const link = document.getElementById('checkin-link-display').textContent;
    navigator.clipboard.writeText(link).catch(() => {});
    const btn = document.getElementById('btn-copy-checkin');
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => (btn.textContent = original), 1500);
  });

  document.getElementById('btn-add-customer').addEventListener('click', addCustomer);
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('tab-active', active);
    btn.classList.toggle('tab-inactive', !active);
  });
  ['pipeline', 'restaurants', 'analytics'].forEach((t) => {
    document.getElementById('view-' + t).classList.toggle('hidden', t !== tab);
  });
  renderCurrentTab();
}

function renderCurrentTab() {
  if (currentTab === 'pipeline') renderPipeline();
  if (currentTab === 'restaurants') renderRestaurants();
  if (currentTab === 'analytics') renderAnalytics();
}

function renderPipeline() {
  const board = document.getElementById('pipeline-board');
  board.innerHTML = STAGES.map((stage, i) => {
    const items = LEADS.filter((l) => l.stage === stage);
    return `
      <div class="card p-3 border-2 ${stageColors[i]} flex flex-col min-h-[200px]">
        <p class="font-mono text-[11px] uppercase tracking-wider text-inkmute mb-3 flex items-center justify-between">
          <span>${stage}</span><span class="text-ink">${items.length}</span>
        </p>
        <div class="space-y-2 flex-1">
          ${items.map((l) => leadCard(l, i)).join('') || '<p class="text-inkmute text-xs text-center py-6">Empty</p>'}
        </div>
      </div>
    `;
  }).join('');

  board.querySelectorAll('[data-open]').forEach((el) => {
    el.addEventListener('click', () => openModal(el.dataset.open));
  });
  board.querySelectorAll('[data-advance]').forEach((el) => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = el.dataset.advance;
      const nextIdx = parseInt(el.dataset.nextIdx, 10);
      await fetch(`/api/leads/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: STAGES[nextIdx] }),
      });
      await refreshLeads();
      renderCurrentTab();
    });
  });
}

function leadCard(lead, stageIdx) {
  const canAdvance = stageIdx < STAGES.length - 1;
  return `
    <div class="bg-bg border border-hair rounded-lg p-3 cursor-pointer hover:border-teal transition" data-open="${lead.id}">
      <p class="text-sm font-medium mb-1">${escapeHtml(lead.restaurantName)}</p>
      <p class="text-xs text-inkmute mb-2">${escapeHtml(lead.contactName || 'No contact yet')}</p>
      ${canAdvance ? `<button data-advance="${lead.id}" data-next-idx="${stageIdx + 1}" class="w-full font-mono text-[10px] uppercase tracking-wider border border-teal text-teal rounded py-1.5 hover:bg-teal hover:text-bg transition">Move to ${STAGES[stageIdx + 1]} →</button>` : `<span class="font-mono text-[10px] uppercase tracking-wider text-teal">● Active Client</span>`}
    </div>
  `;
}

function renderRestaurants() {
  const tbody = document.getElementById('restaurants-tbody');
  const empty = document.getElementById('restaurants-empty');
  if (LEADS.length === 0) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  tbody.innerHTML = LEADS.map((l) => `
    <tr class="hover:bg-panel2 cursor-pointer transition" data-open="${l.id}">
      <td class="px-5 py-3">${escapeHtml(l.restaurantName)}</td>
      <td class="px-5 py-3 text-inkmute">${escapeHtml(l.contactName || '—')}</td>
      <td class="px-5 py-3 text-inkmute">${escapeHtml(l.slowestNight || '—')}</td>
      <td class="px-5 py-3 text-inkmute">${escapeHtml(l.currentOffer || '—')}</td>
      <td class="px-5 py-3"><span class="font-mono text-xs px-2 py-1 rounded ${l.stage === 'Live Client' ? 'bg-teal/15 text-teal' : 'bg-hair text-inkmute'}">${l.stage}</span></td>
    </tr>
  `).join('');
  tbody.querySelectorAll('[data-open]').forEach((el) => {
    el.addEventListener('click', () => openModal(el.dataset.open));
  });
}

async function renderAnalytics() {
  const a = await fetch('/api/analytics').then((r) => r.json());
  document.getElementById('kpi-total').textContent = a.total;
  document.getElementById('kpi-live').textContent = a.liveClients;
  document.getElementById('kpi-conversion').textContent = a.conversionRate + '%';
  document.getElementById('kpi-deals').textContent = a.dealsClosedThisMonth;
  document.getElementById('kpi-customers').textContent = a.totalCustomers;
  document.getElementById('kpi-redemptions').textContent = a.totalRedemptions;

  const maxCount = Math.max(1, ...Object.values(a.byStage));
  const funnel = document.getElementById('funnel-bars');
  funnel.innerHTML = STAGES.map((stage) => {
    const count = a.byStage[stage] || 0;
    const pct = Math.round((count / maxCount) * 100);
    return `
      <div>
        <div class="flex justify-between text-sm mb-1"><span>${stage}</span><span class="font-mono">${count}</span></div>
        <div class="h-3 rounded-full bg-hair overflow-hidden"><div class="h-full bg-teal" style="width:${pct}%"></div></div>
      </div>
    `;
  }).join('');

  const recentEl = document.getElementById('recent-activity');
  recentEl.innerHTML = a.recent.length
    ? a.recent.map((r) => `
        <div class="flex justify-between items-center bg-bg border border-hair rounded-lg px-3 py-2.5 text-sm">
          <span>${escapeHtml(r.restaurantName)}</span>
          <span class="font-mono text-[11px] text-inkmute">${r.stage}</span>
        </div>
      `).join('')
    : '<p class="text-inkmute text-sm text-center py-6">No activity yet.</p>';
}

function openModal(id) {
  const form = document.getElementById('lead-form');
  form.reset();
  const deleteBtn = document.getElementById('btn-delete');
  const customersSection = document.getElementById('customers-section');

  if (id) {
    const lead = LEADS.find((l) => l.id === id);
    document.getElementById('modal-title').textContent = lead.restaurantName;
    document.getElementById('f-id').value = lead.id;
    document.getElementById('f-restaurantName').value = lead.restaurantName || '';
    document.getElementById('f-contactName').value = lead.contactName || '';
    document.getElementById('f-phone').value = lead.phone || '';
    document.getElementById('f-email').value = lead.email || '';
    document.getElementById('f-slowestNight').value = lead.slowestNight || '';
    document.getElementById('f-stage').value = lead.stage;
    document.getElementById('f-currentOffer').value = lead.currentOffer || '';
    document.getElementById('f-notes').value = lead.notes || '';
    deleteBtn.classList.remove('hidden');

    customersSection.classList.remove('hidden');
    const checkinUrl = `${window.location.origin}/checkin/${lead.id}`;
    document.getElementById('checkin-link-display').textContent = checkinUrl;
    document.getElementById('checkin-qr').src =
      `https://api.qrserver.com/v1/create-qr-code/?size=140x140&color=14181A&bgcolor=F3EFE6&data=${encodeURIComponent(checkinUrl)}`;
    loadCustomers(lead.id);
  } else {
    document.getElementById('modal-title').textContent = 'Add Lead';
    document.getElementById('f-id').value = '';
    document.getElementById('f-stage').value = STAGES[0];
    deleteBtn.classList.add('hidden');
    customersSection.classList.add('hidden');
  }

  document.getElementById('modal-backdrop').classList.remove('hidden');
}

async function loadCustomers(restaurantId) {
  const customers = await fetch(`/api/leads/${restaurantId}/customers`).then((r) => r.json());
  document.getElementById('customers-count').textContent = `(${customers.length})`;
  const list = document.getElementById('customers-list');
  list.innerHTML = customers.length
    ? customers.map((c) => `
        <div class="bg-bg border border-hair rounded-lg px-3 py-2 flex items-center justify-between text-sm">
          <div>
            <span>${escapeHtml(c.name || 'No name')}</span>
            <span class="text-inkmute font-mono text-xs ml-2">${escapeHtml(c.phone)}</span>
          </div>
          <span class="font-mono text-[11px] text-teal">${c.redemptionCount || 0} redeemed</span>
        </div>
      `).join('')
    : '<p class="text-inkmute text-sm text-center py-4">No customers yet — share the check-in link above.</p>';
}

async function addCustomer() {
  const id = document.getElementById('f-id').value;
  if (!id) return;
  const name = document.getElementById('cust-name').value.trim();
  const phone = document.getElementById('cust-phone').value.trim();
  if (!phone) return;
  await fetch(`/api/leads/${id}/customers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, phone }),
  });
  document.getElementById('cust-name').value = '';
  document.getElementById('cust-phone').value = '';
  loadCustomers(id);
}

function closeModal() {
  document.getElementById('modal-backdrop').classList.add('hidden');
}

async function saveLead() {
  const id = document.getElementById('f-id').value;
  const payload = {
    restaurantName: document.getElementById('f-restaurantName').value,
    contactName: document.getElementById('f-contactName').value,
    phone: document.getElementById('f-phone').value,
    email: document.getElementById('f-email').value,
    slowestNight: document.getElementById('f-slowestNight').value,
    stage: document.getElementById('f-stage').value,
    currentOffer: document.getElementById('f-currentOffer').value,
    notes: document.getElementById('f-notes').value,
  };

  if (id) {
    await fetch(`/api/leads/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } else {
    await fetch('/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  closeModal();
  await refreshLeads();
  renderCurrentTab();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

init();
