const app = document.getElementById('app');

const state = {
  user: null,
  token: localStorage.getItem('comanda_token') || '',
  tables: [],
  products: [],
  activeOrderId: null,
  activeOrder: null,
  history: [],
  notices: [],
  settings: { restaurantName: 'Comanda' },
  productionItems: [],
  productionError: '',
  view: 'operations'
};

let productionRefreshTimer;

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
      throw new Error(data.error || 'Erro inesperado');
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
  try {
    const [me, tables, products, history, notices, settings] = await Promise.all([
      api.request('/api/me'),
      api.request('/api/tables'),
      api.request('/api/products'),
      api.request('/api/history'),
      api.request('/api/notices'),
      api.request('/api/settings')
    ]);

    state.user = me;
    state.tables = tables;
    state.products = products;
    state.history = history;
    state.notices = notices;
    state.settings = settings;

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
    localStorage.removeItem('comanda_token');
    state.token = '';
    state.user = null;
    render();
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

async function saveRestaurantName(restaurantName) {
  state.settings = await api.request('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ restaurantName })
  });
  document.querySelector('.topbar h1').textContent = state.settings.restaurantName;
  const message = document.getElementById('settingsMessage');
  message.textContent = 'Configuração salva.';
  message.className = 'form-success';
}

async function setProductStation(productId, station) {
  await api.request(`/api/products/${productId}/production-station`, {
    method: 'PATCH',
    body: JSON.stringify({ station })
  });
  state.products = await api.request('/api/products');
  render();
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

function bindNavigation() {
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.addEventListener('click', async () => {
      state.view = button.dataset.view;
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
    state.view = 'operations';
    if (productionRefreshTimer) clearInterval(productionRefreshTimer);
    productionRefreshTimer = null;
    render();
  });
}

async function createOrder(tableId, waiterName) {
  const result = await api.request('/api/orders', {
    method: 'POST',
    body: JSON.stringify({ tableId, waiterName })
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
  await api.request(`/api/orders/${state.activeOrderId}/discount`, {
    method: 'POST',
    body: JSON.stringify({ type, value })
  });
  await loadAppData();
}

async function payOrder(method, amount, received = null) {
  if (!state.activeOrderId) return;
  await api.request(`/api/orders/${state.activeOrderId}/pay`, {
    method: 'POST',
    body: JSON.stringify({ method, amount, received })
  });
  await loadAppData();
}

async function closeOrder() {
  if (!state.activeOrderId) return;
  await api.request(`/api/orders/${state.activeOrderId}/close`, {
    method: 'POST',
    body: JSON.stringify({})
  });
  state.activeOrderId = null;
  await loadAppData();
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
          <div id="loginError" class="notice" style="display:none"></div>
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
      await login(email, password);
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.style.display = 'block';
    }
  });
}

