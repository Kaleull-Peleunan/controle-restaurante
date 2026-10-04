const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

let testPort;

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port: testPort,
      path,
      method,
      headers: {
        ...headers,
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        } : {})
      }
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        const text = raw || '{}';
        try {
          resolve({ status: res.statusCode, body: JSON.parse(text) });
        } catch {
          resolve({ status: res.statusCode, body: text });
        }
      });
    });

    req.on('error', (error) => reject(new Error(`${method} ${path}: ${error.message}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  testPort = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
  const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comanda-smoke-'));
  const server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(testPort),
      JWT_SECRET: 'comanda-local-dev-secret-123456789',
      USE_JSON_DB: 'true',
      COMANDA_DATA_FILE: path.join(testDataDir, 'db.json')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk.toString(); });
  server.stderr.on('data', (chunk) => { output += chunk.toString(); });

  const waitForServer = async () => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (server.exitCode !== null || server.signalCode !== null) {
        throw new Error(`Servidor encerrou antes de iniciar. Saída: ${output}`);
      }
      try {
        await request('GET', '/api/health');
        return;
      } catch {
        // continue until server starts
      }
    }
    throw new Error(`Servidor não respondeu a tempo. Saída: ${output}`);
  };

  try {
    await waitForServer();

    const health = await request('GET', '/api/health');
    if (health.status !== 200 || !health.body.ok) {
      throw new Error(`Health falhou: ${JSON.stringify(health)}`);
    }

    const login = await request('POST', '/api/login', {
      email: 'admin@restaurante.com',
      password: '852013'
    });
    if (login.status !== 200 || !login.body.token) {
      throw new Error(`Login falhou: ${JSON.stringify(login)}`);
    }
    if (!login.body.user.tenantId) throw new Error('Sessão local não recebeu um identificador de loja.');
    const localSignup = await request('POST', '/api/signup', {
      storeName: 'Loja JSON', storeSlug: 'loja-json-smoke', name: 'Admin', email: 'json@example.com', password: 'senha-forte-123'
    });
    if (localSignup.status !== 503) throw new Error(`Cadastro SaaS deveria exigir PostgreSQL: ${JSON.stringify(localSignup)}`);

    const tables = await request('GET', '/api/tables', null, { Authorization: `Bearer ${login.body.token}` });
    if (tables.status !== 200 || !Array.isArray(tables.body)) {
      throw new Error(`Tables falhou: ${JSON.stringify(tables)}`);
    }

    const headers = { Authorization: `Bearer ${login.body.token}` };
    const product = await request('POST', '/api/products', {
      name: 'Produto de teste', category: 'Teste', price: 4.5, productionStation: 'bar', active: true
    }, headers);
    if (product.status !== 201 || product.body.productionStation !== 'bar') {
      throw new Error(`Cadastro de produto falhou: ${JSON.stringify(product)}`);
    }
    const listedProduct = await request('GET', '/api/products?includeInactive=true', null, headers);
    if (listedProduct.status !== 200 || !listedProduct.body.some((item) => item.id === product.body.id)) {
      throw new Error(`Consulta de produtos falhou: ${JSON.stringify(listedProduct)}`);
    }
    const editedProduct = await request('PATCH', `/api/products/${product.body.id}`, {
      name: 'Produto editado', category: 'Teste', price: 5, productionStation: 'kitchen', active: true
    }, headers);
    if (editedProduct.status !== 200 || editedProduct.body.name !== 'Produto editado') {
      throw new Error(`Edição de produto falhou: ${JSON.stringify(editedProduct)}`);
    }
    const deactivatedProduct = await request('DELETE', `/api/products/${product.body.id}`, null, headers);
    if (deactivatedProduct.status !== 200) throw new Error(`Desativação de produto falhou: ${JSON.stringify(deactivatedProduct)}`);
    const activeProducts = await request('GET', '/api/products', null, headers);
    if (activeProducts.status !== 200 || activeProducts.body.some((item) => item.id === product.body.id)) {
      throw new Error(`Produto inativo continua disponível: ${JSON.stringify(activeProducts)}`);
    }

    const notice = await request('POST', '/api/notices', { message: 'Teste', tableId: 't1' }, headers);
    if (notice.status !== 201 || !notice.body.readAt[login.body.user.id]) {
      throw new Error(`Criação de aviso falhou: ${JSON.stringify(notice)}`);
    }
    const callNotice = await request('POST', '/api/notices', { type: 'call', tableId: 't1' }, headers);
    if (callNotice.status !== 201 || callNotice.body.type !== 'call' || !callNotice.body.message) {
      throw new Error(`Chamado sem texto falhou: ${JSON.stringify(callNotice)}`);
    }
    const longNotice = await request('POST', '/api/notices', { message: 'x'.repeat(161) }, headers);
    if (longNotice.status !== 400) throw new Error(`Recado acima de 160 caracteres foi aceito: ${JSON.stringify(longNotice)}`);
    const readNotice = await request('PATCH', `/api/notices/${notice.body.id}/read`, {}, headers);
    if (readNotice.status !== 200) throw new Error(`Leitura de aviso falhou: ${JSON.stringify(readNotice)}`);
    const listedNotices = await request('GET', '/api/notices', null, headers);
    if (listedNotices.status !== 200 || !listedNotices.body.find((item) => item.id === notice.body.id)?.readAt) {
      throw new Error(`Aviso lido não foi retornado como lido: ${JSON.stringify(listedNotices)}`);
    }

    const manager = await request('POST', '/api/users', {
      name: 'Gerente Smoke', email: 'gerente-smoke@example.com', password: 'senha-teste-123', role: 'gerente'
    }, headers);
    if (manager.status !== 201) throw new Error(`Criação de conta falhou: ${JSON.stringify(manager)}`);
    const managerLogin = await request('POST', '/api/login', {
      email: 'gerente-smoke@example.com', password: 'senha-teste-123'
    });
    if (managerLogin.status !== 200) throw new Error(`Login de gerente falhou: ${JSON.stringify(managerLogin)}`);
    const managerHeaders = { Authorization: `Bearer ${managerLogin.body.token}` };
    const managerPin = await request('PATCH', `/api/users/${manager.body.id}`, {
      name: 'Gerente Smoke', email: 'gerente-smoke@example.com', role: 'gerente', active: true, pin: '1234'
    }, headers);
    if (managerPin.status !== 200 || !managerPin.body.pinRequired) throw new Error(`PIN de equipe não foi configurado: ${JSON.stringify(managerPin)}`);
    const adminPin = await request('PATCH', `/api/users/${login.body.user.id}`, {
      name: login.body.user.name, email: 'admin@restaurante.com', role: 'admin', active: true, pin: '5678'
    }, headers);
    if (adminPin.status !== 200 || !adminPin.body.pinRequired) throw new Error(`PIN administrativo não foi configurado: ${JSON.stringify(adminPin)}`);
    const targetedNotice = await request('POST', '/api/notices', {
      message: 'Aviso privado', toUserId: manager.body.id
    }, headers);
    if (targetedNotice.status !== 201) throw new Error(`Aviso direcionado falhou: ${JSON.stringify(targetedNotice)}`);
    const managerNotices = await request('GET', '/api/notices', null, managerHeaders);
    const unreadTargetedNotice = managerNotices.body.find((item) => item.id === targetedNotice.body.id);
    if (!unreadTargetedNotice || unreadTargetedNotice.readAt !== null) {
      throw new Error(`Aviso direcionado deveria estar não lido para o destinatário: ${JSON.stringify(managerNotices)}`);
    }
    const managerReadNotice = await request('PATCH', `/api/notices/${targetedNotice.body.id}/read`, {}, managerHeaders);
    if (managerReadNotice.status !== 200) throw new Error(`Destinatário não conseguiu ler o aviso: ${JSON.stringify(managerReadNotice)}`);
    const managerNoticesAfterRead = await request('GET', '/api/notices', null, managerHeaders);
    if (!managerNoticesAfterRead.body.find((item) => item.id === targetedNotice.body.id)?.readAt) {
      throw new Error('Destinatário não recebeu confirmação de leitura do aviso.');
    }
    const adminNotices = await request('GET', '/api/notices', null, headers);
    if (adminNotices.body.some((item) => item.id === targetedNotice.body.id)) {
      throw new Error('Aviso privado foi exposto a outro usuário.');
    }
    const userListDenied = await request('GET', '/api/users', null, {
      Authorization: `Bearer ${managerLogin.body.token}`
    });
    if (userListDenied.status !== 403) throw new Error(`Permissão de equipe incorreta: ${JSON.stringify(userListDenied)}`);

    const settings = await request('PATCH', '/api/settings', {
      restaurantName: 'Smoke', tableCount: 10, allowDiscount: true, requireWaiter: true,
      serviceFeePercent: 10, serviceFeeDefault: false, discountLimit: 10
    }, headers);
    if (settings.status !== 200 || settings.body.tableCount !== 10) {
      throw new Error(`Configuração de mesas falhou: ${JSON.stringify(settings)}`);
    }
    const cardTerminals = [
      { id: 'manual-1', name: 'Balcão manual', mode: 'manual', active: true },
      { id: 'tef-1', name: 'TEF teste', mode: 'tef', bridgeUrl: 'http://127.0.0.1:9000', active: true },
      ...['stone', 'cielo', 'pagbank', 'mercado_pago', 'rede_getnet'].map((provider) => ({
        id: `provider-${provider}`, name: `Terminal ${provider}`, mode: 'provider', provider, active: true
      }))
    ];
    const savedTerminals = await request('PATCH', '/api/settings', {
      restaurantName: 'Smoke', cardTerminals
    }, headers);
    if (savedTerminals.status !== 200 || savedTerminals.body.cardTerminals.length !== cardTerminals.length) {
      throw new Error(`Configurações de maquininhas não foram salvas: ${JSON.stringify(savedTerminals)}`);
    }
    const loadedTerminals = await request('GET', '/api/settings', null, headers);
    if (loadedTerminals.status !== 200 || !['manual', 'tef', 'provider'].every((mode) => loadedTerminals.body.cardTerminals.some((terminal) => terminal.mode === mode))
      || !['stone', 'cielo', 'pagbank', 'mercado_pago', 'rede_getnet'].every((provider) => loadedTerminals.body.cardTerminals.some((terminal) => terminal.provider === provider))) {
      throw new Error(`Modalidades/provedores de maquininhas incompletos: ${JSON.stringify(loadedTerminals)}`);
    }
    const invalidTerminal = await request('PATCH', '/api/settings', {
      restaurantName: 'Smoke',
      cardTerminals: [{ id: 'invalid-1', name: 'Provedor inválido', mode: 'provider', provider: 'unknown', active: true }]
    }, headers);
    if (invalidTerminal.status !== 400) throw new Error(`Provedor não suportado deveria ser rejeitado: ${JSON.stringify(invalidTerminal)}`);

    const tablesAfterSettings = (await request('GET', '/api/tables', null, headers)).body;
    const table9 = tablesAfterSettings.find((table) => table.number === 9);
    const tenthTable = (await request('GET', '/api/tables', null, headers)).body.find((table) => table.number === 10);
    const wrongPinOrder = await request('POST', '/api/orders', {
      tableId: table9.id, waiterId: manager.body.id, pin: '0000'
    }, headers);
    if (wrongPinOrder.status !== 401) throw new Error(`PIN incorreto deveria impedir a abertura: ${JSON.stringify(wrongPinOrder)}`);
    const idempotentOrderId = 'ee4b1c8d-6433-422a-bce2-a875b0b10aab';
    const managerOrder = await request('POST', '/api/orders', {
      id: idempotentOrderId, tableId: table9.id, waiterId: manager.body.id, pin: '1234'
    }, headers);
    if (managerOrder.status !== 201) throw new Error(`Abertura com PIN correto falhou: ${JSON.stringify(managerOrder)}`);
    const repeatedOrder = await request('POST', '/api/orders', {
      id: idempotentOrderId, tableId: table9.id, waiterId: manager.body.id, pin: '1234'
    }, headers);
    if (repeatedOrder.status !== 201 || repeatedOrder.body.order.id !== idempotentOrderId) {
      throw new Error(`Repetição de abertura offline não foi idempotente: ${JSON.stringify(repeatedOrder)}`);
    }
    const productId = (await request('GET', '/api/products', null, headers)).body[0].id;
    const idempotencyHeaders = { ...managerHeaders, 'Idempotency-Key': 'smoke-offline-item-0001' };
    const orderWithItems = await request('POST', `/api/orders/${managerOrder.body.order.id}/items`, { productId, quantity: 2 }, idempotencyHeaders);
    const repeatedItem = await request('POST', `/api/orders/${managerOrder.body.order.id}/items`, { productId, quantity: 2 }, idempotencyHeaders);
    if (repeatedItem.status !== 200 || repeatedItem.body.items[0].quantity !== 2) {
      throw new Error(`Reenvio do item offline duplicou o pedido: ${JSON.stringify(repeatedItem)}`);
    }
    const feeOrder = await request('POST', `/api/orders/${managerOrder.body.order.id}/service-fee`, { enabled: true }, managerHeaders);
    if (feeOrder.status !== 200 || feeOrder.body.serviceFeeAmount <= 0) throw new Error(`Taxa de serviço não foi aplicada: ${JSON.stringify(feeOrder)}`);
    const deniedDiscount = await request('POST', `/api/orders/${managerOrder.body.order.id}/discount`, {
      type: 'percent', value: 20, authorizationUserId: login.body.user.id, authorizationPin: '0000'
    }, managerHeaders);
    if (deniedDiscount.status !== 403) throw new Error(`Desconto alto sem PIN correto deveria ser negado: ${JSON.stringify(deniedDiscount)}`);
    const discount = await request('POST', `/api/orders/${managerOrder.body.order.id}/discount`, {
      type: 'percent', value: 20, authorizationUserId: login.body.user.id, authorizationPin: '5678'
    }, managerHeaders);
    if (discount.status !== 200 || !discount.body.discountAuth) throw new Error(`Desconto autorizado falhou: ${JSON.stringify(discount)}`);
    const expectedFee = Number(((discount.body.subtotal - discount.body.discountAmount) * 0.1).toFixed(2));
    if (Math.abs(discount.body.serviceFeeAmount - expectedFee) > 0.001) {
      throw new Error(`Taxa não foi recalculada sobre o valor com desconto: ${JSON.stringify(discount)}`);
    }
    const itemId = orderWithItems.body.items[0].id;
    const splitPayment = await request('POST', `/api/orders/${managerOrder.body.order.id}/pay`, {
      method: 'pix', items: [{ itemId, quantity: 1 }], split: { mode: 'items' }
    }, managerHeaders);
    if (splitPayment.status !== 200 || splitPayment.body.payment.details.items[0].quantity !== 1) {
      throw new Error(`Pagamento dividido por item falhou: ${JSON.stringify(splitPayment)}`);
    }
    const splitPaymentRemainder = await request('POST', `/api/orders/${managerOrder.body.order.id}/pay`, {
      method: 'pix', items: [{ itemId, quantity: 1 }], split: { mode: 'items' }
    }, managerHeaders);
    if (splitPaymentRemainder.status !== 200) {
      throw new Error(`Segundo pagamento dividido falhou: ${JSON.stringify(splitPaymentRemainder)}`);
    }
    const reducePaidItem = await request('PATCH', `/api/orders/${managerOrder.body.order.id}/items/${itemId}`, {
      quantity: 1
    }, managerHeaders);
    if (reducePaidItem.status !== 409) throw new Error(`Não deveria reduzir quantidade de item já pago: ${JSON.stringify(reducePaidItem)}`);
    const removePaidItem = await request('DELETE', `/api/orders/${managerOrder.body.order.id}/items/${itemId}`, null, managerHeaders);
    if (removePaidItem.status !== 409) throw new Error(`Não deveria remover item já pago: ${JSON.stringify(removePaidItem)}`);
    const reversedPayment = await request('POST', `/api/orders/${managerOrder.body.order.id}/payments/${splitPayment.body.payment.id}/reverse`, {
      reason: 'Teste de estorno'
    }, headers);
    if (reversedPayment.status !== 200 || reversedPayment.body.order.paidTotal <= 0) {
      throw new Error(`Estorno parcial falhou: ${JSON.stringify(reversedPayment)}`);
    }
    const reversedRemainder = await request('POST', `/api/orders/${managerOrder.body.order.id}/payments/${splitPaymentRemainder.body.payment.id}/reverse`, {
      reason: 'Teste de estorno'
    }, headers);
    if (reversedRemainder.status !== 200 || reversedRemainder.body.order.paidTotal !== 0) {
      throw new Error(`Estorno interno falhou: ${JSON.stringify(reversedRemainder)}`);
    }
    const settledOrder = await request('POST', `/api/orders/${managerOrder.body.order.id}/pay`, {
      method: 'pix', amount: discount.body.total
    }, managerHeaders);
    if (settledOrder.status !== 200) throw new Error(`Pagamento final falhou: ${JSON.stringify(settledOrder)}`);
    const closedManagerOrder = await request('POST', `/api/orders/${managerOrder.body.order.id}/close`, {}, managerHeaders);
    if (closedManagerOrder.status !== 200) throw new Error(`Fechamento de comanda falhou: ${JSON.stringify(closedManagerOrder)}`);
    const today = new Date().toISOString().slice(0, 10);
    const report = await request('GET', `/api/reports?from=${today}&to=${today}&waiterId=${manager.body.id}`, null, managerHeaders);
    if (report.status !== 200 || report.body.summary.orderCount !== 1 || report.body.orders[0].id !== managerOrder.body.order.id) {
      throw new Error(`Relatório filtrado falhou: ${JSON.stringify(report)}`);
    }

    const firstOrder = await request('POST', '/api/orders', { tableId: tablesAfterSettings.find((table) => table.number === 1).id, pin: '5678' }, headers);
    const transfer = await request('POST', `/api/orders/${firstOrder.body.order.id}/transfer`, {
      tableId: tablesAfterSettings.find((table) => table.number === 3).id
    }, headers);
    if (transfer.status !== 200 || transfer.body.tableNumber !== 3) throw new Error(`Transferência de mesa falhou: ${JSON.stringify(transfer)}`);
    const sourceOrder = await request('POST', '/api/orders', { tableId: tablesAfterSettings.find((table) => table.number === 2).id, pin: '5678' }, headers);
    await request('POST', `/api/orders/${sourceOrder.body.order.id}/items`, { productId, quantity: 1 }, headers);
    const mergedOrder = await request('POST', `/api/orders/${firstOrder.body.order.id}/merge`, { sourceOrderId: sourceOrder.body.order.id }, headers);
    if (mergedOrder.status !== 200 || mergedOrder.body.subtotal <= 0) throw new Error(`Junção de comandas falhou: ${JSON.stringify(mergedOrder)}`);
    const cancelledOrder = await request('POST', `/api/orders/${firstOrder.body.order.id}/cancel`, { reason: 'Teste de cancelamento' }, headers);
    if (cancelledOrder.status !== 200) throw new Error(`Cancelamento de comanda falhou: ${JSON.stringify(cancelledOrder)}`);

    const openOrder = await request('POST', '/api/orders', { tableId: tenthTable.id, waiterName: 'Administrador', pin: '5678' }, headers);
    if (openOrder.status !== 201) throw new Error(`Abertura de comanda falhou: ${JSON.stringify(openOrder)}`);
    const unsafeReduction = await request('PATCH', '/api/settings', { restaurantName: 'Smoke', tableCount: 9 }, headers);
    if (unsafeReduction.status !== 409) throw new Error(`Redução de mesas ocupadas deveria ser bloqueada: ${JSON.stringify(unsafeReduction)}`);

    const unsupportedJsonImport = await request('POST', '/api/migration/import-legacy', {
      products: [], comandas: []
    }, headers);
    if (unsupportedJsonImport.status !== 409) throw new Error(`Modo JSON deveria bloquear importação PostgreSQL: ${JSON.stringify(unsupportedJsonImport)}`);

    console.log('SMOKE TEST OK: login, PINs, catálogo, comandas, taxas/descontos, pagamentos divididos/estornos, transferências/junções/cancelamentos, relatórios, avisos e configurações');
    process.exitCode = 0;
  } catch (error) {
    console.error(`${error.message}\n${output}`.trim());
    process.exitCode = 1;
  } finally {
    server.kill('SIGTERM');
    if (server.exitCode === null && server.signalCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        server.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
})();
