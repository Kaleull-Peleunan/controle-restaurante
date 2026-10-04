const app = document.getElementById('app');

const state = {
  user: null,
  token: localStorage.getItem('comanda_token') || '',
  loadError: '',
  loginError: '',
  cardTerminalMessage: '',
  tables: [],
  products: [],
  users: [],
  authorizers: [],
  reportOptions: [],
  activeOrderId: null,
  activeOrder: null,
  orderModalOpen: false,
  history: [],
  notices: [],
  noticeComposer: null,
  noticeError: '',
  settings: { restaurantName: 'Comanda' },
  report: null,
  audit: [],
  productionItems: [],
  productionError: '',
  view: 'operations'
};

let productionRefreshTimer;
let noticeRefreshTimer;
let noticeRepeatTimer;
let noticeAudioContext = null;
let knownNoticeIds = null;
let repeatingNoticeId = null;
let noticeRepeatCount = 0;

const NOTICE_PRESETS = [
  'Precisa de ajuda aqui',
  'Cliente pedindo a conta',
  'Trazer mais gelo',
  'Trocar o barril',
  'Verificar o caixa'
];

function noticeAlertPreference(name) {
  const stored = localStorage.getItem(`comanda_notice_${name}`);
  return stored === null ? true : stored === 'true';
}

function unlockNoticeAudio() {
  if (!noticeAlertPreference('sound')) return;
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!noticeAudioContext || noticeAudioContext.state === 'closed') {
      noticeAudioContext = new AudioContextClass();
    }
    if (noticeAudioContext.state === 'suspended') {
      noticeAudioContext.resume().catch((error) => console.warn('Não foi possível habilitar o áudio.', error));
    }
  } catch (error) {
    console.warn('Não foi possível habilitar o áudio neste navegador.', error);
  }
}

function playNoticeAlert() {
  if (noticeAlertPreference('sound')) {
    unlockNoticeAudio();
    const context = noticeAudioContext;
    if (context && context.state !== 'closed') {
      const startAt = context.currentTime + 0.01;
      [[0, 880], [0.15, 1245]].forEach(([offset, frequency]) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, startAt + offset);
        gain.gain.exponentialRampToValueAtTime(0.2, startAt + offset + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + offset + 0.15);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(startAt + offset);
        oscillator.stop(startAt + offset + 0.17);
      });
    }
  }
  if (noticeAlertPreference('vibrate') && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate([180, 90, 180]);
    } catch (error) {
      console.warn('Não foi possível emitir vibração neste dispositivo.', error);
    }
  }
}

function pendingNotices() {
  return state.notices.filter((notice) => !notice.readAt);
}

function stopNoticeRepeat() {
  if (noticeRepeatTimer) clearTimeout(noticeRepeatTimer);
  noticeRepeatTimer = null;
  repeatingNoticeId = null;
  noticeRepeatCount = 0;
}

function updateNoticeAlerts(notices) {
  const previousIds = knownNoticeIds;
  knownNoticeIds = new Set(notices.map((notice) => notice.id));
  const newPending = previousIds
    ? notices.filter((notice) => !previousIds.has(notice.id) && !notice.readAt)
    : pendingNotices();
  const pending = pendingNotices().slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  if (repeatingNoticeId && !pending.some((notice) => notice.id === repeatingNoticeId)) stopNoticeRepeat();
  if (!pending.length) stopNoticeRepeat();
  if (newPending.length) {
    stopNoticeRepeat();
    repeatingNoticeId = newPending[newPending.length - 1].id;
    playNoticeAlert();
  } else if (!repeatingNoticeId && pending.length) {
    repeatingNoticeId = pending[0].id;
    playNoticeAlert();
  }

  if (repeatingNoticeId && noticeRepeatCount < 3 && !noticeRepeatTimer) {
    noticeRepeatTimer = setTimeout(() => {
      noticeRepeatTimer = null;
      if (!pendingNotices().some((notice) => notice.id === repeatingNoticeId)) {
        stopNoticeRepeat();
        updateNoticeAlerts(state.notices);
        return;
      }
      noticeRepeatCount += 1;
      playNoticeAlert();
      updateNoticeToast();
    }, 30000);
  }
  updateNoticeToast();
}

function updateNoticeToast() {
  const root = document.getElementById('noticeToastRoot');
  if (!root) return;
  const count = pendingNotices().length;
  const button = document.querySelector('[data-view="notices"]');
  if (button) {
    button.innerHTML = `Avisos${count ? ` <span class="notice-count">${count}</span>` : ''}`;
    button.setAttribute('aria-label', count ? `Avisos, ${count} pendente(s)` : 'Avisos');
  }
  const notice = pendingNotices().slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
  if (!notice) {
    root.innerHTML = '';
    return;
  }
  const table = state.tables.find((item) => item.id === notice.tableId);
  root.innerHTML = `
    <aside class="notice-toast" role="alert">
      <div><strong>${notice.type === 'call' ? 'Chamado' : 'Recado'} · ${escapeHtml(notice.fromName || 'Equipe')}</strong>
        ${table ? `<span>Mesa ${escapeHtml(table.number)}</span>` : ''}</div>
      <p>${escapeHtml(notice.message)}</p>
      <div class="notice-toast-actions">
        ${notice.tableId ? `<button class="btn btn-secondary" type="button" data-go-notice="${escapeHtml(notice.id)}">Ir para a mesa</button>` : ''}
        <button class="btn btn-quiet" type="button" data-read-notice="${escapeHtml(notice.id)}">Entendi</button>
      </div>
    </aside>`;
  root.querySelector('[data-read-notice]')?.addEventListener('click', async () => {
    try { await markNoticeRead(notice.id); } catch (error) { alert(error.message); }
  });
  root.querySelector('[data-go-notice]')?.addEventListener('click', async () => {
    try { await goToNoticeTable(notice); } catch (error) { alert(error.message); }
  });
}

function renderNoticeList() {
  return `
    ${state.noticeError ? `<div class="notice" role="alert">${escapeHtml(state.noticeError)}</div>` : ''}
    <div class="notice-list">
      ${state.notices.length ? state.notices.map((notice) => {
        const table = state.tables.find((item) => item.id === notice.tableId);
        return `
          <article class="notice-item ${notice.readAt ? 'is-read' : 'is-unread'}">
            <div><strong>${notice.type === 'call' ? 'Chamado' : 'Recado'} · ${escapeHtml(notice.fromName || 'Equipe')}</strong>
              ${notice.toName ? `<span>Para ${escapeHtml(notice.toName)}</span>` : '<span>Toda a equipe</span>'}
              ${table ? `<span>Mesa ${escapeHtml(table.number)}</span>` : ''}
            </div>
            <p>${escapeHtml(notice.message)}</p>
            <small>${new Date(notice.createdAt).toLocaleString('pt-BR')}</small>
            <div class="notice-item-actions">
              ${table ? `<button class="btn btn-secondary" data-open-notice-table="${escapeHtml(notice.id)}" type="button">Ir para a mesa</button>` : ''}
              ${!notice.readAt ? `<button class="btn btn-secondary" data-mark-read="${escapeHtml(notice.id)}" type="button">Marcar como lido</button>` : '<span class="read-label">Lido</span>'}
            </div>
          </article>`;
      }).join('') : '<div class="empty-box">Nenhum aviso recebido.</div>'}
    </div>`;
}

function bindNoticeListActions() {
  document.querySelectorAll('[data-mark-read]').forEach((button) => {
    button.addEventListener('click', async () => {
      try { await markNoticeRead(button.dataset.markRead); } catch (error) { alert(error.message); }
    });
  });
  document.querySelectorAll('[data-open-notice-table]').forEach((button) => {
    button.addEventListener('click', async () => {
      const notice = state.notices.find((item) => item.id === button.dataset.openNoticeTable);
      if (!notice) return;
      try { await goToNoticeTable(notice); } catch (error) { alert(error.message); }
    });
  });
}

function updateNoticePage() {
  const list = document.getElementById('noticeListRoot');
  if (list) {
    list.innerHTML = renderNoticeList();
    bindNoticeListActions();
  }
  const markAll = document.getElementById('markAllNoticesRead');
  if (markAll) markAll.disabled = pendingNotices().length === 0;
}

async function refreshNotices() {
  try {
    state.notices = await api.request('/api/notices');
    state.noticeError = '';
    updateNoticeAlerts(state.notices);
    updateNoticePage();
  } catch (error) {
    state.noticeError = `Falha ao atualizar avisos: ${error.message}`;
    console.error(state.noticeError, error);
    if (error.status === 401) {
      localStorage.removeItem('comanda_token');
      state.token = '';
      state.user = null;
      if (noticeRefreshTimer) clearInterval(noticeRefreshTimer);
      noticeRefreshTimer = null;
      stopNoticeRepeat();
      knownNoticeIds = null;
      render();
      return;
    }
    updateNoticePage();
  }
}

function startNoticePolling() {
  if (noticeRefreshTimer) return;
  updateNoticeAlerts(state.notices);
  noticeRefreshTimer = setInterval(refreshNotices, 5000);
}

const api = {
  async request(path, options = {}) {
    const token = state.token;
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };

    if (token) {
      headers.Authorization = String.fromCharCode(66, 101, 97, 114, 101, 114, 32) + token;
    }

    const response = await fetch(path, {
      ...options,
      headers
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || 'Erro inesperado');
      error.status = response.status;
      throw error;
    }

    return data;
  }
};

