const { spawn } = require('child_process');
const net = require('net');

const DATABASE_URL = process.env.TENANT_TEST_DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('Defina TENANT_TEST_DATABASE_URL para um banco PostgreSQL de teste descartável.');
}
if (!new URL(DATABASE_URL).pathname.toLowerCase().includes('test')) {
  throw new Error('Por segurança, o nome do banco em TENANT_TEST_DATABASE_URL deve conter "test".');
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function startServer() {
  const port = await getFreePort();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL,
      USE_JSON_DB: 'false',
      PGSSL: process.env.TENANT_TEST_PGSSL || 'false',
      JWT_SECRET: 'tenant-smoke-test-secret-12345678901234567890',
      ADMIN_EMAIL: 'legacy-test@example.com',
      ADMIN_PASSWORD: 'legacy-test-password'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk; });
  server.stderr.on('data', (chunk) => { output += chunk; });

  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Servidor encerrou durante a inicialização:\n${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return { server, port, output: () => output };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  server.kill();
  throw new Error(`Servidor não iniciou no tempo esperado:\n${output}`);
}

async function stopServer(server) {
  if (server.exitCode !== null) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill();
  await exited;
}

async function request(port, method, path, body, token, extraHeaders = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extraHeaders
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json();
  return { status: response.status, body: data };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  let running;
  try {
    running = await startServer();
    const { port } = running;
    const signup = async (storeName, storeSlug) => {
      const result = await request(port, 'POST', '/api/signup', {
        storeName,
        storeSlug,
        name: 'Admin Teste',
        email: 'admin@same-email.test',
        password: 'senha-forte-teste-123'
      });
      assert(result.status === 201, `Cadastro ${storeSlug} falhou: ${JSON.stringify(result.body)}`);
      return result.body;
    };

    const alpha = await signup('Loja Alpha', 'loja-alpha-smoke');
    const beta = await signup('Loja Beta', 'loja-beta-smoke');
    assert(alpha.user.tenantId !== beta.user.tenantId, 'As lojas receberam o mesmo tenant_id.');
    const alphaMe = await request(port, 'GET', '/api/me', null, alpha.token);
    const betaMe = await request(port, 'GET', '/api/me', null, beta.token);
    assert(alphaMe.status === 200 && alphaMe.body.tenantId === alpha.user.tenantId, 'Sessão Alpha não ficou vinculada à sua loja.');
    assert(betaMe.status === 200 && betaMe.body.tenantId === beta.user.tenantId, 'Sessão Beta não ficou vinculada à sua loja.');

    const alphaTables = await request(port, 'GET', '/api/tables', null, alpha.token);
    const betaTables = await request(port, 'GET', '/api/tables', null, beta.token);
    assert(alphaTables.body.length === 8 && betaTables.body.length === 8, 'As mesas iniciais de uma loja não foram provisionadas.');
    assert(alphaTables.body[0].id !== betaTables.body[0].id, 'IDs de mesas foram compartilhados entre lojas.');

    const product = await request(port, 'POST', '/api/products', {
      name: 'Produto Alpha', category: 'Teste', price: 12, productionStation: 'kitchen', active: true
    }, alpha.token);
    assert(product.status === 201, `Não foi possível cadastrar produto na loja Alpha: ${JSON.stringify(product.body)}`);
    const betaProducts = await request(port, 'GET', '/api/products', null, beta.token);
    assert(!betaProducts.body.some((entry) => entry.id === product.body.id), 'Produto de Alpha vazou para Beta.');

    const orderId = 'ee4b1c8d-6433-422a-bce2-a875b0b10aab';
    const orderBody = { id: orderId, tableId: alphaTables.body[0].id };
    const order = await request(port, 'POST', '/api/orders', orderBody, alpha.token);
    assert(order.status === 201 && order.body.order.id === orderId, `Comanda Alpha falhou: ${JSON.stringify(order.body)}`);
    const repeatedOrder = await request(port, 'POST', '/api/orders', orderBody, alpha.token);
    assert(repeatedOrder.status === 201 && repeatedOrder.body.order.id === orderId, 'Reenvio da abertura de comanda não foi idempotente.');

    const itemPath = `/api/orders/${orderId}/items`;
    const itemHeaders = { 'Idempotency-Key': 'tenant-smoke-item-0001' };
    const addItem = await request(port, 'POST', itemPath, { productId: product.body.id, quantity: 2 }, alpha.token, itemHeaders);
    const replayItem = await request(port, 'POST', itemPath, { productId: product.body.id, quantity: 2 }, alpha.token, itemHeaders);
    assert(addItem.status === 200 && replayItem.status === 200, 'Adição idempotente de item falhou.');
    assert(replayItem.body.items[0].quantity === 2, 'Reenvio de item duplicou a quantidade.');

    const betaOrder = await request(port, 'GET', `/api/orders/${orderId}`, null, beta.token);
    const betaForeignTableOrder = await request(port, 'POST', '/api/orders', {
      tableId: alphaTables.body[1].id
    }, beta.token);
    assert(betaOrder.status === 404, 'Beta conseguiu ler uma comanda de Alpha.');
    assert(betaForeignTableOrder.status === 404, 'Beta conseguiu associar uma comanda à mesa de Alpha.');

    const slugLogin = await request(port, 'POST', '/api/login', {
      storeSlug: 'loja-alpha-smoke', email: 'admin@same-email.test', password: 'senha-forte-teste-123'
    });
    assert(slugLogin.status === 200 && slugLogin.body.user.tenantId === alpha.user.tenantId, 'Login por loja não selecionou o tenant correto.');

    await stopServer(running.server);
    running = await startServer();
    const afterRestart = await request(running.port, 'GET', '/api/products', null, alpha.token);
    assert(afterRestart.status === 200 && afterRestart.body.some((entry) => entry.id === product.body.id), 'Dados não persistiram ou a migração repetida falhou.');
    console.log('TENANT SMOKE TEST OK: cadastro, login, isolamento RLS entre lojas, provisionamento, pedidos e idempotência após reconexão/reinicialização');
  } catch (error) {
    console.error(error.message);
    if (running?.output) console.error(running.output());
    process.exitCode = 1;
  } finally {
    if (running) await stopServer(running.server);
  }
})();
