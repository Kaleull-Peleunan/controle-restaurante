const { spawn } = require('child_process');
const http = require('http');

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port: 3000,
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

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: '3000',
      JWT_SECRET: 'comanda-local-dev-secret-123456789',
      USE_JSON_DB: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk.toString(); });
  server.stderr.on('data', (chunk) => { output += chunk.toString(); });

  const waitForServer = async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
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

    const tables = await request('GET', '/api/tables', null, { Authorization: `Bearer ${login.body.token}` });
    if (tables.status !== 200 || !Array.isArray(tables.body)) {
      throw new Error(`Tables falhou: ${JSON.stringify(tables)}`);
    }

    console.log('SMOKE TEST OK');
    process.exitCode = 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    server.kill('SIGTERM');
  }
})();