async function login(email, password) {
  const result = await api.request('/api/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });

  state.token = result.token;
  state.user = result.user;
  localStorage.setItem('comanda_token', result.token);
  await loadAppData();
}

async function loadAppData() {
  state.loadError = '';
  state.loginError = '';
  try {
    const me = await api.request('/api/me');
    state.user = me;
    const [tables, products, history, notices, settings, users, authorizers, audit, reportOptions] = await Promise.all([
      api.request('/api/tables'),
      api.request('/api/products?includeInactive=true'),
      api.request('/api/history'),
      api.request('/api/notices'),
      api.request('/api/settings'),
      me.role === 'admin' ? api.request('/api/users') : Promise.resolve([]),
      api.request('/api/authorizers'),
      me.role === 'admin' ? api.request('/api/audit') : Promise.resolve([]),
      api.request('/api/report-options')
    ]);

    state.tables = tables;
    state.products = products;
    state.history = history;
    state.notices = notices;
    updateNoticeAlerts(notices);
    state.settings = settings;
    state.users = users;
    state.authorizers = authorizers;
    state.audit = audit;
    state.reportOptions = reportOptions;

    const activeTable = state.activeOrderId
      ? state.tables.find((table) => table.openOrderId === state.activeOrderId)
      : null;
    const selectedTable = activeTable
      || state.tables.find((table) => table.openOrderId);
    state.activeOrderId = selectedTable?.openOrderId || null;
    state.activeOrder = state.activeOrderId
      ? await api.request(`/api/orders/${state.activeOrderId}`)
      : null;

    render();
  } catch (error) {
    console.error(error);
    if (error.status === 401) {
      localStorage.removeItem('comanda_token');
      state.token = '';
      state.user = null;
      if (noticeRefreshTimer) clearInterval(noticeRefreshTimer);
      noticeRefreshTimer = null;
      stopNoticeRepeat();
      knownNoticeIds = null;
      state.loginError = 'Sua sessão expirou. Entre novamente.';
      render();
      return;
    }

    state.loadError = error.message;
    if (state.user) {
      renderDashboard();
    } else {
      state.loginError = `Falha ao carregar os dados: ${error.message}`;
      renderLogin();
    }
  }
}

async function loadProductionItems() {
  const station = state.view === 'bar' ? 'bar' : 'kitchen';
  state.productionItems = await api.request(`/api/production?station=${station}`);
  state.productionError = '';
  render();
}

async function updateProductionStatus(itemId, status) {
  await api.request(`/api/production/${itemId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status })
  });
  await loadProductionItems();
}

async function saveRestaurantName(restaurantName, tableCount, values) {
  state.settings = await api.request('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ restaurantName, tableCount: Number(tableCount), ...values })
  });
  document.querySelector('.topbar h1').textContent = state.settings.restaurantName;
  const message = document.getElementById('settingsMessage');
  message.textContent = 'Configuração salva.';
  message.className = 'form-success';
}

async function saveCardTerminals(cardTerminals) {
  state.settings = await api.request('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ restaurantName: state.settings.restaurantName, cardTerminals })
  });
  state.cardTerminalMessage = 'Configuração salva. O processamento de cobranças ainda depende da integração e credenciais do provedor.';
  render();
}

async function setProductStation(productId, station) {
  await api.request(`/api/products/${productId}/production-station`, {
    method: 'PATCH',
    body: JSON.stringify({ station })
  });
  state.products = await api.request('/api/products?includeInactive=true');
  render();
}

async function saveProduct(productId, values) {
  await api.request(productId ? `/api/products/${productId}` : '/api/products', {
    method: productId ? 'PATCH' : 'POST',
    body: JSON.stringify(values)
  });
  await loadAppData();
}

async function saveUser(userId, values) {
  await api.request(userId ? `/api/users/${userId}` : '/api/users', {
    method: userId ? 'PATCH' : 'POST',
    body: JSON.stringify(values)
  });
  await loadAppData();
}

async function sendNotice({ message = '', tableId = null, toUserId = null, type = 'message' }) {
  await api.request('/api/notices', {
    method: 'POST',
    body: JSON.stringify({ message, tableId: tableId || null, toUserId: toUserId || null, type })
  });
  state.notices = await api.request('/api/notices');
  updateNoticeAlerts(state.notices);
  state.noticeComposer = null;
  render();
}

async function markNoticeRead(noticeId) {
  await api.request(`/api/notices/${noticeId}/read`, { method: 'PATCH', body: JSON.stringify({}) });
  state.notices = await api.request('/api/notices');
  updateNoticeAlerts(state.notices);
  render();
}

async function markAllNoticesRead() {
  await Promise.all(pendingNotices().map((notice) => api.request(`/api/notices/${notice.id}/read`, {
    method: 'PATCH',
    body: JSON.stringify({})
  })));
  state.notices = await api.request('/api/notices');
  updateNoticeAlerts(state.notices);
  render();
}

async function goToNoticeTable(notice) {
  await api.request(`/api/notices/${notice.id}/read`, { method: 'PATCH', body: JSON.stringify({}) });
  const table = state.tables.find((item) => item.id === notice.tableId);
  state.view = 'operations';
  state.noticeComposer = null;
  if (table?.openOrderId) {
    state.activeOrderId = table.openOrderId;
    state.orderModalOpen = true;
    await loadAppData();
    return;
  }
  state.orderModalOpen = false;
  await loadAppData();
  if (table) {
    const tableButton = document.querySelector(`[data-open-table="${CSS.escape(table.id)}"]`);
    tableButton?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    tableButton?.focus();
  }
}

function renderNoticeComposer() {
  if (!state.noticeComposer) return '';
  const tableId = state.noticeComposer.tableId || '';
  const recipients = state.reportOptions.filter((user) => user.id !== state.user?.id);
  return `
    <div class="notice-composer-backdrop" data-notice-composer-backdrop>
      <section class="notice-composer order-panel" role="dialog" aria-modal="true" aria-labelledby="noticeComposerTitle">
        <div class="section-heading">
          <div><p class="eyebrow">COMUNICAÇÃO DA EQUIPE</p><h2 id="noticeComposerTitle">Avisar alguém</h2></div>
          <button class="btn btn-quiet" type="button" data-close-notice-composer aria-label="Fechar">×</button>
        </div>
        <label>Para quem
          <select id="noticeRecipient">
            <option value="">Toda a equipe</option>
            ${recipients.map((user) => `<option value="${escapeHtml(user.id)}" ${recipients[0]?.id === user.id ? 'selected' : ''}>${escapeHtml(user.name)}</option>`).join('')}
          </select>
        </label>
        <label>Mesa relacionada (opcional)
          <select id="noticeTable">
            <option value="">Sem mesa</option>
            ${state.tables.map((table) => `<option value="${escapeHtml(table.id)}" ${table.id === tableId ? 'selected' : ''}>Mesa ${escapeHtml(table.number)}</option>`).join('')}
          </select>
        </label>
        <button class="btn btn-warning" id="sendNoticeCall" type="button">🔔 Chamar sem mensagem</button>
        <div class="notice-presets">
          ${NOTICE_PRESETS.map((preset) => `<button class="btn btn-secondary" type="button" data-notice-preset="${escapeHtml(preset)}">${escapeHtml(preset)}</button>`).join('')}
        </div>
        <label>Recado (até 160 caracteres)
          <textarea id="noticeMessage" maxlength="160" rows="3" placeholder="Escreva um recado para a equipe"></textarea>
        </label>
        <div class="notice-composer-actions">
          <button class="btn btn-primary" id="sendNoticeMessage" type="button">Enviar recado</button>
          <button class="btn btn-quiet" type="button" data-close-notice-composer>Cancelar</button>
        </div>
      </section>
    </div>`;
}

function bindNoticeComposer() {
  const composer = document.querySelector('.notice-composer');
  composer?.querySelector('#noticeRecipient')?.focus();
  composer?.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    state.noticeComposer = null;
    render();
  });
  document.querySelectorAll('[data-open-notice-composer]').forEach((button) => {
    button.addEventListener('click', () => {
      state.noticeComposer = { tableId: button.dataset.tableId || '' };
      render();
    });
  });
  document.querySelectorAll('[data-close-notice-composer], [data-notice-composer-backdrop]').forEach((element) => {
    element.addEventListener('click', (event) => {
      if (element.hasAttribute('data-notice-composer-backdrop') && event.target !== event.currentTarget) return;
      state.noticeComposer = null;
      render();
    });
  });
  document.querySelectorAll('[data-notice-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = document.getElementById('noticeMessage');
      input.value = button.dataset.noticePreset;
      input.focus();
    });
  });
  const submitNotice = async (type) => {
    try {
      const message = type === 'message' ? document.getElementById('noticeMessage').value.trim() : '';
      if (type === 'message' && !message) return alert('Escreva um recado antes de enviar.');
      await sendNotice({
        type,
        message,
        tableId: document.getElementById('noticeTable').value,
        toUserId: document.getElementById('noticeRecipient').value
      });
    } catch (error) {
      alert(error.message);
    }
  };
  document.getElementById('sendNoticeCall')?.addEventListener('click', () => submitNotice('call'));
  document.getElementById('sendNoticeMessage')?.addEventListener('click', () => submitNotice('message'));
}

async function downloadBackup() {
  const response = await fetch('/api/backup', {
    headers: { Authorization: String.fromCharCode(66, 101, 97, 114, 101, 114, 32) + state.token }
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Não foi possível gerar o backup');
  }

  const backupFile = await response.blob();
  const url = URL.createObjectURL(backupFile);
  const link = document.createElement('a');
  link.href = url;
  link.download = `backup-restaurante-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function importLegacyBackup(file) {
  const legacy = JSON.parse(await file.text());
  const summary = await api.request('/api/migration/import-legacy', {
    method: 'POST',
    body: JSON.stringify(legacy)
  });
  const [tables, products, history, notices, settings, users] = await Promise.all([
    api.request('/api/tables'),
    api.request('/api/products?includeInactive=true'),
    api.request('/api/history'),
    api.request('/api/notices'),
    api.request('/api/settings'),
    state.user.role === 'admin' ? api.request('/api/users') : Promise.resolve([])
  ]);
  Object.assign(state, { tables, products, history, notices, settings, users });
  return summary;
}

function bindNavigation() {
  updateNoticeToast();
  document.getElementById('retryAppLoadBtn')?.addEventListener('click', () => loadAppData());
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.addEventListener('click', async () => {
      state.view = button.dataset.view;
    if (state.view !== 'operations') state.orderModalOpen = false;
    state.productionError = '';
      if (state.view === 'kitchen' || state.view === 'bar') {
        try {
          await loadProductionItems();
        } catch (error) {
          state.productionError = error.message;
          render();
        }
      } else {
        render();
      }
    });
  });
}

function bindLogout() {
  document.getElementById('logoutBtn')?.addEventListener('click', () => {
    localStorage.removeItem('comanda_token');
    state.token = '';
    state.user = null;
    state.activeOrderId = null;
    state.activeOrder = null;
    state.loadError = '';
    state.loginError = '';
    state.view = 'operations';
    if (productionRefreshTimer) clearInterval(productionRefreshTimer);
    productionRefreshTimer = null;
    if (noticeRefreshTimer) clearInterval(noticeRefreshTimer);
    noticeRefreshTimer = null;
    stopNoticeRepeat();
    knownNoticeIds = null;
    render();
  });
}

async function createOrder(tableId, waiterName, pin) {
  const result = await api.request('/api/orders', {
    method: 'POST',
    body: JSON.stringify({ tableId, waiterId: state.user?.id || null, waiterName, pin })
  });

  state.activeOrderId = result.order.id;
  await loadAppData();
}

async function addItemToOrder(productId, qty = 1) {
  if (!state.activeOrderId) return;
  await api.request(`/api/orders/${state.activeOrderId}/items`, {
    method: 'POST',
    body: JSON.stringify({ productId, quantity: qty })
  });
  await loadAppData();
}

async function updateItemQty(itemId, quantity) {
  if (!state.activeOrderId) return;
  await api.request(`/api/orders/${state.activeOrderId}/items/${itemId}`, {
    method: 'PATCH',
    body: JSON.stringify({ quantity })
  });
  await loadAppData();
}

async function removeItem(itemId) {
  if (!state.activeOrderId) return;
  await api.request(`/api/orders/${state.activeOrderId}/items/${itemId}`, {
    method: 'DELETE'
  });
  await loadAppData();
}

async function applyDiscount(type, value) {
  if (!state.activeOrderId) return;
  const subtotal = Number(state.activeOrder?.subtotal || 0);
  const amount = type === 'percent' ? subtotal * Number(value) / 100 : Number(value);
  const percent = subtotal > 0 ? amount / subtotal * 100 : 0;
  const authorization = {};
  if (state.user?.role !== 'admin' && percent > Number(state.settings.discountLimit ?? 10) + 0.0001) {
    if (!state.authorizers.length) throw new Error('Não há administrador ativo para autorizar esse desconto.');
    const options = state.authorizers.map((user, index) => `${index + 1}. ${user.name}`).join('\n');
    const choice = window.prompt(`Selecione o administrador que autoriza:\n${options}`, '1');
    if (choice === null) return;
    const authorizer = state.authorizers[Number(choice) - 1];
    if (!authorizer) throw new Error('Administrador selecionado inválido.');
    authorization.authorizationUserId = authorizer.id;
    if (authorizer.pinRequired) {
      const pin = window.prompt(`Informe o PIN de ${authorizer.name}:`);
      if (pin === null) return;
      authorization.authorizationPin = pin;
    }
  }
  await api.request(`/api/orders/${state.activeOrderId}/discount`, {
    method: 'POST',
    body: JSON.stringify({ type, value, ...authorization })
  });
  await loadAppData();
}

async function setServiceFee(enabled) {
  if (!state.activeOrderId) return;
  await api.request(`/api/orders/${state.activeOrderId}/service-fee`, {
    method: 'POST',
    body: JSON.stringify({ enabled })
  });
  await loadAppData();
}

async function payOrder(method, amount, received = null, details = {}) {
  if (!state.activeOrderId) return;
  await api.request(`/api/orders/${state.activeOrderId}/pay`, {
    method: 'POST',
    body: JSON.stringify({ method, amount, received, ...details })
  });
  await loadAppData();
}

async function payNextPersonShare() {
  const order = state.activeOrder;
  if (!order) return;
  const count = Number(document.getElementById('splitPeopleCount')?.value || 2);
  if (!Number.isInteger(count) || count < 2 || count > 20) throw new Error('Informe entre 2 e 20 pessoas.');
  const paidPeople = new Set((order.payments || [])
    .filter((payment) => payment.status !== 'reversed' && payment.details?.split?.mode === 'person'
      && Number(payment.details.split.count) === count)
    .map((payment) => Number(payment.details.split.person)));
  const nextPerson = Array.from({ length: count }, (_, index) => index + 1).find((person) => !paidPeople.has(person));
  if (!nextPerson) throw new Error('Todas as partes desta divisão já foram recebidas.');
  const remaining = Math.max(0, Number(order.total) - Number(order.paidTotal));
  const unpaidCount = count - paidPeople.size;
  const amount = nextPerson === count ? remaining : Math.floor((remaining / unpaidCount) * 100) / 100;
  await payOrder(document.getElementById('payMethod').value, amount, null, {
    split: { mode: 'person', person: nextPerson, count }
  });
}

async function paySelectedItems() {
  const order = state.activeOrder;
  if (!order) return;
  const items = [...document.querySelectorAll('[data-pay-item]:checked')].map((checkbox) => {
    const quantityInput = document.querySelector(`[data-pay-quantity="${CSS.escape(checkbox.value)}"]`);
    return { itemId: checkbox.value, quantity: Number(quantityInput?.value || 0) };
  }).filter((item) => item.quantity > 0);
  if (!items.length) throw new Error('Selecione ao menos um item e uma quantidade válida.');
  await payOrder(document.getElementById('payMethod').value, null, null, { items, split: { mode: 'items' } });
}

async function transferOrder(tableId) {
  if (!state.activeOrderId) return;
  await api.request(`/api/orders/${state.activeOrderId}/transfer`, {
    method: 'POST', body: JSON.stringify({ tableId })
  });
  await loadAppData();
}

async function mergeOrders(sourceOrderId) {
  if (!state.activeOrderId) return;
  await api.request(`/api/orders/${state.activeOrderId}/merge`, {
    method: 'POST', body: JSON.stringify({ sourceOrderId })
  });
  await loadAppData();
}

async function cancelOrder(reason) {
  if (!state.activeOrderId) return;
  await api.request(`/api/orders/${state.activeOrderId}/cancel`, {
    method: 'POST', body: JSON.stringify({ reason })
  });
  state.activeOrderId = null;
  state.orderModalOpen = false;
  await loadAppData();
}

async function closeOrder() {
  if (!state.activeOrderId) return;
  await api.request(`/api/orders/${state.activeOrderId}/close`, {
    method: 'POST',
    body: JSON.stringify({})
  });
  state.activeOrderId = null;
  state.orderModalOpen = false;
  await loadAppData();
}

function printReceipt(order = state.activeOrder) {
  if (!order) return;
  const printWindow = window.open('', '_blank', 'width=420,height=720');
  if (!printWindow) {
    alert('O navegador bloqueou a janela de impressão. Permita pop-ups para este site e tente novamente.');
    return;
  }
  const lines = order.items.map((item) => `<tr><td>${escapeHtml(item.quantity)}× ${escapeHtml(item.productName)}</td><td>${formatMoney(item.total)}</td></tr>`).join('');
  printWindow.document.write(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Comanda ${escapeHtml(order.tableNumber || '')}</title>
    <style>body{font:14px monospace;max-width:340px;margin:24px auto}h1,h2,p{text-align:center}table{width:100%;border-collapse:collapse}td{padding:6px 0;border-bottom:1px dashed #aaa}td:last-child{text-align:right}.total{font-size:18px;font-weight:bold}</style>
    <h1>${escapeHtml(state.settings.restaurantName || 'Comanda')}</h1><p>Mesa ${escapeHtml(order.tableNumber || '—')} · ${escapeHtml(order.waiterName || 'Sem garçom')}</p>
    <p>${new Date(order.createdAt).toLocaleString('pt-BR')}</p><table>${lines}</table>
    <p>Subtotal: ${formatMoney(order.subtotal)}<br>Desconto: − ${formatMoney(order.discountAmount)}<br>Taxa: + ${formatMoney(order.serviceFeeAmount)}</p>
    <p class="total">Total: ${formatMoney(order.total)}</p><p>Pago: ${formatMoney(order.paidTotal)}</p><script>window.onload=()=>window.print();</script></html>`);
  printWindow.document.close();
}

function printProductionTicket(item) {
  const printWindow = window.open('', '_blank', 'width=420,height=520');
  if (!printWindow) {
    alert('O navegador bloqueou a janela de impressão. Permita pop-ups para este site e tente novamente.');
    return;
  }
  printWindow.document.write(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Pedido de produção</title>
    <style>body{font:16px monospace;max-width:340px;margin:24px auto}h1,p{text-align:center}li{padding:8px 0;font-size:20px}</style>
    <h1>${escapeHtml(item.station === 'bar' ? 'Bar' : 'Cozinha')}</h1>
    <p>Mesa ${escapeHtml(item.tableNumber ?? '—')} · ${escapeHtml(new Date(item.createdAt).toLocaleTimeString('pt-BR'))}</p>
    <p>Comanda de ${escapeHtml(item.waiterName || 'Equipe')}</p><ul><li><b>${escapeHtml(item.quantity)}×</b> ${escapeHtml(item.productName)}</li></ul>
    <script>window.onload=()=>window.print();</script></html>`);
  printWindow.document.close();
}

async function loadReport(filters = state.reportFilters) {
  state.reportFilters = { ...filters };
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
  state.report = await api.request(`/api/reports?${query.toString()}`);
  render();
}

function formatMoney(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value || 0));
}