function renderDashboard() {
  if (state.view === 'settings' && state.user?.role !== 'admin') {
    state.view = 'operations';
  }

  const nav = `
    <header>
      <div class="topbar">
        <h1>${escapeHtml(state.settings.restaurantName || 'Comanda')}</h1>
        <nav class="main-nav" aria-label="Navegação principal">
          <button class="btn btn-quiet ${state.view === 'operations' ? 'active' : ''}" data-view="operations">Salão</button>
          <button class="btn btn-quiet ${state.view === 'kitchen' ? 'active' : ''}" data-view="kitchen">Cozinha</button>
          <button class="btn btn-quiet ${state.view === 'bar' ? 'active' : ''}" data-view="bar">Bar</button>
          ${state.user?.role === 'admin' ? `<button class="btn btn-quiet ${state.view === 'settings' ? 'active' : ''}" data-view="settings">Configurações + backup</button>` : ''}
        </nav>
        <div class="user-tools"><span class="user-pill">${escapeHtml(state.user?.name || 'Usuário')} · ${escapeHtml(state.user?.role || '')}</span><button class="btn btn-quiet" id="logoutBtn">Sair</button></div>
      </div>
    </header>
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
            <button class="btn btn-primary" type="submit">Salvar configurações</button>
            <span id="settingsMessage" role="status"></span>
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
          <h3>Backup dos dados</h3>
          <p class="muted-copy">Baixe uma cópia dos dados cadastrados em formato JSON. O arquivo inclui hashes de senha; guarde-o em local seguro.</p>
          <button class="btn btn-primary" id="downloadBackupBtn">Baixar backup</button>
          <span id="backupMessage" role="status"></span>
        </section>
      </main>
    `;
    bindNavigation();
    document.getElementById('settingsForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await saveRestaurantName(document.getElementById('restaurantName').value);
      } catch (error) {
        const message = document.getElementById('settingsMessage');
        message.textContent = error.message;
        message.className = 'form-error';
      }
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

  const products = state.products.map((product) => `
    <div class="product-item">
      <div class="product-meta">
        <strong>${escapeHtml(product.name)}</strong>
        <span>${escapeHtml(product.category)}</span>
      </div>
      <div class="amount">${formatMoney(product.price)}</div>
      <button class="btn btn-secondary" data-product-add="${escapeHtml(product.id)}">Adicionar</button>
    </div>
  `).join('');

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

      <div class="dashboard-grid">
        <section class="order-panel">
          <h3>Mesas</h3>
          <div class="table-grid">${tableCards}</div>
        </section>

        <aside class="order-panel">
          <h3>Produtos</h3>
          <div class="product-list">${products}</div>
        </aside>
      </div>

      <section class="order-panel active-order-panel">
        <h3>Comanda ativa</h3>
        <div id="orderContainer">
          ${renderActiveOrderSection()}
        </div>
      </section>

      <section class="order-panel history-panel">
        <h3>Histórico</h3>
        <div class="history-list">
          ${state.history.length ? state.history.map((order) => `
            <div class="history-item">
              <strong>Mesa ${order.tableNumber || order.tableId}</strong>
              <div>${formatMoney(order.total)} · ${new Date(order.closedAt).toLocaleString('pt-BR')}</div>
            </div>
          `).join('') : '<div class="empty-box">Sem comandas fechadas.</div>'}
        </div>
      </section>
    </div>
  `;
  bindNavigation();

  document.querySelectorAll('[data-open-table]').forEach((button) => {
    button.addEventListener('click', async () => {
      const tableId = button.getAttribute('data-open-table');
      const table = state.tables.find((t) => t.id === tableId);
      if (!table) return;

      if (table.openOrderId) {
        state.activeOrderId = table.openOrderId;
        await loadAppData();
        return;
      }

      await createOrder(tableId, state.user.name);
    });
  });

  document.querySelectorAll('[data-product-add]').forEach((button) => {
    button.addEventListener('click', async () => {
      const productId = button.getAttribute('data-product-add');
      if (!state.activeOrderId) {
        const firstFreeTable = state.tables.find((t) => !t.openOrderId);
        if (firstFreeTable) {
          await createOrder(firstFreeTable.id, state.user.name);
          await addItemToOrder(productId, 1);
          return;
        }
        alert('Não há mesa livre para abrir a comanda.');
        return;
      }
      await addItemToOrder(productId, 1);
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
      <span class="order-state">EM ANDAMENTO</span>
    </div>
    <div class="row" style="margin-bottom:16px;">
      <label>
        Tipo de desconto
        <select id="discountType">
          <option value="percent">%</option>
          <option value="value">R$</option>
        </select>
      </label>
      <label>
        Valor
        <input id="discountValue" type="number" min="0" step="0.01" value="0" />
      </label>
      <button class="btn btn-warning" id="applyDiscountBtn">Aplicar</button>
    </div>
    <div class="item-list">
      ${order.items.length ? order.items.map((item) => `
        <div class="order-item">
          <div>
            <strong>${escapeHtml(item.productName)}</strong>
          </div>
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