function todayTotal() {
  const today = new Date().toDateString();
  return state.history.reduce((sum, order) => {
    return new Date(order.closedAt).toDateString() === today
      ? sum + Number(order.total || 0)
      : sum;
  }, 0);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function paidItemQuantity(order, itemId) {
  return (order.payments || [])
    .filter((payment) => payment.status !== 'reversed')
    .flatMap((payment) => payment.details?.items || [])
    .filter((allocation) => allocation.itemId === itemId)
    .reduce((sum, allocation) => sum + Number(allocation.quantity || 0), 0);
}

function renderLogin() {
  app.innerHTML = `
    <div class="auth-screen">
      <div class="login-card">
        <p class="eyebrow">OPERAÇÃO DO RESTAURANTE</p>
        <h1>Comanda</h1>
        <p class="login-copy">Entre para acompanhar mesas, pedidos e pagamentos.</p>
        <div class="form-grid">
          <label>
            Email
            <input id="email" type="email" autocomplete="username" placeholder="voce@restaurante.com" />
          </label>
          <label>
            Senha
            <input id="password" type="password" autocomplete="current-password" placeholder="Sua senha" />
          </label>
                  <button class="btn btn-primary" id="loginBtn">Entrar</button>
          <div id="loginError" class="notice" style="display:${state.loginError ? 'block' : 'none'}">${escapeHtml(state.loginError)}</div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('password').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') document.getElementById('loginBtn').click();
  });

  document.getElementById('loginBtn').addEventListener('click', async () => {
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const errorBox = document.getElementById('loginError');
    try {
      errorBox.style.display = 'none';
      state.loginError = '';
      await login(email, password);
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.style.display = 'block';
    }
  });
}

function renderDashboard() {
  if (state.view === 'settings' && !['admin', 'gerente'].includes(state.user?.role)) {
    state.view = 'operations';
  }
  const isAdmin = state.user?.role === 'admin';

  const nav = `
    <header>
      <div class="topbar">
        <h1>${escapeHtml(state.settings.restaurantName || 'Comanda')}</h1>
        <nav class="main-nav" aria-label="Navegação principal">
          <button class="btn btn-quiet ${state.view === 'operations' ? 'active' : ''}" data-view="operations">Salão</button>
          <button class="btn btn-quiet ${state.view === 'kitchen' ? 'active' : ''}" data-view="kitchen">Cozinha</button>
          <button class="btn btn-quiet ${state.view === 'bar' ? 'active' : ''}" data-view="bar">Bar</button>
          <button class="btn btn-quiet ${state.view === 'products' ? 'active' : ''}" data-view="products">Produtos</button>
          <button class="btn btn-quiet ${state.view === 'notices' ? 'active' : ''}" data-view="notices">Avisos${pendingNotices().length ? ` <span class="notice-count">${pendingNotices().length}</span>` : ''}</button>
          <button class="btn btn-quiet ${state.view === 'reports' ? 'active' : ''}" data-view="reports">Relatórios</button>
          ${['admin', 'gerente'].includes(state.user?.role) ? `<button class="btn btn-quiet ${state.view === 'settings' ? 'active' : ''}" data-view="settings">Configurações</button>` : ''}
        </nav>
        <div class="user-tools"><span class="user-pill">${escapeHtml(state.user?.name || 'Usuário')} · ${escapeHtml(state.user?.role || '')}</span><button class="btn btn-quiet" id="logoutBtn">Sair</button></div>
      </div>
    </header>
    <div id="noticeToastRoot"></div>
    ${state.loadError ? `<div class="app-load-error notice" role="alert"><span>Falha ao carregar os dados: ${escapeHtml(state.loadError)}</span><button class="btn btn-warning" id="retryAppLoadBtn">Tentar novamente</button></div>` : ''}
  `;

  if (state.view === 'kitchen' || state.view === 'bar') {
    const isBar = state.view === 'bar';
    const cards = state.productionItems.map((item) => `
      <article class="production-ticket status-${escapeHtml(item.status)}">
        <div class="production-ticket-heading">
          <strong>Mesa ${escapeHtml(item.tableNumber ?? '—')}</strong>
          <span>${new Date(item.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        <div class="production-item">
          <span class="production-quantity">${escapeHtml(item.quantity)}×</span>
          <strong>${escapeHtml(item.productName)}</strong>
        </div>
        <p class="production-meta">Comanda de ${escapeHtml(item.waiterName)}</p>
        <div class="production-ticket-footer">
          <span class="production-status">${item.status === 'ready' ? 'Pronto' : item.status === 'preparing' ? 'Em preparo' : 'Aguardando'}</span>
          <button class="btn btn-quiet" data-print-ticket="${escapeHtml(item.id)}" data-ticket-station="${isBar ? 'bar' : 'kitchen'}">Imprimir</button>
          ${item.status === 'pending' ? `<button class="btn btn-primary" data-production-status="${escapeHtml(item.id)}" data-next-status="preparing">Iniciar preparo</button>` : ''}
          ${item.status === 'preparing' ? `<button class="btn btn-secondary" data-production-status="${escapeHtml(item.id)}" data-next-status="ready">Marcar pronto</button>` : ''}
          ${item.status === 'ready' ? `<button class="btn btn-quiet production-back" data-production-status="${escapeHtml(item.id)}" data-next-status="preparing">Voltar ao preparo</button>` : ''}
        </div>
      </article>
    `).join('');

    app.innerHTML = `${nav}
      <main class="dashboard">
        <div class="section-heading">
          <div><p class="eyebrow">PEDIDOS PARA PRODUÇÃO</p><h2>${isBar ? 'Bar' : 'Cozinha'}</h2></div>
          <button class="btn btn-secondary" id="refreshProductionBtn">Atualizar fila</button>
        </div>
        ${state.productionError ? `<div class="notice">${escapeHtml(state.productionError)}</div>` : ''}
        <div class="production-grid">${cards || '<div class="empty-box">Nenhum pedido pendente nesta estação.</div>'}</div>
      </main>
    `;
    bindNavigation();
    document.getElementById('refreshProductionBtn').addEventListener('click', async () => {
      try {
        await loadProductionItems();
      } catch (error) {
        state.productionError = error.message;
        render();
      }
    });
    document.querySelectorAll('[data-production-status]').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          await updateProductionStatus(button.dataset.productionStatus, button.dataset.nextStatus);
        } catch (error) {
          alert(error.message);
        }
      });
    });
    document.querySelectorAll('[data-print-ticket]').forEach((button) => {
      button.addEventListener('click', () => {
        const item = state.productionItems.find((entry) => entry.id === button.dataset.printTicket);
        if (item) printProductionTicket({ ...item, station: button.dataset.ticketStation });
      });
    });
    if (productionRefreshTimer) clearInterval(productionRefreshTimer);
    productionRefreshTimer = setInterval(async () => {
      try {
        const station = state.view === 'bar' ? 'bar' : 'kitchen';
        state.productionItems = await api.request(`/api/production?station=${station}`);
        state.productionError = '';
        render();
      } catch (error) {
        state.productionError = `Falha ao atualizar a fila: ${error.message}`;
        render();
      }
    }, 15000);
    bindLogout();
    return;
  }

  if (productionRefreshTimer) {
    clearInterval(productionRefreshTimer);
    productionRefreshTimer = null;
  }

  if (state.view === 'products') {
    const products = state.products.filter((product) => product.active !== false);
    app.innerHTML = `${nav}
      <main class="dashboard">
        <div class="section-heading">
          <div><p class="eyebrow">CATÁLOGO</p><h2>Produtos</h2></div>
          <span class="muted-copy">${products.length} produto(s)</span>
        </div>
        <label class="catalog-search">Pesquisar produtos
          <input id="catalogSearch" type="search" placeholder="Nome ou categoria" autocomplete="off" />
        </label>
        <div class="catalog-grid" id="catalogGrid">
          ${products.map((product) => `
            <article class="order-panel catalog-product" data-catalog-product data-search="${escapeHtml(`${product.name} ${product.category}`.toLowerCase())}">
              <div class="product-meta"><strong>${escapeHtml(product.name)}</strong><span>${escapeHtml(product.category)}</span></div>
              <strong class="amount">${formatMoney(product.price)}</strong>
            </article>
          `).join('') || '<div class="empty-box">Nenhum produto cadastrado.</div>'}
        </div>
      </main>
    `;
    bindNavigation();
    document.getElementById('catalogSearch').addEventListener('input', (event) => {
      const query = event.currentTarget.value.trim().toLocaleLowerCase('pt-BR');
      document.querySelectorAll('[data-catalog-product]').forEach((card) => {
        card.hidden = !card.dataset.search.includes(query);
      });
    });
    bindLogout();
    return;
  }

  if (state.view === 'reports') {
    const filters = state.reportFilters || {
      from: new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      to: new Date().toISOString().slice(0, 10),
      waiterId: '',
      paymentMethod: ''
    };
    const report = state.report;
    app.innerHTML = `${nav}
      <main class="dashboard">
        <div class="section-heading"><div><p class="eyebrow">VENDAS ENCERRADAS</p><h2>Relatórios</h2></div></div>
        <section class="order-panel">
          <form id="reportFilterForm" class="settings-form report-filters">
            <label>De<input name="from" type="date" required value="${escapeHtml(filters.from)}" /></label>
            <label>Até<input name="to" type="date" required value="${escapeHtml(filters.to)}" /></label>
            <label>Garçom
              <select name="waiterId"><option value="">Todos</option><option value="__none__" ${filters.waiterId === '__none__' ? 'selected' : ''}>Sem garçom</option>
                ${state.reportOptions.map((user) => `<option value="${escapeHtml(user.id)}" ${filters.waiterId === user.id ? 'selected' : ''}>${escapeHtml(user.name)}</option>`).join('')}
              </select>
            </label>
            <label>Pagamento
              <select name="paymentMethod">
                <option value="">Todos</option>
                <option value="dinheiro" ${filters.paymentMethod === 'dinheiro' ? 'selected' : ''}>Dinheiro</option>
                <option value="pix" ${filters.paymentMethod === 'pix' ? 'selected' : ''}>PIX</option>
                <option value="debito" ${filters.paymentMethod === 'debito' ? 'selected' : ''}>Débito</option>
                <option value="credito" ${filters.paymentMethod === 'credito' ? 'selected' : ''}>Crédito</option>
              </select>
            </label>
            <button class="btn btn-primary" type="submit">Filtrar</button>
          </form>
        </section>
        ${report ? `
          <div class="metrics report-metrics">
            <div class="metric"><div class="label">Comandas</div><div class="value">${report.summary.orderCount}</div></div>
            <div class="metric"><div class="label">Vendas</div><div class="value">${formatMoney(report.summary.total)}</div></div>
            <div class="metric"><div class="label">Ticket médio</div><div class="value">${formatMoney(report.summary.averageTicket)}</div></div>
          </div>
          <section class="dashboard-grid report-groups">
            <div class="order-panel"><h3>Vendas por garçom</h3>${report.byWaiter.map((row) => `<div class="history-item"><strong>${escapeHtml(row.waiterName)}</strong><div>${row.orderCount} comandas · ${formatMoney(row.total)}</div></div>`).join('') || '<div class="empty-box">Sem vendas no período.</div>'}</div>
            <div class="order-panel"><h3>Pagamentos</h3>${report.byPaymentMethod.map((row) => `<div class="history-item"><strong>${escapeHtml(row.method)}</strong><div>${formatMoney(row.total)}</div></div>`).join('') || '<div class="empty-box">Sem pagamentos.</div>'}</div>
          </section>
          <section class="order-panel history-panel"><h3>Comandas (${report.orders.length})</h3>
            <div class="history-list">${report.orders.map((order) => `
              <div class="history-item">
                <strong>Mesa ${escapeHtml(order.tableNumber ?? '—')}</strong>
                <div>${formatMoney(order.total)} · ${escapeHtml(order.waiterName || 'Sem garçom')} · ${new Date(order.closedAt).toLocaleString('pt-BR')}
                  <button class="btn btn-secondary" type="button" data-print-order="${escapeHtml(order.id)}">Imprimir recibo</button>
                </div>
              </div>`).join('') || '<div class="empty-box">Nenhuma comanda no período.</div>'}
            </div>
          </section>
        ` : '<div class="empty-box">Informe os filtros e gere o relatório.</div>'}
      </main>
    `;
    bindNavigation();
    document.getElementById('reportFilterForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      try {
        state.report = null;
        await loadReport(values);
      } catch (error) {
        alert(error.message);
      }
    });
    document.querySelectorAll('[data-print-order]').forEach((button) => {
      button.addEventListener('click', () => {
        const order = report?.orders.find((item) => item.id === button.dataset.printOrder);
        if (order) printReceipt(order);
      });
    });
    bindLogout();
    return;
  }

  if (state.view === 'notices') {
    app.innerHTML = `${nav}
      <main class="dashboard">
        <div class="section-heading">
          <div><p class="eyebrow">COMUNICAÇÃO DA EQUIPE</p><h2>Avisos</h2></div>
          <button class="btn btn-primary" type="button" data-open-notice-composer>Avisar alguém</button>
        </div>
        <section class="order-panel notice-alert-settings">
          <h3>Alertas neste dispositivo</h3>
          <div class="notice-alert-controls">
            <label class="inline-check"><input type="checkbox" id="noticeSoundToggle" ${noticeAlertPreference('sound') ? 'checked' : ''} /> Som</label>
            <label class="inline-check"><input type="checkbox" id="noticeVibrateToggle" ${noticeAlertPreference('vibrate') ? 'checked' : ''} /> Vibração</label>
            <button class="btn btn-secondary" id="testNoticeAlert" type="button">Testar alerta</button>
            <span class="muted-copy">Alertas repetidos a cada 30 segundos, até 3 vezes, enquanto houver avisos pendentes.</span>
          </div>
        </section>
        <section class="order-panel history-panel">
          <div class="section-heading notice-list-heading">
            <h3>Recebidos</h3>
            <button class="btn btn-secondary" id="markAllNoticesRead" type="button" ${pendingNotices().length ? '' : 'disabled'}>Marcar todos como lidos</button>
          </div>
          <div id="noticeListRoot">${renderNoticeList()}</div>
        </section>
      </main>
      ${renderNoticeComposer()}
    `;
    bindNavigation();
    bindNoticeComposer();
    bindNoticeListActions();
    document.getElementById('markAllNoticesRead').addEventListener('click', async () => {
      try { await markAllNoticesRead(); } catch (error) { alert(error.message); }
    });
    document.getElementById('noticeSoundToggle').addEventListener('change', (event) => {
      localStorage.setItem('comanda_notice_sound', String(event.currentTarget.checked));
      if (event.currentTarget.checked) playNoticeAlert();
    });
    document.getElementById('noticeVibrateToggle').addEventListener('change', (event) => {
      localStorage.setItem('comanda_notice_vibrate', String(event.currentTarget.checked));
      if (event.currentTarget.checked && typeof navigator.vibrate === 'function') navigator.vibrate([100]);
    });
    document.getElementById('testNoticeAlert').addEventListener('click', () => {
      unlockNoticeAudio();
      playNoticeAlert();
      if (noticeAlertPreference('vibrate') && typeof navigator.vibrate !== 'function') {
        alert('O navegador ou dispositivo não oferece suporte à vibração.');
      }
    });
    bindLogout();
    return;
  }

  if (state.view === 'settings') {
    app.innerHTML = `${nav}
      <main class="dashboard settings-page">
        <div class="section-heading"><div><p class="eyebrow">ADMINISTRAÇÃO</p><h2>Configurações + backup</h2></div></div>
        <section class="order-panel">
          <h3>Identificação do restaurante</h3>
          <form id="settingsForm" class="settings-form">
            <label>Nome exibido no sistema
              <input id="restaurantName" maxlength="120" required value="${escapeHtml(state.settings.restaurantName || '')}" />
            </label>
            <label>Mesas ativas
              <input id="tableCount" type="number" min="1" max="80" step="1" required value="${escapeHtml(state.settings.tableCount || state.tables.length)}" />
            </label>
            <label class="inline-check"><input id="allowDiscount" type="checkbox" ${state.settings.allowDiscount !== false ? 'checked' : ''} /> Permitir descontos</label>
            <label class="inline-check"><input id="requireWaiter" type="checkbox" ${state.settings.requireWaiter !== false ? 'checked' : ''} /> Exigir garçom identificado</label>
            <label>Taxa de serviço (%)
              <input id="serviceFeePercent" type="number" min="0" max="100" step="0.5" required value="${escapeHtml(state.settings.serviceFeePercent ?? 10)}" />
            </label>
            <label class="inline-check"><input id="serviceFeeDefault" type="checkbox" ${state.settings.serviceFeeDefault === true ? 'checked' : ''} /> Aplicar taxa por padrão em novas comandas</label>
            ${isAdmin ? `<label>Limite de desconto sem autorização (%)
              <input id="discountLimit" type="number" min="0" max="100" step="0.5" required value="${escapeHtml(state.settings.discountLimit ?? 10)}" />
            </label>` : ''}
            <button class="btn btn-primary" type="submit">Salvar configurações</button>
            <span id="settingsMessage" role="status"></span>
          </form>
        </section>
        <section class="order-panel settings-panel">
          <h3>Integração de maquininhas</h3>
          <p class="muted-copy">Cadastre os terminais e selecione o modo de integração: registro manual, provedor por API/SDK ou serviço local TEF.</p>
          <div class="notice terminal-integration-note" role="note">Esta tela salva as configurações do terminal, mas ainda não inicia cobranças. Os provedores API/SDK exigem integração e credenciais próprias; não informe chaves secretas aqui.</div>
          <p class="form-success" id="cardTerminalMessage" role="status">${escapeHtml(state.cardTerminalMessage)}</p>
          <div class="card-terminal-list">
            ${(state.settings.cardTerminals || []).map((terminal) => `
              <form class="card-terminal-form" data-card-terminal-form>
                <input type="hidden" name="id" value="${escapeHtml(terminal.id)}" />
                <label>Nome do terminal<input name="name" maxlength="120" required value="${escapeHtml(terminal.name)}" /></label>
                <label>Modo de integração
                  <select class="card-terminal-mode" name="mode">
                    <option value="manual" ${terminal.mode === 'manual' ? 'selected' : ''}>Cadastro manual</option>
                    <option value="provider" ${terminal.mode === 'provider' ? 'selected' : ''}>API/SDK do provedor</option>
                    <option value="tef" ${terminal.mode === 'tef' ? 'selected' : ''}>TEF local / bridge</option>
                  </select>
                </label>
                <label data-provider-field>Provedor
                  <select name="provider">
                    <option value="stone" ${terminal.provider === 'stone' ? 'selected' : ''}>Stone</option>
                    <option value="cielo" ${terminal.provider === 'cielo' ? 'selected' : ''}>Cielo</option>
                    <option value="pagbank" ${terminal.provider === 'pagbank' ? 'selected' : ''}>PagBank</option>
                    <option value="mercado_pago" ${terminal.provider === 'mercado_pago' ? 'selected' : ''}>Mercado Pago</option>
                    <option value="rede_getnet" ${terminal.provider === 'rede_getnet' ? 'selected' : ''}>Rede/Getnet</option>
                  </select>
                </label>
                <label>Modelo<input name="model" maxlength="80" value="${escapeHtml(terminal.model || '')}" /></label>
                <label>Identificador do terminal<input name="terminalId" maxlength="120" value="${escapeHtml(terminal.terminalId || '')}" /></label>
                <label data-bridge-field>Endereço do serviço TEF<input name="bridgeUrl" type="url" maxlength="500" placeholder="http://127.0.0.1:..." value="${escapeHtml(terminal.bridgeUrl || '')}" /></label>
                <label class="inline-check"><input name="active" type="checkbox" ${terminal.active ? 'checked' : ''} /> Ativo</label>
                <div class="card-terminal-actions">
                  <button class="btn btn-secondary" type="submit">Salvar terminal</button>
                  <button class="btn btn-danger" type="button" data-delete-card-terminal="${escapeHtml(terminal.id)}">Remover</button>
                </div>
                <p class="muted-copy">Estado: configuração salva; transações externas ainda não habilitadas.</p>
              </form>
            `).join('') || '<div class="empty-box">Nenhum terminal cadastrado.</div>'}
          </div>
          <form id="newCardTerminalForm" class="card-terminal-form">
            <h4>Adicionar terminal</h4>
            <label>Nome do terminal<input name="name" maxlength="120" required placeholder="Ex.: Caixa principal" /></label>
            <label>Modo de integração
              <select class="card-terminal-mode" name="mode">
                <option value="manual">Cadastro manual</option>
                <option value="provider">API/SDK do provedor</option>
                <option value="tef">TEF local / bridge</option>
              </select>
            </label>
            <label data-provider-field>Provedor
              <select name="provider">
                <option value="stone">Stone</option>
                <option value="cielo">Cielo</option>
                <option value="pagbank">PagBank</option>
                <option value="mercado_pago">Mercado Pago</option>
                <option value="rede_getnet">Rede/Getnet</option>
              </select>
            </label>
            <label>Modelo<input name="model" maxlength="80" /></label>
            <label>Identificador do terminal<input name="terminalId" maxlength="120" /></label>
            <label data-bridge-field>Endereço do serviço TEF<input name="bridgeUrl" type="url" maxlength="500" placeholder="http://127.0.0.1:..." /></label>
            <button class="btn btn-primary" type="submit">Adicionar terminal</button>
          </form>
        </section>
        <section class="order-panel settings-panel">
          <h3>Destino de produção dos produtos</h3>
          <p class="muted-copy">Cada novo item será encaminhado à estação selecionada.</p>
          <div class="settings-product-list">
            ${state.products.map((product) => `
              <label class="settings-product">
                <span><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.category)}</small></span>
                <select data-product-station="${escapeHtml(product.id)}">
                  <option value="kitchen" ${product.productionStation === 'kitchen' ? 'selected' : ''}>Cozinha</option>
                  <option value="bar" ${product.productionStation === 'bar' ? 'selected' : ''}>Bar</option>
                </select>
              </label>
            `).join('') || '<div class="empty-box">Nenhum produto ativo cadastrado.</div>'}
          </div>
        </section>
        <section class="order-panel settings-panel">
          <h3>Catálogo de produtos</h3>
          <p class="muted-copy">Cadastre, edite e desative produtos. Produtos desativados permanecem no histórico das comandas.</p>
          <form id="newProductForm" class="settings-form">
            <label>Nome<input name="name" maxlength="180" required /></label>
            <label>Categoria<input name="category" maxlength="80" required /></label>
            <label>Preço<input name="price" type="number" min="0" step="0.01" required /></label>
            <label>Produção<select name="productionStation"><option value="kitchen">Cozinha</option><option value="bar">Bar</option></select></label>
            <button class="btn btn-primary" type="submit">Cadastrar produto</button>
          </form>
          <div class="settings-product-list">
            ${state.products.map((product) => `
              <form class="settings-product product-admin-row" data-product-form="${escapeHtml(product.id)}">
                <input name="name" aria-label="Nome de ${escapeHtml(product.name)}" maxlength="180" required value="${escapeHtml(product.name)}" />
                <input name="category" aria-label="Categoria de ${escapeHtml(product.name)}" maxlength="80" required value="${escapeHtml(product.category)}" />
                <input name="price" aria-label="Preço de ${escapeHtml(product.name)}" type="number" min="0" step="0.01" required value="${escapeHtml(product.price)}" />
                <select name="productionStation" aria-label="Produção de ${escapeHtml(product.name)}">
                  <option value="kitchen" ${product.productionStation === 'kitchen' ? 'selected' : ''}>Cozinha</option>
                  <option value="bar" ${product.productionStation === 'bar' ? 'selected' : ''}>Bar</option>
                </select>
                <label class="inline-check"><input name="active" type="checkbox" ${product.active !== false ? 'checked' : ''} /> Ativo</label>
                <button class="btn btn-secondary" type="submit">Salvar</button>
                <button class="btn btn-danger" type="button" data-delete-product="${escapeHtml(product.id)}">Desativar</button>
              </form>
            `).join('') || '<div class="empty-box">Nenhum produto cadastrado.</div>'}
          </div>
        </section>
        ${isAdmin ? `<section class="order-panel settings-panel">
          <h3>Equipe e contas de acesso</h3>
          <p class="muted-copy">As contas usam email e senha. PINs numéricos são armazenados somente como hash e usados para confirmar a abertura de comandas e autorizar descontos.</p>
          <form id="newUserForm" class="settings-form">
            <label>Nome<input name="name" maxlength="120" required /></label>
            <label>Email<input name="email" type="email" maxlength="160" required /></label>
            <label>Senha inicial<input name="password" type="password" minlength="8" autocomplete="new-password" required /></label>
            <label>PIN (opcional)<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{1,6}" maxlength="6" autocomplete="new-password" /></label>
            <label>Perfil<select name="role"><option value="operador">Operador</option><option value="gerente">Gerente</option><option value="admin">Administrador</option></select></label>
            <button class="btn btn-primary" type="submit">Criar conta</button>
          </form>
          <div class="settings-product-list">
            ${state.users.map((user) => `
              <form class="settings-product user-admin-row" data-user-form="${escapeHtml(user.id)}">
                ${user.legacyImported ? '<span class="muted-copy">Perfil legado inativo — defina email e senha para habilitar</span>' : ''}
                <input name="name" aria-label="Nome de ${escapeHtml(user.name)}" maxlength="120" required value="${escapeHtml(user.name)}" />
                <input name="email" aria-label="Email de ${escapeHtml(user.name)}" type="email" maxlength="160" required value="${escapeHtml(user.email)}" />
                <input name="password" aria-label="Nova senha para ${escapeHtml(user.name)}" type="password" minlength="8" placeholder="Manter senha atual" autocomplete="new-password" />
                <input name="pin" aria-label="Novo PIN para ${escapeHtml(user.name)}" type="password" inputmode="numeric" pattern="[0-9]{1,6}" maxlength="6" placeholder="${user.pinRequired ? 'Manter PIN atual' : 'PIN opcional'}" autocomplete="new-password" />
                <select name="role" aria-label="Perfil de ${escapeHtml(user.name)}">
                  <option value="operador" ${user.role === 'operador' ? 'selected' : ''}>Operador</option>
                  <option value="gerente" ${user.role === 'gerente' ? 'selected' : ''}>Gerente</option>
                  <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Administrador</option>
                </select>
                <label class="inline-check"><input name="active" type="checkbox" ${user.active !== false ? 'checked' : ''} /> Ativo</label>
                ${user.pinRequired ? '<label class="inline-check"><input name="clearPin" type="checkbox" /> Remover PIN</label>' : ''}
                <button class="btn btn-secondary" type="submit">Salvar conta</button>
              </form>
            `).join('')}
          </div>
        </section>` : ''}
        ${isAdmin ? `<section class="order-panel settings-panel">
          <h3>Trilha de auditoria</h3>
          <div class="history-list">
            ${state.audit.length ? state.audit.map((event) => `
              <div class="history-item">
                <strong>${escapeHtml(event.action)}</strong>
                <div>${escapeHtml(event.actorName || 'Equipe')} · ${new Date(event.createdAt).toLocaleString('pt-BR')}<br>${escapeHtml(JSON.stringify(event.detail || {}))}</div>
              </div>
            `).join('') : '<div class="empty-box">Nenhuma ação sensível registrada.</div>'}
          </div>
        </section>
        <section class="order-panel settings-panel">
          <h3>Backup dos dados</h3>
          <p class="muted-copy">Baixe uma cópia dos dados cadastrados em formato JSON. O arquivo inclui hashes de senha e PIN; guarde-o em local seguro.</p>
          <button class="btn btn-primary" id="downloadBackupBtn">Baixar backup</button>
          <span id="backupMessage" role="status"></span>
        </section>
        <section class="order-panel settings-panel">
          <h3>Migrar dados do sistema inicial</h3>
          <p class="muted-copy">Importe o JSON exportado em Configurações → Exportar backup no sistema inicial. Os registros atuais serão preservados; mesas e produtos equivalentes serão reutilizados. PINs e endereços de maquininhas não são importados.</p>
          ${state.settings.legacyMigration ? `<p class="muted-copy">Dados migrados anteriormente: ${state.settings.legacyMigration.waiters?.length || 0} perfis de equipe, ${state.settings.legacyMigration.terminals?.length || 0} configurações de maquininha arquivadas, ${state.settings.legacyMigration.notices?.imported || 0} avisos ativos e ${state.settings.legacyMigration.audit?.length || 0} registros de auditoria arquivados. O backup administrativo contém o arquivo legado sanitizado para consulta.</p>` : ''}
          <label>Backup JSON do sistema inicial
            <input id="legacyBackupFile" type="file" accept="application/json,.json" />
          </label>
          <button class="btn btn-secondary" id="importLegacyBackupBtn" type="button">Importar dados</button>
          <span id="migrationMessage" role="status"></span>
        </section>` : ''}
      </main>
    `;
    bindNavigation();
    document.getElementById('settingsForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const values = {
          allowDiscount: document.getElementById('allowDiscount').checked,
          requireWaiter: document.getElementById('requireWaiter').checked,
          serviceFeePercent: Number(document.getElementById('serviceFeePercent').value),
          serviceFeeDefault: document.getElementById('serviceFeeDefault').checked
        };
        const discountLimit = document.getElementById('discountLimit');
        if (discountLimit) values.discountLimit = Number(discountLimit.value);
        await saveRestaurantName(
          document.getElementById('restaurantName').value,
          document.getElementById('tableCount').value,
          values
        );
      } catch (error) {
        const message = document.getElementById('settingsMessage');
        message.textContent = error.message;
        message.className = 'form-error';
      }
    });
    const syncCardTerminalMode = (form) => {
      const mode = form.querySelector('[name="mode"]').value;
      form.querySelector('[data-provider-field]').hidden = mode !== 'provider';
      form.querySelector('[data-bridge-field]').hidden = mode !== 'tef';
    };
    document.querySelectorAll('.card-terminal-form').forEach((form) => {
      syncCardTerminalMode(form);
      form.querySelector('[name="mode"]').addEventListener('change', () => syncCardTerminalMode(form));
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const fields = new FormData(form);
        const terminal = {
          id: String(fields.get('id') || crypto.randomUUID()),
          name: String(fields.get('name') || '').trim(),
          mode: String(fields.get('mode') || ''),
          provider: String(fields.get('provider') || ''),
          model: String(fields.get('model') || '').trim(),
          terminalId: String(fields.get('terminalId') || '').trim(),
          bridgeUrl: String(fields.get('bridgeUrl') || '').trim(),
          active: form.id === 'newCardTerminalForm' || fields.has('active')
        };
        const terminals = (state.settings.cardTerminals || []).filter((entry) => entry.id !== terminal.id);
        try {
          await saveCardTerminals([...terminals, terminal]);
        } catch (error) {
          const message = document.getElementById('cardTerminalMessage');
          message.textContent = error.message;
          message.className = 'form-error';
        }
      });
    });
    document.querySelectorAll('[data-delete-card-terminal]').forEach((button) => {
      button.addEventListener('click', async () => {
        if (!window.confirm('Remover esta configuração de terminal?')) return;
        try {
          const terminals = (state.settings.cardTerminals || []).filter((entry) => entry.id !== button.dataset.deleteCardTerminal);
          await saveCardTerminals(terminals);
        } catch (error) {
          const message = document.getElementById('cardTerminalMessage');
          message.textContent = error.message;
          message.className = 'form-error';
        }
      });
    });
    document.querySelectorAll('[data-product-station]').forEach((select) => {
      select.addEventListener('change', async () => {
        try {
          await setProductStation(select.dataset.productStation, select.value);
        } catch (error) {
          alert(error.message);
        }
      });
    });
    document.getElementById('newProductForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      values.price = Number(values.price);
      values.active = true;
      try {
        await saveProduct(null, values);
      } catch (error) {
        alert(error.message);
      }
    });
    document.querySelectorAll('[data-product-form]').forEach((form) => {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const fields = new FormData(form);
        const values = Object.fromEntries(fields);
        values.price = Number(values.price);
        values.active = fields.has('active');
        try {
          await saveProduct(form.dataset.productForm, values);
        } catch (error) {
          alert(error.message);
        }
      });
    });
    document.querySelectorAll('[data-delete-product]').forEach((button) => {
      button.addEventListener('click', async () => {
        if (!window.confirm('Desativar este produto? Ele será removido do catálogo de venda, mas continuará no histórico.')) return;
        try {
          await api.request(`/api/products/${button.dataset.deleteProduct}`, { method: 'DELETE' });
          await loadAppData();
        } catch (error) {
          alert(error.message);
        }
      });
    });
    if (isAdmin) {
      document.getElementById('newUserForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(event.currentTarget));
        if (!values.pin) values.pin = '';
        try {
          await saveUser(null, { ...values, active: true });
        } catch (error) {
          alert(error.message);
        }
      });
      document.querySelectorAll('[data-user-form]').forEach((form) => {
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const fields = new FormData(form);
          const values = Object.fromEntries(fields);
          values.active = fields.has('active');
          if (!values.password) delete values.password;
          if (fields.has('clearPin')) values.pin = '';
          else if (!values.pin) delete values.pin;
          delete values.clearPin;
          try {
            await saveUser(form.dataset.userForm, values);
          } catch (error) {
            alert(error.message);
          }
        });
      });
      document.getElementById('downloadBackupBtn').addEventListener('click', async () => {
        const message = document.getElementById('backupMessage');
        try {
          message.textContent = '';
          await downloadBackup();
          message.textContent = 'Backup baixado.';
          message.className = 'form-success';
        } catch (error) {
          message.textContent = error.message;
          message.className = 'form-error';
        }
      });
      document.getElementById('importLegacyBackupBtn').addEventListener('click', async () => {
        const fileInput = document.getElementById('legacyBackupFile');
        const message = document.getElementById('migrationMessage');
        const file = fileInput.files?.[0];
        if (!file) {
          message.textContent = 'Selecione o arquivo JSON de backup.';
          message.className = 'form-error';
          return;
        }
        if (!window.confirm('Importar este backup? Os dados atuais serão mantidos; as comandas presentes no arquivo serão acrescentadas.')) return;
        try {
          message.textContent = 'Importando e verificando os dados…';
          message.className = '';
          const result = await importLegacyBackup(file);
          message.textContent = result.alreadyImported
            ? 'Este arquivo já havia sido importado.'
            : `Importação concluída: ${result.importedOrders} comandas, ${result.importedItems} itens, ${result.importedPayments} pagamentos e ${result.importedNotices} avisos; ${result.importedStaffProfiles} perfis de equipe foram criados desativados; ${result.skippedOrders} comandas e ${result.skippedNotices} avisos sem destinatário migrável foram ignorados.`;
          message.className = 'form-success';
        } catch (error) {
          message.textContent = error.message;
          message.className = 'form-error';
        }
      });
    }
    bindLogout();
    return;
  }

  const tableCards = state.tables.map((table) => {
    const isOpen = table.openOrderId;
    return `
      <div class="table-card ${isOpen ? 'occupied' : 'free'}">
        <div class="header">
          <span class="table-number">Mesa ${table.number}</span>
          <span class="table-status">${isOpen ? 'ocupada' : 'livre'}</span>
        </div>
        <div>
          <strong>${isOpen ? 'Comanda aberta' : 'Pronta para abrir'}</strong>
          <div>${isOpen ? formatMoney(table.openOrderTotal) : 'Sem pedido'}</div>
        </div>
        <div class="row">
          <button class="btn ${isOpen ? 'btn-secondary' : 'btn-primary'}" data-open-table="${escapeHtml(table.id)}">${isOpen ? 'Ver comanda' : 'Abrir mesa'}</button>
        </div>
      </div>
    `;
  }).join('');

  app.innerHTML = `${nav}
    <div class="dashboard">
      <div class="metrics">
        <div class="metric">
          <div class="label">Mesas</div>
          <div class="value">${state.tables.length}</div>
        </div>
        <div class="metric">
          <div class="label">Em aberto</div>
          <div class="value">${state.tables.filter((t) => t.openOrderId).length}</div>
        </div>
        <div class="metric">
          <div class="label">Hoje</div>
          <div class="value">${formatMoney(todayTotal())}</div>
        </div>
      </div>

      <section class="order-panel">
        <h3>Mesas</h3>
        <div class="table-grid">${tableCards}</div>
      </section>

      <section class="order-panel history-panel">
        <h3>Histórico</h3>
        <div class="history-list">
          ${state.history.length ? state.history.map((order) => `
            <div class="history-item">
              <strong>Mesa ${order.tableNumber || order.tableId}</strong>
              <div>${formatMoney(order.total)} · ${escapeHtml(order.waiterName || 'Sem garçom')} · ${new Date(order.closedAt).toLocaleString('pt-BR')}</div>
            </div>
          `).join('') : '<div class="empty-box">Sem comandas fechadas.</div>'}
        </div>
      </section>
    </div>
    ${state.orderModalOpen && state.activeOrderId ? `
      <div class="order-modal-backdrop" data-order-modal-backdrop>
        <section class="order-modal" role="dialog" aria-modal="true" aria-labelledby="orderModalTitle">
          <div class="order-modal-heading">
            <div><p class="eyebrow">ATENDIMENTO</p><h2 id="orderModalTitle">Comanda · Mesa ${escapeHtml(state.activeOrder?.tableNumber ?? '')}</h2></div>
            <div class="order-modal-actions">
              <button class="btn btn-warning" type="button" data-open-notice-composer data-table-id="${escapeHtml(state.activeOrder?.tableId || '')}">Avisar equipe</button>
              <button class="btn btn-quiet order-modal-close" type="button" data-close-order-modal aria-label="Fechar janela da comanda">×</button>
            </div>
          </div>
          <label class="catalog-search">Adicionar produtos
            <input id="orderProductSearch" type="search" placeholder="Pesquisar por nome ou categoria" autocomplete="off" />
          </label>
          <div class="order-product-grid" id="orderProductGrid">
            ${state.products.filter((product) => product.active !== false).map((product) => `
              <article class="order-panel order-product-card" data-order-product data-search="${escapeHtml(`${product.name} ${product.category}`.toLocaleLowerCase('pt-BR'))}">
                <div class="product-meta"><strong>${escapeHtml(product.name)}</strong><span>${escapeHtml(product.category)}</span></div>
                <strong class="amount">${formatMoney(product.price)}</strong>
                <button class="btn btn-secondary" type="button" data-product-add="${escapeHtml(product.id)}">Adicionar</button>
              </article>
            `).join('') || '<div class="empty-box">Nenhum produto ativo cadastrado.</div>'}
          </div>
          <section class="order-panel active-order-panel">
            <h3>Itens e pagamento</h3>
            <div id="orderContainer">${renderActiveOrderSection()}</div>
          </section>
        </section>
      </div>
    ` : ''}
    ${renderNoticeComposer()}
  `;
  bindNavigation();
  bindNoticeComposer();
  const orderModal = document.querySelector('.order-modal');
  orderModal?.querySelector('input')?.focus();
  orderModal?.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    state.orderModalOpen = false;
    render();
  });
  document.querySelector('[data-close-order-modal]')?.addEventListener('click', () => {
    state.orderModalOpen = false;
    render();
  });
  document.querySelector('[data-order-modal-backdrop]')?.addEventListener('click', (event) => {
    if (event.target !== event.currentTarget) return;
    state.orderModalOpen = false;
    render();
  });
  document.getElementById('orderProductSearch')?.addEventListener('input', (event) => {
    const query = event.currentTarget.value.trim().toLocaleLowerCase('pt-BR');
    document.querySelectorAll('[data-order-product]').forEach((card) => {
      card.hidden = !card.dataset.search.includes(query);
    });
  });
  document.querySelectorAll('[data-product-add]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await addItemToOrder(button.dataset.productAdd, 1);
      } catch (error) {
        alert(error.message);
      }
    });
  });

  document.querySelectorAll('[data-open-table]').forEach((button) => {
    button.addEventListener('click', async () => {
      const tableId = button.getAttribute('data-open-table');
      const table = state.tables.find((t) => t.id === tableId);
      if (!table) return;

      if (table.openOrderId) {
        state.activeOrderId = table.openOrderId;
        state.orderModalOpen = true;
        await loadAppData();
        return;
      }

      let pin = '';
      if (state.user.pinRequired) {
        pin = window.prompt('Informe seu PIN para abrir a comanda.');
        if (pin === null) return;
      }
      state.orderModalOpen = true;
      await createOrder(tableId, state.user.name, pin);
    });
  });

  const payButton = document.getElementById('payButton');
  if (payButton) {
    payButton.addEventListener('click', async () => {
      const method = document.getElementById('payMethod').value;
      const amount = Number(document.getElementById('payAmount').value || 0);
      const received = document.getElementById('payReceived')?.value;
      try {
        await payOrder(method, amount, received || null);
        if (state.activeOrder && state.activeOrder.paidTotal >= state.activeOrder.total) {
          await closeOrder();
        }
      } catch (error) {
        alert(error.message);
      }
    });
  }

  document.getElementById('closeOrderBtn')?.addEventListener('click', async () => {
    try {
      await closeOrder();
    } catch (error) {
      alert(error.message);
    }
  });
  document.getElementById('applyDiscountBtn')?.addEventListener('click', async () => {
    const type = document.getElementById('discountType').value;
    const value = Number(document.getElementById('discountValue').value || 0);
    try {
      await applyDiscount(type, value);
    } catch (error) {
      alert(error.message);
    }
  });
  document.getElementById('serviceFeeToggle')?.addEventListener('change', async (event) => {
    try {
      await setServiceFee(event.currentTarget.checked);
    } catch (error) {
      alert(error.message);
    }
  });
  document.getElementById('printOrderBtn')?.addEventListener('click', () => printReceipt());
  document.getElementById('transferOrderBtn')?.addEventListener('click', async () => {
    const tableId = document.getElementById('transferTable').value;
    if (!tableId) return alert('Selecione uma mesa livre.');
    try {
      await transferOrder(tableId);
    } catch (error) {
      alert(error.message);
    }
  });
  document.getElementById('mergeOrderBtn')?.addEventListener('click', async () => {
    const sourceOrderId = document.getElementById('mergeTable').value;
    if (!sourceOrderId) return alert('Selecione uma comanda aberta.');
    if (!window.confirm('Juntar as duas comandas e liberar a mesa da comanda selecionada?')) return;
    try {
      await mergeOrders(sourceOrderId);
    } catch (error) {
      alert(error.message);
    }
  });
  document.getElementById('cancelOrderBtn')?.addEventListener('click', async () => {
    if (!window.confirm('Cancelar esta comanda? Pagamentos devem ser estornados antes.')) return;
    const reason = window.prompt('Informe o motivo do cancelamento:');
    if (reason === null) return;
    try {
      await cancelOrder(reason.trim());
    } catch (error) {
      alert(error.message);
    }
  });
  document.getElementById('splitPeopleBtn')?.addEventListener('click', async () => {
    try {
      await payNextPersonShare();
    } catch (error) {
      alert(error.message);
    }
  });
  document.getElementById('paySelectedItemsBtn')?.addEventListener('click', async () => {
    try {
      await paySelectedItems();
    } catch (error) {
      alert(error.message);
    }
  });
  document.querySelectorAll('[data-reverse-payment]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!window.confirm('Registrar estorno interno? Se houve cobrança externa, devolva o valor também na maquininha.')) return;
      const reason = window.prompt('Informe o motivo do estorno:');
      if (reason === null) return;
      try {
        await api.request(`/api/orders/${state.activeOrderId}/payments/${button.dataset.reversePayment}/reverse`, {
          method: 'POST', body: JSON.stringify({ reason })
        });
        await loadAppData();
      } catch (error) {
        alert(error.message);
      }
    });
  });

  document.querySelectorAll('[data-increase], [data-decrease]').forEach((button) => {
    button.addEventListener('click', async () => {
      const itemId = button.getAttribute('data-increase') || button.getAttribute('data-decrease');
      const currentQty = Number(button.parentElement.querySelector('span').textContent);
      const delta = button.hasAttribute('data-increase') ? 1 : -1;
      try {
        await updateItemQty(itemId, Math.max(1, currentQty + delta));
      } catch (error) {
        alert(error.message);
      }
    });
  });
  document.querySelectorAll('[data-remove-item]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await removeItem(button.getAttribute('data-remove-item'));
      } catch (error) {
        alert(error.message);
      }
    });
  });

  bindLogout();
}

function renderActiveOrderSection() {
  if (!state.activeOrderId) {
    return '<div class="empty-box">Abra uma mesa para começar a comanda.</div>';
  }

  const active = state.tables.find((table) => table.openOrderId === state.activeOrderId);
  if (!active) {
    return '<div class="empty-box">Comanda não encontrada.</div>';
  }

  const order = state.activeOrder;
  if (!order) return '<div class="empty-box">Carregando...</div>';

  return `
    <div class="row" style="margin-bottom:12px;">
      <strong>Mesa ${active.number}</strong>
      <button class="btn btn-danger" id="closeOrderBtn">Fechar comanda</button>
      <button class="btn btn-secondary" id="printOrderBtn">Imprimir recibo</button>
      <span class="order-state">EM ANDAMENTO</span>
    </div>
    <div class="order-management row">
      <label>Mover para mesa livre
        <select id="transferTable"><option value="">Selecione</option>${state.tables.filter((table) => !table.openOrderId && table.id !== active.id).map((table) => `<option value="${escapeHtml(table.id)}">Mesa ${escapeHtml(table.number)}</option>`).join('')}</select>
      </label>
      <button class="btn btn-secondary" id="transferOrderBtn" type="button">Mover</button>
      <label>Juntar com comanda de
        <select id="mergeTable"><option value="">Selecione</option>${state.tables.filter((table) => table.openOrderId && table.openOrderId !== order.id).map((table) => `<option value="${escapeHtml(table.openOrderId)}">Mesa ${escapeHtml(table.number)}</option>`).join('')}</select>
      </label>
      <button class="btn btn-secondary" id="mergeOrderBtn" type="button">Juntar</button>
      <button class="btn btn-danger" id="cancelOrderBtn" type="button">Cancelar comanda</button>
    </div>
    <div class="row" style="margin-bottom:16px;">
      <label>
        Tipo de desconto
        <select id="discountType">
          <option value="percent" ${order.discountType === 'percent' ? 'selected' : ''}>%</option>
          <option value="value" ${order.discountType !== 'percent' ? 'selected' : ''}>R$</option>
        </select>
      </label>
      <label>
        Valor
        <input id="discountValue" type="number" min="0" step="0.01" value="${escapeHtml(order.discountValue ?? order.discountAmount ?? 0)}" />
      </label>
      <button class="btn btn-warning" id="applyDiscountBtn">Aplicar</button>
    </div>
    <label class="inline-check service-fee-toggle">
      <input id="serviceFeeToggle" type="checkbox" ${order.serviceFeeEnabled ? 'checked' : ''} />
      Aplicar taxa de serviço (${escapeHtml(order.serviceFeePercent || state.settings.serviceFeePercent || 0)}%)
    </label>
    <div class="item-list">
      ${order.items.length ? order.items.map((item) => `
        <div class="order-item">
          <label class="inline-check pay-item-select"><input type="checkbox" data-pay-item value="${escapeHtml(item.id)}" ${paidItemQuantity(order, item.id) >= item.quantity ? 'disabled' : ''} /></label>
          <div>
            <strong>${escapeHtml(item.productName)}</strong>
            <small>${paidItemQuantity(order, item.id) ? `${paidItemQuantity(order, item.id)} já pago · ` : ''}${item.quantity} disponível(is)</small>
          </div>
          <input data-pay-quantity="${escapeHtml(item.id)}" aria-label="Quantidade a pagar de ${escapeHtml(item.productName)}" type="number" min="1" max="${Math.max(0, Number(item.quantity) - paidItemQuantity(order, item.id))}" value="${Math.max(1, Number(item.quantity) - paidItemQuantity(order, item.id))}" ${paidItemQuantity(order, item.id) >= item.quantity ? 'disabled' : ''} />
          <div class="qty-controls">
            <button data-decrease="${item.id}">-</button>
            <span>${item.quantity}</span>
            <button data-increase="${item.id}">+</button>
          </div>
          <div>${formatMoney(item.price * item.quantity)}</div>
          <button class="btn btn-danger" data-remove-item="${item.id}">Excluir</button>
        </div>
      `).join('') : '<div class="empty-box">Nenhum item ainda.</div>'}
    </div>
    <div class="summary-box">
      <div class="summary-row"><span>Subtotal</span><span>${formatMoney(order.subtotal)}</span></div>
      <div class="summary-row"><span>Desconto</span><span>- ${formatMoney(order.discountAmount)}</span></div>
      ${order.serviceFeeAmount > 0 ? `<div class="summary-row"><span>Taxa de serviço (${escapeHtml(order.serviceFeePercent || 0)}%)</span><span>+ ${formatMoney(order.serviceFeeAmount)}</span></div>` : ''}
      <div class="summary-row total"><span>Total</span><span>${formatMoney(order.total)}</span></div>
    </div>
    <div class="row" style="margin-top:16px;">
      <label>
        Método
        <select id="payMethod">
          <option value="dinheiro">Dinheiro</option>
          <option value="pix">PIX</option>
          <option value="debito">Débito</option>
          <option value="credito">Crédito</option>
        </select>
      </label>
      <label>
        Valor
        <input id="payAmount" type="number" min="0" step="0.01" value="${Math.max(0, order.total - order.paidTotal).toFixed(2)}" />
      </label>
      <label>
        Recebido
        <input id="payReceived" type="number" min="0" step="0.01" value="${Math.max(0, order.total - order.paidTotal).toFixed(2)}" />
      </label>
      <button class="btn btn-primary" id="payButton">Pagar</button>
    </div>
    <div class="row split-pay-controls">
      <label>Dividir igualmente entre
        <input id="splitPeopleCount" type="number" min="2" max="20" step="1" value="2" />
      </label>
      <button class="btn btn-secondary" id="splitPeopleBtn" type="button">Receber próxima parte</button>
      <button class="btn btn-secondary" id="paySelectedItemsBtn" type="button">Pagar itens selecionados</button>
    </div>
    ${(order.payments || []).length ? `<div class="order-panel payment-history"><h4>Pagamentos</h4>${order.payments.map((payment) => `
      <div class="history-item"><strong>${escapeHtml(payment.method)} · ${formatMoney(payment.amount)}${payment.status === 'reversed' ? ' · estornado' : ''}</strong>
        <div>${new Date(payment.createdAt).toLocaleString('pt-BR')}${payment.status !== 'reversed' && ['admin', 'gerente'].includes(state.user?.role) ? `<button class="btn btn-danger" data-reverse-payment="${escapeHtml(payment.id)}">Estornar</button>` : ''}</div>
      </div>
    `).join('')}</div>` : ''}
  `;

  return 'ok';
}

async function render() {
  if (!state.token) {
    if (productionRefreshTimer) clearInterval(productionRefreshTimer);
    productionRefreshTimer = null;
    renderLogin();
    return;
  }

  if (!state.user) {
    try {
      await loadAppData();
    } catch (error) {
      renderLogin();
      return;
    }
  }

  startNoticePolling();
  renderDashboard();
}

async function bootstrap() {
  if (state.token) {
    try {
      await loadAppData();
    } catch (error) {
      renderLogin();
    }
  } else {
    renderLogin();
  }
}

bootstrap();

document.addEventListener('click', unlockNoticeAudio, { once: true });
