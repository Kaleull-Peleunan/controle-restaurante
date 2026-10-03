require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined
    })
  : null;
const DATA_FILE = process.env.COMANDA_DATA_FILE
  ? path.resolve(process.env.COMANDA_DATA_FILE)
  : path.join(__dirname, 'data', 'db.json');
const JSON_MODE = process.env.USE_JSON_DB === 'true' || !DATABASE_URL || !fs.existsSync(path.join(__dirname, 'db', 'schema.sql'));
const pinFailures = new Map();

app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '12h' });
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token necessário' });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }
  if (JSON_MODE) {
    const user = readJsonData().users.find((item) => item.id === req.user.sub);
    if (!user || user.active === false) return res.status(401).json({ error: 'Conta inativa ou removida.' });
    req.user.role = user.role;
    req.user.name = user.name;
    return next();
  }
  pool.query('SELECT active, role, name FROM users WHERE id = $1', [req.user.sub])
    .then((result) => {
      if (!result.rowCount || !result.rows[0].active) return res.status(401).json({ error: 'Conta inativa ou removida.' });
      req.user.role = result.rows[0].role;
      req.user.name = result.rows[0].name;
      next();
    })
    .catch(next);
}

function adminMiddleware(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso restrito ao administrador' });
  }
  next();
}

function managerMiddleware(req, res, next) {
  if (!['admin', 'gerente'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'Acesso restrito à administração ou gerência.' });
  }
  next();
}

function administratorMiddleware(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso restrito ao administrador.' });
  }
  next();
}

function money(value) {
  return Number(Number(value || 0).toFixed(2));
}

async function getUserPin(userId, client = pool) {
  if (JSON_MODE) {
    const user = readJsonData().users.find((item) => item.id === userId && item.active !== false);
    return user ? { id: user.id, name: user.name, role: user.role, pinHash: user.pin_hash || user.pinHash || null } : null;
  }
  const result = await client.query(
    'SELECT id, name, role, pin_hash AS "pinHash" FROM users WHERE id = $1 AND active = true',
    [userId]
  );
  return result.rows[0] || null;
}

async function validateUserPin(userId, pin, client = pool, actorId = userId) {
  const user = await getUserPin(userId, client);
  if (!user) return { valid: false, user: null };
  if (!user.pinHash) return { valid: pin === undefined || pin === null || pin === '', user };
  if (typeof pin !== 'string' || !pin) return { valid: false, user };
  const key = `${actorId}:${userId}`;
  const now = Date.now();
  const failure = pinFailures.get(key);
  if (failure && failure.resetAt > now && failure.count >= 5) return { valid: false, limited: true, user };
  if (failure && failure.resetAt <= now) pinFailures.delete(key);
  const valid = await bcrypt.compare(pin, user.pinHash);
  if (valid) {
    pinFailures.delete(key);
    return { valid, user };
  }
  const current = pinFailures.get(key);
  const next = current && current.resetAt > now
    ? { count: current.count + 1, resetAt: current.resetAt }
    : { count: 1, resetAt: now + 15 * 60 * 1000 };
  pinFailures.set(key, next);
  if (pinFailures.size > 10000) {
    for (const [attemptKey, attempt] of pinFailures) {
      if (attempt.resetAt <= now) pinFailures.delete(attemptKey);
    }
  }
  return { valid: false, limited: next.count >= 5, user };
}

function addJsonAudit(data, actor, action, detail) {
  data.audit = Array.isArray(data.audit) ? data.audit : [];
  data.audit.unshift({
    id: crypto.randomUUID(),
    actorUserId: actor.sub,
    actorName: actor.name || 'Equipe',
    action,
    detail,
    createdAt: new Date().toISOString()
  });
  data.audit = data.audit.slice(0, 500);
}

async function addAuditEvent(client, actor, action, detail) {
  await client.query(
    `INSERT INTO audit_events (id, actor_user_id, actor_name, action, detail)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [crypto.randomUUID(), actor.sub, actor.name || 'Equipe', action, JSON.stringify(detail || {})]
  );
}

async function getOperationalSettings(client = pool) {
  if (JSON_MODE) return readJsonData().settings;
  const result = await client.query(
    `SELECT key, value FROM app_settings
      WHERE key IN ('allow_discount', 'require_waiter', 'service_fee_percent', 'service_fee_default', 'discount_limit')`
  );
  const values = Object.fromEntries(result.rows.map((row) => [row.key, row.value]));
  return {
    allowDiscount: values.allow_discount !== 'false',
    requireWaiter: values.require_waiter !== 'false',
    serviceFeePercent: Number(values.service_fee_percent ?? 10),
    serviceFeeDefault: values.service_fee_default === 'true',
    discountLimit: Math.min(100, Math.max(0, Number(values.discount_limit ?? 10)))
  };
}

function calculateServiceFee(subtotal, discount, percent, enabled) {
  return enabled ? money(Math.max(0, subtotal - discount) * percent / 100) : 0;
}

function recalculateJsonServiceFee(order) {
  const subtotal = (order.items || []).reduce((sum, item) => sum + Number(item.quantity) * Number(item.price), 0);
  order.serviceFeeAmount = calculateServiceFee(
    subtotal, Number(order.discountAmount || 0), Number(order.serviceFeePercent || 0), order.serviceFeeEnabled === true
  );
}

async function recalculatePostgresServiceFee(client, orderId) {
  await client.query(
    `UPDATE orders o
        SET service_fee_amount = CASE WHEN o.service_fee_enabled
          THEN ROUND(GREATEST(0, COALESCE((SELECT SUM(oi.quantity * oi.price) FROM order_items oi WHERE oi.order_id = o.id), 0)
            - o.discount_amount) * o.service_fee_percent / 100, 2)
          ELSE 0 END,
            updated_at = now()
      WHERE o.id = $1`,
    [orderId]
  );
}

function allocatedItemQuantity(payments, itemId) {
  return payments
    .filter((payment) => payment.status !== 'reversed')
    .flatMap((payment) => payment.details?.items || [])
    .filter((allocation) => allocation.itemId === itemId)
    .reduce((sum, allocation) => sum + Number(allocation.quantity || 0), 0);
}

function defaultJsonData() {
  const adminPasswordHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || '852013', 12);
  return {
    users: [{
      id: 'u-admin',
      name: 'Administrador',
      email: (process.env.ADMIN_EMAIL || 'admin@restaurante.com').toLowerCase(),
      passwordHash: adminPasswordHash,
      role: 'admin'
    }],
    tables: Array.from({ length: 8 }, (_, index) => ({
      id: `t${index + 1}`,
      number: index + 1,
      status: 'free'
    })),
    products: [
      { id: 'p1', name: 'Água mineral', category: 'Bebidas', price: 5, active: true, productionStation: 'bar' },
      { id: 'p2', name: 'Refrigerante lata', category: 'Bebidas', price: 7, active: true, productionStation: 'bar' },
      { id: 'p3', name: 'Cerveja long neck', category: 'Cervejas', price: 12, active: true, productionStation: 'bar' },
      { id: 'p4', name: 'Batata frita', category: 'Petiscos', price: 28, active: true, productionStation: 'kitchen' },
      { id: 'p5', name: 'Frango a passarinho', category: 'Petiscos', price: 42, active: true, productionStation: 'kitchen' },
      { id: 'p6', name: 'Filé à parmegiana', category: 'Pratos', price: 62, active: true, productionStation: 'kitchen' }
    ],
    orders: [],
    payments: [],
    notices: [],
    audit: [],
    settings: {
      restaurantName: 'Comanda',
      allowDiscount: true,
      requireWaiter: true,
      serviceFeePercent: 10,
      serviceFeeDefault: false,
      discountLimit: 10
    }
  };
}

function ensureJsonDataFile() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(defaultJsonData(), null, 2));
  }
}

function readJsonData() {
  ensureJsonDataFile();
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    let convertedPlainPins = false;
    const data = {
      users: (parsed.users || []).map((user) => {
        const normalized = { ...user };
        if (!normalized.pin_hash && !normalized.pinHash && typeof normalized.pin === 'string' && normalized.pin) {
          normalized.pin_hash = bcrypt.hashSync(normalized.pin, 12);
          convertedPlainPins = true;
        }
        delete normalized.pin;
        delete normalized.pinHash;
        return {
          ...normalized,
          password_hash: normalized.password_hash || normalized.passwordHash || null
        };
      }),
      tables: parsed.tables || [],
      products: (parsed.products || []).map((product) => ({
        ...product,
        productionStation: product.productionStation || product.production_station || inferProductStation(product)
      })),
      orders: (parsed.orders || []).map((order) => ({
        ...order,
        items: (order.items || []).map((item) => ({
          ...item,
          productionStation: item.productionStation || dataProductStation(parsed.products || [], item.productId),
          productionStatus: item.productionStatus || 'pending'
        }))
      })),
      payments: parsed.payments || [],
      notices: parsed.notices || [],
      audit: parsed.audit || [],
      settings: {
        ...parsed.settings,
        restaurantName: parsed.settings?.restaurantName || parsed.settings?.name || 'Comanda',
        allowDiscount: parsed.settings?.allowDiscount !== false,
        requireWaiter: parsed.settings?.requireWaiter !== false,
        serviceFeePercent: Number(parsed.settings?.serviceFeePercent ?? parsed.settings?.serviceFeePct ?? 10),
        serviceFeeDefault: parsed.settings?.serviceFeeDefault === true,
        discountLimit: Math.min(100, Math.max(0, Number(parsed.settings?.discountLimit ?? 10)))
      }
    };
    if (convertedPlainPins) fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    return data;
  } catch {
    const fallback = defaultJsonData();
    fs.writeFileSync(DATA_FILE, JSON.stringify(fallback, null, 2));
    return fallback;
  }
}

function dataProductStation(products, productId) {
  const product = products.find((entry) => entry.id === productId);
  return product?.productionStation || product?.production_station || inferProductStation(product);
}

function inferProductStation(product) {
  return /bebida|cerveja|drink|suco/i.test(product?.category || '') ? 'bar' : 'kitchen';
}

function writeJsonData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function jsonGetOrder(orderId) {
  const data = readJsonData();
  const order = data.orders.find((item) => item.id === orderId);
  if (!order) return null;

  const items = (order.items || []).map((item) => ({
    ...item,
    quantity: Number(item.quantity),
    price: money(item.price),
    productionStation: item.productionStation || item.production_station || dataProductStation(data.products, item.productId),
    productionStatus: item.productionStatus || 'pending',
    total: money(Number(item.quantity) * Number(item.price))
  }));
  const subtotal = money(items.reduce((sum, item) => sum + Number(item.total || 0), 0));
  const discountAmount = money(order.discountAmount || 0);
  const serviceFeeAmount = money(order.serviceFeeAmount || 0);
  const payments = (data.payments || []).filter((payment) => payment.orderId === orderId);

  return {
    id: order.id,
    tableId: order.tableId,
    tableNumber: data.tables.find((table) => table.id === order.tableId)?.number ?? null,
    waiterId: order.waiterId || null,
    waiterName: order.waiterName,
    status: order.status,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    closedAt: order.closedAt || null,
    discountAmount,
    discountType: order.discountType || null,
    discountValue: order.discountValue ?? null,
    discountAuth: order.discountAuth || null,
    serviceFeeAmount,
    serviceFeePercent: Number(order.serviceFeePercent || 0),
    serviceFeeEnabled: order.serviceFeeEnabled === true,
    cancellationReason: order.cancellationReason || null,
    mergedIntoOrderId: order.mergedIntoOrderId || null,
    paidTotal: money(order.paidTotal || 0),
    payments,
    notes: order.notes || '',
    items,
    subtotal,
    total: money(Math.max(0, subtotal - discountAmount + serviceFeeAmount)),
  };
}

function jsonGetTables() {
  const data = readJsonData();
  return data.tables.filter((table) => table.active !== false).map((table) => {
    const openOrder = data.orders.find((order) => order.tableId === table.id && order.status === 'open');
    const openOrderTotal = openOrder
      ? money((openOrder.items || []).reduce((sum, item) => sum + Number(item.quantity) * Number(item.price), 0)
        - Number(openOrder.discountAmount || 0) + Number(openOrder.serviceFeeAmount || 0))
      : 0;
    return {
      id: table.id,
      number: table.number,
      status: table.status,
      openOrderId: openOrder ? openOrder.id : null,
      openOrderTotal: money(Math.max(0, openOrderTotal))
    };
  });
}

async function getOrder(orderId, client = pool) {
  if (JSON_MODE) return jsonGetOrder(orderId);

  const result = await client.query(
    `SELECT o.id, o.table_id AS "tableId", o.waiter_id AS "waiterId", t.number AS "tableNumber",
            o.waiter_name AS "waiterName", o.status, o.created_at AS "createdAt",
            o.updated_at AS "updatedAt", o.closed_at AS "closedAt",
            o.discount_amount AS "discountAmount", o.discount_type AS "discountType",
            o.discount_value AS "discountValue", o.discount_authorized_by AS "discountAuthorizedBy",
            o.discount_authorized_at AS "discountAuthorizedAt",
            o.service_fee_amount AS "serviceFeeAmount", o.service_fee_percent AS "serviceFeePercent",
            o.service_fee_enabled AS "serviceFeeEnabled",
            o.paid_total AS "paidTotal", o.notes
       FROM orders o JOIN restaurant_tables t ON t.id = o.table_id
      WHERE o.id = $1`,
    [orderId]
  );
  if (!result.rowCount) return null;

  const order = result.rows[0];
  const itemResult = await client.query(
    `SELECT oi.id, oi.product_id AS "productId", oi.product_name AS "productName",
            oi.production_station AS "productionStation", oi.production_status AS "productionStatus",
            oi.quantity, oi.price, oi.quantity * oi.price AS total
       FROM order_items oi WHERE oi.order_id = $1 ORDER BY oi.created_at, oi.id`,
    [orderId]
  );
  const items = itemResult.rows.map((item) => ({
    ...item,
    quantity: Number(item.quantity),
    price: money(item.price),
    total: money(Number(item.quantity) * Number(item.price))
  }));
  const subtotal = money(items.reduce((sum, item) => sum + item.total, 0));
  const discountAmount = money(order.discountAmount);
  const serviceFeeAmount = money(order.serviceFeeAmount);
  const paymentResult = await client.query(
    `SELECT id, order_id AS "orderId", method, amount, received, details, status,
            created_at AS "createdAt" FROM payments
      WHERE order_id = $1 ORDER BY created_at, id`,
    [orderId]
  );

  return {
    ...order,
    items,
    payments: paymentResult.rows.map((payment) => ({
      ...payment,
      amount: money(payment.amount),
      received: payment.received == null ? null : money(payment.received)
    })),
    subtotal,
    discountAmount,
    discountType: order.discountType || null,
    discountValue: order.discountValue == null ? null : Number(order.discountValue),
    serviceFeePercent: Number(order.serviceFeePercent || 0),
    serviceFeeEnabled: order.serviceFeeEnabled === true,
    discountAuthorizedBy: order.discountAuthorizedBy || null,
    discountAuthorizedAt: order.discountAuthorizedAt || null,
    serviceFeeAmount,
    total: money(Math.max(0, subtotal - discountAmount + serviceFeeAmount)),
    paidTotal: money(order.paidTotal)
  };
}

app.get('/api/health', asyncRoute(async (_req, res) => {
  if (JSON_MODE) {
    return res.json({ ok: true, database: 'json' });
  }

  await pool.query('SELECT 1');
  res.json({ ok: true, database: 'connected' });
}));

app.post('/api/login', asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return res.status(400).json({ error: 'Email e senha são obrigatórios' });
  }

  if (JSON_MODE) {
    const data = readJsonData();
    const user = data.users.find((item) => item.email.toLowerCase() === email.trim().toLowerCase());
    const passwordHash = user?.password_hash || user?.passwordHash || null;
    if (!user || user.active === false || !passwordHash || !(await bcrypt.compare(password, passwordHash))) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    return res.json({
      token: signToken(user),
      user: { id: user.id, name: user.name, role: user.role, email: user.email }
    });
  }

  const result = await pool.query(
    'SELECT id, name, email, password_hash, role, active FROM users WHERE lower(email) = lower($1)',
    [email.trim()]
  );
  const user = result.rows[0];
  if (!user || !user.active || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }

  res.json({
    token: signToken(user),
    user: { id: user.id, name: user.name, role: user.role, email: user.email }
  });
}));

app.get('/api/me', authMiddleware, asyncRoute(async (req, res) => {
  if (JSON_MODE) {
    const data = readJsonData();
    const user = data.users.find((item) => item.id === req.user.sub);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    return res.json({ id: user.id, name: user.name, email: user.email, role: user.role, pinRequired: Boolean(user.pin_hash || user.pinHash) });
  }

  const result = await pool.query(
    'SELECT id, name, email, role, pin_hash IS NOT NULL AS "pinRequired" FROM users WHERE id = $1',
    [req.user.sub]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Usuário não encontrado' });
  res.json(result.rows[0]);
}));

app.get('/api/authorizers', authMiddleware, asyncRoute(async (_req, res) => {
  if (JSON_MODE) {
    return res.json(readJsonData().users
      .filter((user) => user.active !== false && user.role === 'admin')
      .map((user) => ({ id: user.id, name: user.name, pinRequired: Boolean(user.pin_hash || user.pinHash) })));
  }
  const result = await pool.query(
    `SELECT id, name, pin_hash IS NOT NULL AS "pinRequired"
       FROM users WHERE active = true AND role = 'admin' ORDER BY name`
  );
  res.json(result.rows);
}));

app.get('/api/users', authMiddleware, adminMiddleware, asyncRoute(async (_req, res) => {
  if (JSON_MODE) {
    return res.json(readJsonData().users.map(({ password_hash: _hash, passwordHash: _oldHash, pin_hash: _pinHash, pinHash: _oldPinHash, ...user }) => ({
      ...user,
      legacyImported: Boolean(user.legacy_reference),
      pinRequired: Boolean(_pinHash || _oldPinHash)
    })));
  }
  const result = await pool.query(
    `SELECT id, name, email, role, active, pin_hash IS NOT NULL AS "pinRequired",
            legacy_reference IS NOT NULL AS "legacyImported",
            created_at AS "createdAt" FROM users ORDER BY name, email`
  );
  res.json(result.rows);
}));

app.post('/api/users', authMiddleware, adminMiddleware, asyncRoute(async (req, res) => {
  const { name, email, password, pin = '', role = 'operador', active = true } = req.body || {};
  const cleanName = typeof name === 'string' ? name.trim() : '';
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!cleanName || cleanName.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)
    || cleanEmail.length > 160 || typeof password !== 'string' || password.length < 8
    || !['admin', 'gerente', 'operador'].includes(role) || typeof active !== 'boolean'
    || (pin !== '' && (typeof pin !== 'string' || !/^\d{4,6}$/.test(pin)))) {
    return res.status(400).json({ error: 'Informe nome, email válido, senha com ao menos 8 caracteres e perfil válido.' });
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const pinHash = pin ? await bcrypt.hash(pin, 12) : null;
  if (JSON_MODE) {
    const data = readJsonData();
    if (data.users.some((user) => user.email.toLowerCase() === cleanEmail)) {
      return res.status(409).json({ error: 'Já existe uma conta com este email.' });
    }
    const user = { id: crypto.randomUUID(), name: cleanName, email: cleanEmail, password_hash: passwordHash, pin_hash: pinHash, role, active };
    data.users.push(user);
    writeJsonData(data);
    return res.status(201).json({ id: user.id, name: user.name, email: user.email, role, active, pinRequired: Boolean(pinHash) });
  }
  try {
    const result = await pool.query(
      `INSERT INTO users (id, name, email, password_hash, pin_hash, role, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, email, role, active, pin_hash IS NOT NULL AS "pinRequired"`,
      [crypto.randomUUID(), cleanName, cleanEmail, passwordHash, pinHash, role, active]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Já existe uma conta com este email.' });
    throw error;
  }
}));

app.patch('/api/users/:id', authMiddleware, adminMiddleware, asyncRoute(async (req, res) => {
  const { name, email, password, pin, role, active } = req.body || {};
  const cleanName = typeof name === 'string' ? name.trim() : '';
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!cleanName || cleanName.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)
    || cleanEmail.length > 160 || !['admin', 'gerente', 'operador'].includes(role)
    || typeof active !== 'boolean' || (password !== undefined && (typeof password !== 'string' || password.length < 8))
    || (pin !== undefined && pin !== '' && (typeof pin !== 'string' || !/^\d{4,6}$/.test(pin)))) {
    return res.status(400).json({ error: 'Dados de conta inválidos; senhas novas devem ter ao menos 8 caracteres.' });
  }
  if (req.params.id === req.user.sub && !active) {
    return res.status(400).json({ error: 'Não é possível desativar a própria conta.' });
  }

  if (JSON_MODE) {
    const data = readJsonData();
    const user = data.users.find((item) => item.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Conta não encontrada.' });
    if (data.users.some((item) => item.id !== user.id && item.email.toLowerCase() === cleanEmail)) {
      return res.status(409).json({ error: 'Já existe uma conta com este email.' });
    }
    if (user.active !== false && user.role === 'admin' && (!active || role !== 'admin')
      && data.users.filter((item) => item.active !== false && item.role === 'admin' && item.id !== user.id).length === 0) {
      return res.status(409).json({ error: 'É necessário manter ao menos um administrador ativo.' });
    }
    Object.assign(user, { name: cleanName, email: cleanEmail, role, active });
    if (password !== undefined) user.password_hash = await bcrypt.hash(password, 12);
    if (pin !== undefined) user.pin_hash = pin ? await bcrypt.hash(pin, 12) : null;
    writeJsonData(data);
    return res.json({ id: user.id, name: user.name, email: user.email, role, active, pinRequired: Boolean(user.pin_hash) });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT id, role, active, legacy_reference FROM users WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!current.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Conta não encontrada.' });
    }
    if (current.rows[0].legacy_reference && active && password === undefined) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Defina uma senha nova antes de ativar uma conta migrada.' });
    }
    if (current.rows[0].active && current.rows[0].role === 'admin' && (!active || role !== 'admin')) {
      const admins = await client.query("SELECT id FROM users WHERE active = true AND role = 'admin' FOR UPDATE");
      if (admins.rows.filter((user) => user.id !== req.params.id).length === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'É necessário manter ao menos um administrador ativo.' });
      }
    }
    const passwordHash = password === undefined ? null : await bcrypt.hash(password, 12);
    const pinHash = pin === undefined ? null : pin ? await bcrypt.hash(pin, 12) : '';
    const result = await client.query(
      `UPDATE users SET name = $1, email = $2, role = $3, active = $4,
                        password_hash = COALESCE($5, password_hash),
                        pin_hash = CASE WHEN $6::text IS NULL THEN pin_hash WHEN $6 = '' THEN NULL ELSE $6 END
        WHERE id = $7 RETURNING id, name, email, role, active, pin_hash IS NOT NULL AS "pinRequired"`,
      [cleanName, cleanEmail, role, active, passwordHash, pinHash, req.params.id]
    );
    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(409).json({ error: 'Já existe uma conta com este email.' });
    throw error;
  } finally {
    client.release();
  }
}));

app.get('/api/products', authMiddleware, asyncRoute(async (req, res) => {
  if (JSON_MODE) {
    const data = readJsonData();
    const products = req.query.includeInactive === 'true' && ['admin', 'gerente'].includes(req.user.role)
      ? data.products
      : data.products.filter((product) => product.active !== false);
    return res.json(products.map((product) => ({ ...product, price: money(product.price) })));
  }

  const includeInactive = req.query.includeInactive === 'true' && ['admin', 'gerente'].includes(req.user.role);
  const result = await pool.query(
    `SELECT id, name, category, price, active, production_station AS "productionStation"
       FROM products ${includeInactive ? '' : 'WHERE active = true'} ORDER BY category, name`
  );
  res.json(result.rows.map((product) => ({ ...product, price: money(product.price) })));
}));

app.post('/api/products', authMiddleware, managerMiddleware, asyncRoute(async (req, res) => {
  const { name, category, price, productionStation = 'kitchen', active = true } = req.body || {};
  const cleanName = typeof name === 'string' ? name.trim() : '';
  const cleanCategory = typeof category === 'string' && category.trim() ? category.trim() : 'Sem categoria';
  const numericPrice = Number(price);
  if (!cleanName || cleanName.length > 180 || cleanCategory.length > 80
    || !Number.isFinite(numericPrice) || numericPrice < 0
    || !['kitchen', 'bar'].includes(productionStation) || typeof active !== 'boolean') {
    return res.status(400).json({ error: 'Informe nome, categoria, preço, estação e status válidos.' });
  }

  if (JSON_MODE) {
    const data = readJsonData();
    const product = {
      id: crypto.randomUUID(), name: cleanName, category: cleanCategory, price: money(numericPrice),
      productionStation, active, createdAt: new Date().toISOString()
    };
    data.products.push(product);
    writeJsonData(data);
    return res.status(201).json(product);
  }

  const result = await pool.query(
    `INSERT INTO products (id, name, category, price, production_station, active)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, name, category, price, production_station AS "productionStation", active`,
    [crypto.randomUUID(), cleanName, cleanCategory, money(numericPrice), productionStation, active]
  );
  res.status(201).json({ ...result.rows[0], price: money(result.rows[0].price) });
}));

app.patch('/api/products/:id', authMiddleware, managerMiddleware, asyncRoute(async (req, res) => {
  const { name, category, price, productionStation, active } = req.body || {};
  const cleanName = typeof name === 'string' ? name.trim() : '';
  const cleanCategory = typeof category === 'string' && category.trim() ? category.trim() : 'Sem categoria';
  const numericPrice = Number(price);
  if (!cleanName || cleanName.length > 180 || cleanCategory.length > 80
    || !Number.isFinite(numericPrice) || numericPrice < 0
    || !['kitchen', 'bar'].includes(productionStation) || typeof active !== 'boolean') {
    return res.status(400).json({ error: 'Informe nome, categoria, preço, estação e status válidos.' });
  }

  if (JSON_MODE) {
    const data = readJsonData();
    const product = data.products.find((item) => item.id === req.params.id);
    if (!product) return res.status(404).json({ error: 'Produto não encontrado.' });
    Object.assign(product, { name: cleanName, category: cleanCategory, price: money(numericPrice), productionStation, active });
    writeJsonData(data);
    return res.json(product);
  }

  const result = await pool.query(
    `UPDATE products SET name = $1, category = $2, price = $3, production_station = $4, active = $5
      WHERE id = $6
      RETURNING id, name, category, price, production_station AS "productionStation", active`,
    [cleanName, cleanCategory, money(numericPrice), productionStation, active, req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Produto não encontrado.' });
  res.json({ ...result.rows[0], price: money(result.rows[0].price) });
}));

app.delete('/api/products/:id', authMiddleware, managerMiddleware, asyncRoute(async (req, res) => {
  if (JSON_MODE) {
    const data = readJsonData();
    const product = data.products.find((item) => item.id === req.params.id);
    if (!product) return res.status(404).json({ error: 'Produto não encontrado.' });
    product.active = false;
    writeJsonData(data);
    return res.json({ ok: true });
  }

  const result = await pool.query(
    'UPDATE products SET active = false WHERE id = $1 RETURNING id',
    [req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Produto não encontrado.' });
  res.json({ ok: true });
}));

app.get('/api/settings', authMiddleware, asyncRoute(async (_req, res) => {
  if (JSON_MODE) {
    const data = readJsonData();
    return res.json({ ...data.settings, tableCount: data.tables.filter((table) => table.active !== false).length });
  }

  const result = await pool.query(
    `SELECT key, value FROM app_settings
      WHERE key IN ('restaurant_name', 'table_count', 'legacy_migration_data', 'allow_discount',
                    'require_waiter', 'service_fee_percent', 'service_fee_default', 'discount_limit')`
  );
  const values = Object.fromEntries(result.rows.map(({ key, value }) => [key, value]));
  const settings = {
    restaurantName: values.restaurant_name || 'Comanda',
    tableCount: Number(values.table_count) || 8,
    allowDiscount: values.allow_discount !== 'false',
    requireWaiter: values.require_waiter !== 'false',
    serviceFeePercent: Number(values.service_fee_percent ?? 10),
    serviceFeeDefault: values.service_fee_default === 'true',
    discountLimit: Math.min(100, Math.max(0, Number(values.discount_limit ?? 10)))
  };
  if (_req.user.role === 'admin' && values.legacy_migration_data) {
    try {
      settings.legacyMigration = JSON.parse(values.legacy_migration_data);
    } catch (error) {
      console.error(`Não foi possível ler os metadados da migração legada: ${error.message}`);
    }
  }
  res.json(settings);
}));

app.patch('/api/settings', authMiddleware, managerMiddleware, asyncRoute(async (req, res) => {
  const restaurantName = typeof req.body?.restaurantName === 'string'
    ? req.body.restaurantName.trim()
    : '';
  if (!restaurantName || restaurantName.length > 120) {
    return res.status(400).json({ error: 'Informe um nome de restaurante com até 120 caracteres' });
  }
  const tableCount = req.body.tableCount === undefined ? null : Number(req.body.tableCount);
  if (tableCount !== null && (!Number.isInteger(tableCount) || tableCount < 1 || tableCount > 80)) {
    return res.status(400).json({ error: 'O número de mesas deve ser um inteiro entre 1 e 80.' });
  }
  const settingValues = [
    ['allowDiscount', 'allow_discount', (value) => typeof value === 'boolean'],
    ['requireWaiter', 'require_waiter', (value) => typeof value === 'boolean'],
    ['serviceFeeDefault', 'service_fee_default', (value) => typeof value === 'boolean']
  ];
  for (const [field, , validate] of settingValues) {
    if (req.body[field] !== undefined && !validate(req.body[field])) {
      return res.status(400).json({ error: `Configuração ${field} inválida.` });
    }
  }
  const serviceFeePercent = req.body.serviceFeePercent === undefined ? null : Number(req.body.serviceFeePercent);
  if (serviceFeePercent !== null && (!Number.isFinite(serviceFeePercent) || serviceFeePercent < 0 || serviceFeePercent > 100)) {
    return res.status(400).json({ error: 'A taxa de serviço deve estar entre 0% e 100%.' });
  }
  const discountLimit = req.body.discountLimit === undefined ? null : Number(req.body.discountLimit);
  if (discountLimit !== null && (!Number.isFinite(discountLimit) || discountLimit < 0 || discountLimit > 100)) {
    return res.status(400).json({ error: 'O limite de desconto deve estar entre 0% e 100%.' });
  }
  if (discountLimit !== null && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Somente um administrador pode alterar o limite de desconto.' });
  }

  if (JSON_MODE) {
    const data = readJsonData();
    data.settings.restaurantName = restaurantName;
    for (const [field] of settingValues) {
      if (req.body[field] !== undefined) data.settings[field] = req.body[field];
    }
    if (serviceFeePercent !== null) data.settings.serviceFeePercent = serviceFeePercent;
    if (discountLimit !== null) data.settings.discountLimit = discountLimit;
    if (tableCount !== null) {
      if (data.orders.some((order) => order.status === 'open' && Number(data.tables.find((table) => table.id === order.tableId)?.number) > tableCount)) {
        return res.status(409).json({ error: 'Há comandas abertas em mesas acima do novo limite.' });
      }
      for (let number = 1; number <= Math.max(tableCount, data.tables.length); number += 1) {
        let table = data.tables.find((entry) => Number(entry.number) === number);
        if (!table && number <= tableCount) {
          table = { id: crypto.randomUUID(), number, status: 'free' };
          data.tables.push(table);
        }
        if (table) table.active = number <= tableCount;
      }
    }
    writeJsonData(data);
    return res.json({ ...data.settings, tableCount: tableCount || data.tables.filter((table) => table.active !== false).length });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (tableCount !== null) {
      const occupied = await client.query(
        `SELECT t.number FROM restaurant_tables t JOIN orders o ON o.table_id = t.id
          WHERE o.status = 'open' AND t.number > $1 LIMIT 1`,
        [tableCount]
      );
      if (occupied.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `A mesa ${occupied.rows[0].number} possui uma comanda aberta.` });
      }
      for (let number = 1; number <= tableCount; number += 1) {
        await client.query(
          'INSERT INTO restaurant_tables (id, number) VALUES ($1, $2) ON CONFLICT (number) DO UPDATE SET active = true',
          [crypto.randomUUID(), number]
        );
      }
      await client.query('UPDATE restaurant_tables SET active = false WHERE number > $1', [tableCount]);
      await client.query(
        `INSERT INTO app_settings (key, value) VALUES ('table_count', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [String(tableCount)]
      );
    }
    const result = await client.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ('restaurant_name', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
       RETURNING value AS "restaurantName"`,
      [restaurantName]
    );
    const settingsToSave = settingValues
      .filter(([field]) => req.body[field] !== undefined)
      .map(([field, key]) => [key, String(req.body[field])]);
    if (serviceFeePercent !== null) settingsToSave.push(['service_fee_percent', String(serviceFeePercent)]);
    if (discountLimit !== null) settingsToSave.push(['discount_limit', String(discountLimit)]);
    for (const [key, value] of settingsToSave) {
      await client.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, value]
      );
    }
    const [allowDiscount, requireWaiter, feePercent, feeDefault, discountLimitSetting] = await Promise.all([
      client.query("SELECT value FROM app_settings WHERE key = 'allow_discount'"),
      client.query("SELECT value FROM app_settings WHERE key = 'require_waiter'"),
      client.query("SELECT value FROM app_settings WHERE key = 'service_fee_percent'"),
      client.query("SELECT value FROM app_settings WHERE key = 'service_fee_default'"),
      client.query("SELECT value FROM app_settings WHERE key = 'discount_limit'")
    ]);
    const currentTableCount = await client.query(
      "SELECT value FROM app_settings WHERE key = 'table_count'"
    );
    await client.query('COMMIT');
    res.json({
      ...result.rows[0],
      tableCount: Number(currentTableCount.rows[0]?.value) || 8,
      allowDiscount: allowDiscount.rows[0]?.value !== 'false',
      requireWaiter: requireWaiter.rows[0]?.value !== 'false',
      serviceFeePercent: Number(feePercent.rows[0]?.value ?? 10),
      serviceFeeDefault: feeDefault.rows[0]?.value === 'true',
      discountLimit: Math.min(100, Math.max(0, Number(discountLimitSetting.rows[0]?.value ?? 10)))
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.patch('/api/products/:id/production-station', authMiddleware, managerMiddleware, asyncRoute(async (req, res) => {
  const { station } = req.body || {};
  if (!['kitchen', 'bar'].includes(station)) {
    return res.status(400).json({ error: 'Estação de produção inválida' });
  }

  if (JSON_MODE) {
    const data = readJsonData();
    const product = data.products.find((entry) => entry.id === req.params.id);
    if (!product) return res.status(404).json({ error: 'Produto não encontrado' });
    product.productionStation = station;
    writeJsonData(data);
    return res.json(product);
  }

  const result = await pool.query(
    'UPDATE products SET production_station = $1 WHERE id = $2 RETURNING id, name, production_station AS "productionStation"',
    [station, req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Produto não encontrado' });
  res.json(result.rows[0]);
}));

app.get('/api/tables', authMiddleware, asyncRoute(async (_req, res) => {
  if (JSON_MODE) return res.json(jsonGetTables());

  const result = await pool.query(
    `SELECT t.id, t.number, t.status, o.id AS "openOrderId",
            GREATEST(0, COALESCE(SUM(oi.quantity * oi.price), 0) - COALESCE(o.discount_amount, 0)
              + COALESCE(o.service_fee_amount, 0)) AS "openOrderTotal"
       FROM restaurant_tables t
       LEFT JOIN orders o ON o.table_id = t.id AND o.status = 'open'
       LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE t.active = true
      GROUP BY t.id, o.id ORDER BY t.number`
  );
  res.json(result.rows.map((table) => ({ ...table, openOrderTotal: money(table.openOrderTotal) })));
}));

app.get('/api/production', authMiddleware, asyncRoute(async (req, res) => {
  const { station } = req.query;
  if (!['kitchen', 'bar'].includes(station)) {
    return res.status(400).json({ error: 'Informe uma estação válida: kitchen ou bar' });
  }

  if (JSON_MODE) {
    const data = readJsonData();
    const items = data.orders
      .filter((order) => order.status === 'open')
      .flatMap((order) => {
        const table = data.tables.find((entry) => entry.id === order.tableId);
        return (order.items || [])
          .filter((item) => (item.productionStation || dataProductStation(data.products, item.productId)) === station)
          .map((item) => ({
            id: item.id,
            orderId: order.id,
            tableNumber: table?.number ?? null,
            waiterName: order.waiterName,
            productName: item.productName,
            quantity: Number(item.quantity),
            notes: order.notes || '',
            status: item.productionStatus || 'pending',
            createdAt: item.createdAt || order.createdAt
          }));
      })
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    return res.json(items);
  }

  const result = await pool.query(
    `SELECT oi.id, oi.order_id AS "orderId", t.number AS "tableNumber",
            o.waiter_name AS "waiterName", oi.product_name AS "productName",
            oi.quantity, o.notes, oi.production_status AS status, oi.created_at AS "createdAt"
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN restaurant_tables t ON t.id = o.table_id
      WHERE o.status = 'open' AND oi.production_station = $1
      ORDER BY oi.created_at, oi.id`,
    [station]
  );
  res.json(result.rows);
}));

app.patch('/api/production/:itemId/status', authMiddleware, asyncRoute(async (req, res) => {
  const { status } = req.body || {};
  if (!['pending', 'preparing', 'ready'].includes(status)) {
    return res.status(400).json({ error: 'Status de produção inválido' });
  }

  if (JSON_MODE) {
    const data = readJsonData();
    const item = data.orders
      .filter((order) => order.status === 'open')
      .flatMap((order) => order.items || [])
      .find((entry) => entry.id === req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Item de produção não encontrado' });
    item.productionStatus = status;
    writeJsonData(data);
    return res.json({ id: item.id, status: item.productionStatus });
  }

  const result = await pool.query(
    `UPDATE order_items oi SET production_status = $1
       FROM orders o
      WHERE oi.id = $2 AND oi.order_id = o.id AND o.status = 'open'
      RETURNING oi.id, oi.production_status AS status`,
    [status, req.params.itemId]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Item de produção não encontrado' });
  res.json(result.rows[0]);
}));

app.post('/api/orders', authMiddleware, asyncRoute(async (req, res) => {
  const { tableId, waiterName, pin } = req.body || {};
  if (typeof tableId !== 'string' || !tableId) return res.status(400).json({ error: 'Mesa obrigatória' });
  const requestedWaiterId = req.body?.waiterId === undefined ? req.user.sub : req.body.waiterId;
  if (requestedWaiterId !== null && typeof requestedWaiterId !== 'string') {
    return res.status(400).json({ error: 'Garçom inválido.' });
  }
  if (requestedWaiterId && requestedWaiterId !== req.user.sub && !['admin', 'gerente'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Você não pode abrir comanda em nome de outro usuário.' });
  }
  const assignedWaiter = requestedWaiterId ? await getUserPin(requestedWaiterId) : null;
  if (requestedWaiterId && !assignedWaiter) return res.status(404).json({ error: 'Garçom não encontrado ou inativo.' });

  if (JSON_MODE) {
    const data = readJsonData();
    if (data.settings.requireWaiter !== false && !assignedWaiter) {
      return res.status(400).json({ error: 'Identifique um garçom antes de abrir a comanda.' });
    }
    const pinCheck = assignedWaiter ? await validateUserPin(assignedWaiter.id, pin, pool, req.user.sub) : { valid: true };
    if (!pinCheck.valid) return res.status(pinCheck.limited ? 429 : 401).json({ error: pinCheck.limited ? 'Muitas tentativas de PIN. Tente novamente em 15 minutos.' : 'PIN do garçom inválido ou obrigatório.' });
    const table = data.tables.find((item) => item.id === tableId);
    if (!table) return res.status(404).json({ error: 'Mesa não encontrada' });
    if (data.orders.some((order) => order.tableId === tableId && order.status === 'open')) {
      const openOrder = data.orders.find((order) => order.tableId === tableId && order.status === 'open');
      return res.status(409).json({ error: 'Já existe uma comanda aberta para esta mesa', orderId: openOrder.id });
    }

    const id = crypto.randomUUID();
    const order = {
      id,
      tableId,
      waiterId: assignedWaiter?.id || null,
      waiterName: assignedWaiter?.name || (typeof waiterName === 'string' ? waiterName.slice(0, 120) : 'Sem garçom'),
      status: 'open',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      closedAt: null,
      items: [],
      discountAmount: 0,
      discountType: null,
      discountValue: null,
      serviceFeePercent: Number(data.settings.serviceFeePercent || 0),
      serviceFeeEnabled: data.settings.serviceFeeDefault === true,
      serviceFeeAmount: 0,
      paidTotal: 0,
      notes: ''
    };
    data.orders.push(order);
    const tableIndex = data.tables.findIndex((item) => item.id === tableId);
    if (tableIndex >= 0) data.tables[tableIndex].status = 'occupied';
    writeJsonData(data);
    return res.status(201).json({ order: jsonGetOrder(id) });
  }

  const settings = await pool.query(
    `SELECT key, value FROM app_settings
      WHERE key IN ('require_waiter', 'service_fee_percent', 'service_fee_default')`
  );
  const settingValues = Object.fromEntries(settings.rows.map((row) => [row.key, row.value]));
  if (settingValues.require_waiter !== 'false' && !assignedWaiter) {
    return res.status(400).json({ error: 'Identifique um garçom antes de abrir a comanda.' });
  }
  const pinCheck = assignedWaiter ? await validateUserPin(assignedWaiter.id, pin, pool, req.user.sub) : { valid: true };
  if (!pinCheck.valid) return res.status(pinCheck.limited ? 429 : 401).json({ error: pinCheck.limited ? 'Muitas tentativas de PIN. Tente novamente em 15 minutos.' : 'PIN do garçom inválido ou obrigatório.' });
  const table = await pool.query('SELECT id FROM restaurant_tables WHERE id = $1', [tableId]);
  if (!table.rowCount) return res.status(404).json({ error: 'Mesa não encontrada' });

  const id = crypto.randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO orders (id, table_id, waiter_id, waiter_name, status, service_fee_percent, service_fee_enabled)
       VALUES ($1, $2, $3, $4, 'open', $5, $6)`,
      [id, tableId, assignedWaiter?.id || null, assignedWaiter?.name || (typeof waiterName === 'string' ? waiterName.slice(0, 120) : 'Sem garçom'),
        Number(settingValues.service_fee_percent || 0), settingValues.service_fee_default === 'true']
    );
    await client.query("UPDATE restaurant_tables SET status = 'occupied' WHERE id = $1", [tableId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      const existing = await pool.query("SELECT id FROM orders WHERE table_id = $1 AND status = 'open'", [tableId]);
      return res.status(409).json({ error: 'Já existe uma comanda aberta para esta mesa', orderId: existing.rows[0]?.id });
    }
    throw error;
  } finally {
    client.release();
  }

  res.status(201).json({ order: await getOrder(id) });
}));

app.get('/api/orders/:id', authMiddleware, asyncRoute(async (req, res) => {
  const order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Comanda não encontrada' });
  res.json(order);
}));

app.post('/api/orders/:id/items', authMiddleware, asyncRoute(async (req, res) => {
  const { productId, quantity = 1 } = req.body || {};
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty <= 0 || qty > 999) return res.status(400).json({ error: 'Quantidade inválida' });

  if (JSON_MODE) {
    const data = readJsonData();
    const order = data.orders.find((item) => item.id === req.params.id && item.status === 'open');
    if (!order) return res.status(400).json({ error: 'Comanda inválida ou fechada' });
    const product = data.products.find((item) => item.id === productId && item.active);
    if (!product) return res.status(404).json({ error: 'Produto não encontrado' });
    const existingItem = order.items.find((item) => item.productId === productId);
    if (existingItem) {
      existingItem.quantity = Number(existingItem.quantity) + qty;
      existingItem.price = Number(product.price);
    } else {
      order.items.push({
        id: crypto.randomUUID(),
        productId: product.id,
        productName: product.name,
        productionStation: dataProductStation(data.products, product.id),
        productionStatus: 'pending',
        quantity: qty,
        price: Number(product.price)
      });
    }
    if (existingItem) {
      existingItem.productionStation = dataProductStation(data.products, product.id);
      existingItem.productionStatus = 'pending';
    }
    order.updatedAt = new Date().toISOString();
    recalculateJsonServiceFee(order);
    writeJsonData(data);
    return res.json(jsonGetOrder(req.params.id));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query("SELECT id FROM orders WHERE id = $1 AND status = 'open' FOR UPDATE", [req.params.id]);
    if (!orderResult.rowCount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Comanda inválida ou fechada' });
    }
    const productResult = await client.query('SELECT id, name, price, production_station FROM products WHERE id = $1 AND active = true', [productId]);
    if (!productResult.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Produto não encontrado' });
    }
    const product = productResult.rows[0];
    await client.query(
      `INSERT INTO order_items (id, order_id, product_id, product_name, production_station, quantity, price)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (order_id, product_id)
       DO UPDATE SET quantity = order_items.quantity + EXCLUDED.quantity, price = EXCLUDED.price,
                     production_station = EXCLUDED.production_station, production_status = 'pending'`,
      [crypto.randomUUID(), req.params.id, product.id, product.name, product.production_station, qty, product.price]
    );
    await recalculatePostgresServiceFee(client, req.params.id);
    await client.query('UPDATE orders SET updated_at = now() WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');
    res.json(await getOrder(req.params.id));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.delete('/api/orders/:id/items/:itemId', authMiddleware, asyncRoute(async (req, res) => {
  if (JSON_MODE) {
    const data = readJsonData();
    const order = data.orders.find((item) => item.id === req.params.id && item.status === 'open');
    if (!order) return res.status(404).json({ error: 'Item não encontrado ou comanda fechada' });
    const index = order.items.findIndex((item) => item.id === req.params.itemId);
    if (index < 0) return res.status(404).json({ error: 'Item não encontrado ou comanda fechada' });
    const item = order.items[index];
    if (allocatedItemQuantity(data.payments.filter((payment) => payment.orderId === order.id), item.id) > 0) {
      return res.status(409).json({ error: 'Não é possível remover um item que já foi pago; estorne o pagamento primeiro.' });
    }
    const subtotal = order.items.reduce((sum, entry) => sum + Number(entry.quantity) * Number(entry.price), 0);
    const projectedSubtotal = subtotal - Number(item.quantity) * Number(item.price);
    const projectedFee = calculateServiceFee(
      projectedSubtotal, Number(order.discountAmount || 0), Number(order.serviceFeePercent || 0), order.serviceFeeEnabled === true
    );
    if (Number(order.paidTotal || 0) > Math.max(0, projectedSubtotal - Number(order.discountAmount || 0) + projectedFee) + 0.001) {
      return res.status(409).json({ error: 'O novo total ficaria abaixo do valor já pago; estorne o pagamento primeiro.' });
    }
    order.items.splice(index, 1);
    order.updatedAt = new Date().toISOString();
    recalculateJsonServiceFee(order);
    writeJsonData(data);
    return res.json(jsonGetOrder(req.params.id));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const order = await client.query(
      `SELECT paid_total, discount_amount, service_fee_percent, service_fee_enabled
         FROM orders WHERE id = $1 AND status = 'open' FOR UPDATE`,
      [req.params.id]
    );
    const item = await client.query(
      'SELECT id, quantity, price FROM order_items WHERE id = $1 AND order_id = $2',
      [req.params.itemId, req.params.id]
    );
    if (!order.rowCount || !item.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Item não encontrado ou comanda fechada' });
    }
    const paymentHistory = await client.query(
      "SELECT details, status FROM payments WHERE order_id = $1 AND status = 'paid'",
      [req.params.id]
    );
    if (allocatedItemQuantity(paymentHistory.rows, item.rows[0].id) > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Não é possível remover um item que já foi pago; estorne o pagamento primeiro.' });
    }
    const subtotalResult = await client.query(
      'SELECT COALESCE(SUM(quantity * price), 0) AS subtotal FROM order_items WHERE order_id = $1',
      [req.params.id]
    );
    const projectedSubtotal = Number(subtotalResult.rows[0].subtotal)
      - Number(item.rows[0].quantity) * Number(item.rows[0].price);
    const projectedFee = calculateServiceFee(
      projectedSubtotal, Number(order.rows[0].discount_amount), Number(order.rows[0].service_fee_percent),
      order.rows[0].service_fee_enabled
    );
    if (Number(order.rows[0].paid_total) > Math.max(0, projectedSubtotal - Number(order.rows[0].discount_amount) + projectedFee) + 0.001) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'O novo total ficaria abaixo do valor já pago; estorne o pagamento primeiro.' });
    }
    await client.query('DELETE FROM order_items WHERE id = $1 AND order_id = $2', [req.params.itemId, req.params.id]);
    await recalculatePostgresServiceFee(client, req.params.id);
    await client.query('COMMIT');
    res.json(await getOrder(req.params.id));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.patch('/api/orders/:id/items/:itemId', authMiddleware, asyncRoute(async (req, res) => {
  const quantity = Number(req.body?.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 999) return res.status(400).json({ error: 'Quantidade inválida' });

  if (JSON_MODE) {
    const data = readJsonData();
    const order = data.orders.find((item) => item.id === req.params.id && item.status === 'open');
    if (!order) return res.status(404).json({ error: 'Item não encontrado ou comanda fechada' });
    const item = order.items.find((entry) => entry.id === req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Item não encontrado ou comanda fechada' });
    const paidQuantity = allocatedItemQuantity(data.payments.filter((payment) => payment.orderId === order.id), item.id);
    if (quantity < paidQuantity) {
      return res.status(409).json({ error: 'A quantidade não pode ser menor do que os itens já pagos.' });
    }
    const subtotal = order.items.reduce((sum, entry) => sum + Number(entry.quantity) * Number(entry.price), 0);
    const projectedSubtotal = subtotal + (quantity - Number(item.quantity)) * Number(item.price);
    const projectedFee = calculateServiceFee(
      projectedSubtotal, Number(order.discountAmount || 0), Number(order.serviceFeePercent || 0), order.serviceFeeEnabled === true
    );
    if (Number(order.paidTotal || 0) > Math.max(0, projectedSubtotal - Number(order.discountAmount || 0) + projectedFee) + 0.001) {
      return res.status(409).json({ error: 'O novo total ficaria abaixo do valor já pago; estorne o pagamento primeiro.' });
    }
    item.quantity = quantity;
    item.productionStatus = 'pending';
    order.updatedAt = new Date().toISOString();
    recalculateJsonServiceFee(order);
    writeJsonData(data);
    return res.json(jsonGetOrder(req.params.id));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const order = await client.query(
      `SELECT paid_total, discount_amount, service_fee_percent, service_fee_enabled
         FROM orders WHERE id = $1 AND status = 'open' FOR UPDATE`,
      [req.params.id]
    );
    const item = await client.query(
      'SELECT id, quantity, price FROM order_items WHERE id = $1 AND order_id = $2',
      [req.params.itemId, req.params.id]
    );
    if (!order.rowCount || !item.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Item não encontrado ou comanda fechada' });
    }
    const paymentHistory = await client.query(
      "SELECT details, status FROM payments WHERE order_id = $1 AND status = 'paid'",
      [req.params.id]
    );
    const paidQuantity = allocatedItemQuantity(paymentHistory.rows, item.rows[0].id);
    if (quantity < paidQuantity) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'A quantidade não pode ser menor do que os itens já pagos.' });
    }
    const subtotalResult = await client.query(
      'SELECT COALESCE(SUM(quantity * price), 0) AS subtotal FROM order_items WHERE order_id = $1',
      [req.params.id]
    );
    const projectedSubtotal = Number(subtotalResult.rows[0].subtotal)
      + (quantity - Number(item.rows[0].quantity)) * Number(item.rows[0].price);
    const projectedFee = calculateServiceFee(
      projectedSubtotal, Number(order.rows[0].discount_amount), Number(order.rows[0].service_fee_percent),
      order.rows[0].service_fee_enabled
    );
    if (Number(order.rows[0].paid_total) > Math.max(0, projectedSubtotal - Number(order.rows[0].discount_amount) + projectedFee) + 0.001) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'O novo total ficaria abaixo do valor já pago; estorne o pagamento primeiro.' });
    }
    await client.query(
      `UPDATE order_items SET quantity = $1, production_status = 'pending'
        WHERE id = $2 AND order_id = $3`,
      [quantity, req.params.itemId, req.params.id]
    );
    await recalculatePostgresServiceFee(client, req.params.id);
    await client.query('COMMIT');
    res.json(await getOrder(req.params.id));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/orders/:id/discount', authMiddleware, asyncRoute(async (req, res) => {
  const { type, value, authorizationUserId, authorizationPin } = req.body || {};
  const discount = Number(value);
  if (!Number.isFinite(discount) || discount < 0 || (type !== 'percent' && type !== 'value') || (type === 'percent' && discount > 100)) {
    return res.status(400).json({ error: 'Desconto inválido' });
  }

  if (JSON_MODE) {
    const data = readJsonData();
    const settings = data.settings;
    const order = data.orders.find((item) => item.id === req.params.id && item.status === 'open');
    if (!order) return res.status(400).json({ error: 'Comanda inválida ou fechada' });
    if (!settings.allowDiscount) return res.status(403).json({ error: 'Descontos estão desativados nas configurações.' });
    const subtotal = (order.items || []).reduce((sum, item) => sum + Number(item.quantity) * Number(item.price), 0);
    const amount = Math.min(type === 'percent' ? subtotal * discount / 100 : discount, subtotal);
    const discountPercent = subtotal > 0 ? amount / subtotal * 100 : 0;
    let authorizer = req.user;
    if (req.user.role !== 'admin' && discountPercent > settings.discountLimit + 0.0001) {
      const pinCheck = authorizationUserId
        ? await validateUserPin(authorizationUserId, authorizationPin, pool, req.user.sub)
        : { valid: false, user: null };
      if (!pinCheck.valid || pinCheck.user?.role !== 'admin') {
        addJsonAudit(data, req.user, 'discount_denied', { orderId: order.id, percent: discountPercent });
        writeJsonData(data);
        return res.status(pinCheck.limited ? 429 : 403).json({
          error: pinCheck.limited ? 'Muitas tentativas de PIN. Tente novamente em 15 minutos.'
            : `Desconto acima do limite de ${settings.discountLimit}% exige autorização de um administrador.`
        });
      }
      authorizer = { sub: pinCheck.user.id, name: pinCheck.user.name };
    }
    order.discountAmount = money(amount);
    order.discountType = type;
    order.discountValue = discount;
    order.discountAuth = authorizer.sub === req.user.sub ? null : {
      userId: authorizer.sub, name: authorizer.name, at: new Date().toISOString(), percent: discountPercent
    };
    order.serviceFeeAmount = calculateServiceFee(
      subtotal, order.discountAmount, Number(order.serviceFeePercent || 0), order.serviceFeeEnabled === true
    );
    order.updatedAt = new Date().toISOString();
    if (order.discountAuth) addJsonAudit(data, authorizer, 'discount_authorized', { orderId: order.id, percent: discountPercent });
    writeJsonData(data);
    return res.json(jsonGetOrder(req.params.id));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const order = await client.query(
      `SELECT id, discount_amount, service_fee_percent, service_fee_enabled
         FROM orders WHERE id = $1 AND status = 'open' FOR UPDATE`,
      [req.params.id]
    );
    if (!order.rowCount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Comanda inválida ou fechada' });
    }
    const settings = await getOperationalSettings(client);
    if (!settings.allowDiscount) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Descontos estão desativados nas configurações.' });
    }
    const subtotalResult = await client.query('SELECT COALESCE(SUM(quantity * price), 0) AS subtotal FROM order_items WHERE order_id = $1', [req.params.id]);
    const subtotal = Number(subtotalResult.rows[0].subtotal);
    const amount = Math.min(type === 'percent' ? subtotal * discount / 100 : discount, subtotal);
    const discountPercent = subtotal > 0 ? amount / subtotal * 100 : 0;
    let authorizer = req.user;
    if (req.user.role !== 'admin' && discountPercent > settings.discountLimit + 0.0001) {
      const pinCheck = authorizationUserId
        ? await validateUserPin(authorizationUserId, authorizationPin, client, req.user.sub)
        : { valid: false, user: null };
      if (!pinCheck.valid || pinCheck.user?.role !== 'admin') {
        await addAuditEvent(client, req.user, 'discount_denied', { orderId: req.params.id, percent: discountPercent });
        await client.query('COMMIT');
        return res.status(pinCheck.limited ? 429 : 403).json({
          error: pinCheck.limited ? 'Muitas tentativas de PIN. Tente novamente em 15 minutos.'
            : `Desconto acima do limite de ${settings.discountLimit}% exige autorização de um administrador.`
        });
      }
      authorizer = { sub: pinCheck.user.id, name: pinCheck.user.name };
    }
    const serviceFeeAmount = calculateServiceFee(
      subtotal, amount, Number(order.rows[0].service_fee_percent), order.rows[0].service_fee_enabled
    );
    await client.query(
      `UPDATE orders SET discount_amount = $1, discount_type = $2, discount_value = $3,
                         discount_authorized_by = $4, discount_authorized_at = $5,
                         service_fee_amount = $6, updated_at = now()
        WHERE id = $7`,
      [money(amount), type, discount, authorizer.sub === req.user.sub ? null : authorizer.sub,
        authorizer.sub === req.user.sub ? null : new Date(), serviceFeeAmount, req.params.id]
    );
    if (authorizer.sub !== req.user.sub) {
      await addAuditEvent(client, authorizer, 'discount_authorized', { orderId: req.params.id, percent: discountPercent });
    }
    await client.query('COMMIT');
    res.json(await getOrder(req.params.id));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/orders/:id/service-fee', authMiddleware, asyncRoute(async (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'Informe se a taxa de serviço deve ser aplicada.' });

  if (JSON_MODE) {
    const data = readJsonData();
    const order = data.orders.find((item) => item.id === req.params.id && item.status === 'open');
    if (!order) return res.status(404).json({ error: 'Comanda aberta não encontrada.' });
    const settings = data.settings;
    order.serviceFeeEnabled = enabled;
    order.serviceFeePercent = Number(settings.serviceFeePercent || 0);
    const subtotal = (order.items || []).reduce((sum, item) => sum + Number(item.quantity) * Number(item.price), 0);
    order.serviceFeeAmount = calculateServiceFee(subtotal, Number(order.discountAmount || 0), order.serviceFeePercent, enabled);
    order.updatedAt = new Date().toISOString();
    writeJsonData(data);
    return res.json(jsonGetOrder(order.id));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const order = await client.query(
      `SELECT id, discount_amount FROM orders WHERE id = $1 AND status = 'open' FOR UPDATE`,
      [req.params.id]
    );
    if (!order.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Comanda aberta não encontrada.' });
    }
    const settings = await getOperationalSettings(client);
    const subtotal = await client.query(
      'SELECT COALESCE(SUM(quantity * price), 0) AS subtotal FROM order_items WHERE order_id = $1',
      [req.params.id]
    );
    const amount = calculateServiceFee(
      Number(subtotal.rows[0].subtotal), Number(order.rows[0].discount_amount),
      settings.serviceFeePercent, enabled
    );
    await client.query(
      `UPDATE orders SET service_fee_enabled = $1, service_fee_percent = $2,
                         service_fee_amount = $3, updated_at = now() WHERE id = $4`,
      [enabled, settings.serviceFeePercent, amount, req.params.id]
    );
    await client.query('COMMIT');
    res.json(await getOrder(req.params.id));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/orders/:id/pay', authMiddleware, asyncRoute(async (req, res) => {
  const { method, amount, received, items = null, split = null } = req.body || {};
  const incoming = Number(amount);
  const allowedMethods = ['dinheiro', 'pix', 'debito', 'credito'];
  if ((!Array.isArray(items) && (!Number.isFinite(incoming) || incoming <= 0))
    || (Array.isArray(items) && (!items.length || items.some((entry) => !entry || typeof entry.itemId !== 'string'
      || !Number.isInteger(Number(entry.quantity)) || Number(entry.quantity) <= 0)))
    || !allowedMethods.includes(method)) {
    return res.status(400).json({ error: 'Pagamento inválido' });
  }

  if (JSON_MODE) {
    const data = readJsonData();
    const order = data.orders.find((item) => item.id === req.params.id && item.status === 'open');
    if (!order) return res.status(400).json({ error: 'Comanda inválida ou fechada' });
    const subtotal = (order.items || []).reduce((sum, item) => sum + Number(item.quantity) * Number(item.price), 0);
    const total = Math.max(0, subtotal - Number(order.discountAmount || 0) + Number(order.serviceFeeAmount || 0));
    const remaining = Math.max(0, total - Number(order.paidTotal || 0));
    let itemDetails = [];
    let requestedAmount = incoming;
    if (Array.isArray(items)) {
      const previousAllocations = data.payments
        .filter((payment) => payment.orderId === order.id && payment.status !== 'reversed')
        .flatMap((payment) => payment.details?.items || []);
      const factor = subtotal > 0 ? total / subtotal : 1;
      itemDetails = [];
      requestedAmount = 0;
      for (const allocation of items) {
        const item = order.items.find((entry) => entry.id === allocation.itemId);
        const quantity = Number(allocation.quantity);
        const alreadyPaid = previousAllocations
          .filter((entry) => entry.itemId === allocation.itemId)
          .reduce((sum, entry) => sum + Number(entry.quantity), 0);
        if (!item || quantity > Number(item.quantity) - alreadyPaid) {
          return res.status(409).json({ error: 'A quantidade selecionada já foi paga ou não pertence à comanda.' });
        }
        requestedAmount += Number(item.price) * quantity * factor;
        itemDetails.push({ itemId: item.id, productName: item.productName, quantity });
      }
    }
    const paidAmount = money(Math.min(requestedAmount, remaining));
    if (paidAmount <= 0) return res.status(400).json({ error: 'Comanda já está totalmente paga' });

    const payment = {
      id: crypto.randomUUID(),
      orderId: order.id,
      method,
      amount: paidAmount,
      received: Number.isFinite(Number(received)) && Number(received) > 0 ? Number(received) : null,
      createdAt: new Date().toISOString(),
      details: { items: itemDetails, split: split && typeof split === 'object' ? split : null },
      status: 'paid'
    };
    data.payments.push(payment);
    order.paidTotal = money(Number(order.paidTotal || 0) + paidAmount);
    order.updatedAt = new Date().toISOString();
    writeJsonData(data);
    return res.json({ payment, order: jsonGetOrder(req.params.id) });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query("SELECT id, paid_total FROM orders WHERE id = $1 AND status = 'open' FOR UPDATE", [req.params.id]);
    if (!orderResult.rowCount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Comanda inválida ou fechada' });
    }
    const totals = await client.query(
      'SELECT COALESCE(SUM(quantity * price), 0) AS subtotal FROM order_items WHERE order_id = $1',
      [req.params.id]
    );
    const orderTotals = await client.query('SELECT discount_amount, service_fee_amount FROM orders WHERE id = $1', [req.params.id]);
    const total = Math.max(0, Number(totals.rows[0].subtotal) - Number(orderTotals.rows[0].discount_amount)
      + Number(orderTotals.rows[0].service_fee_amount));
    const remaining = Math.max(0, total - Number(orderResult.rows[0].paid_total));
    let itemDetails = [];
    let requestedAmount = incoming;
    if (Array.isArray(items)) {
      const itemResult = await client.query(
        'SELECT id, product_name AS "productName", quantity, price FROM order_items WHERE order_id = $1',
        [req.params.id]
      );
      const paymentHistory = await client.query(
        `SELECT details FROM payments WHERE order_id = $1 AND status = 'paid'`,
        [req.params.id]
      );
      const previousAllocations = paymentHistory.rows.flatMap((payment) => payment.details?.items || []);
      const factor = Number(totals.rows[0].subtotal) > 0
        ? total / Number(totals.rows[0].subtotal)
        : 1;
      const byId = new Map(itemResult.rows.map((item) => [item.id, item]));
      itemDetails = [];
      requestedAmount = 0;
      for (const allocation of items) {
        const item = byId.get(allocation.itemId);
        const quantity = Number(allocation.quantity);
        const alreadyPaid = previousAllocations
          .filter((entry) => entry.itemId === allocation.itemId)
          .reduce((sum, entry) => sum + Number(entry.quantity), 0);
        if (!item || quantity > Number(item.quantity) - alreadyPaid) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'A quantidade selecionada já foi paga ou não pertence à comanda.' });
        }
        requestedAmount += Number(item.price) * quantity * factor;
        itemDetails.push({ itemId: item.id, productName: item.productName, quantity });
      }
    }
    const paidAmount = money(Math.min(requestedAmount, remaining));
    if (paidAmount <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Comanda já está totalmente paga' });
    }
    const paymentId = crypto.randomUUID();
    const paymentResult = await client.query(
      `INSERT INTO payments (id, order_id, method, amount, received, details)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id, order_id AS "orderId", method, amount, received, details, created_at AS "createdAt", status`,
      [paymentId, req.params.id, method, paidAmount,
        Number.isFinite(Number(received)) && Number(received) > 0 ? Number(received) : null,
        JSON.stringify({ items: itemDetails, split: split && typeof split === 'object' ? split : null })]
    );
    await client.query('UPDATE orders SET paid_total = paid_total + $1, updated_at = now() WHERE id = $2', [paidAmount, req.params.id]);
    await client.query('COMMIT');
    res.json({ payment: paymentResult.rows[0], order: await getOrder(req.params.id) });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/orders/:id/close', authMiddleware, asyncRoute(async (req, res) => {
  if (JSON_MODE) {
    const data = readJsonData();
    const order = data.orders.find((item) => item.id === req.params.id && item.status === 'open');
    if (!order) return res.status(404).json({ error: 'Comanda aberta não encontrada' });
    const subtotal = (order.items || []).reduce((sum, item) => sum + Number(item.quantity) * Number(item.price), 0);
    if (subtotal - Number(order.discountAmount || 0) + Number(order.serviceFeeAmount || 0) > Number(order.paidTotal || 0) + 0.001) {
      return res.status(400).json({ error: 'Pagamento pendente' });
    }
    order.status = 'closed';
    order.closedAt = new Date().toISOString();
    order.updatedAt = new Date().toISOString();
    const table = data.tables.find((item) => item.id === order.tableId);
    if (table) table.status = 'free';
    writeJsonData(data);
    return res.json({ order: jsonGetOrder(req.params.id) });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query("SELECT id, paid_total, discount_amount, service_fee_amount FROM orders WHERE id = $1 AND status = 'open' FOR UPDATE", [req.params.id]);
    if (!orderResult.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Comanda aberta não encontrada' });
    }
    const subtotal = await client.query('SELECT COALESCE(SUM(quantity * price), 0) AS subtotal FROM order_items WHERE order_id = $1', [req.params.id]);
    const order = orderResult.rows[0];
    if (Number(subtotal.rows[0].subtotal) - Number(order.discount_amount) + Number(order.service_fee_amount) > Number(order.paid_total) + 0.001) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Pagamento pendente' });
    }
    await client.query("UPDATE orders SET status = 'closed', closed_at = now(), updated_at = now() WHERE id = $1", [req.params.id]);
    await client.query('UPDATE restaurant_tables SET status = \'free\' WHERE id = (SELECT table_id FROM orders WHERE id = $1)', [req.params.id]);
    await client.query('COMMIT');
    res.json({ order: await getOrder(req.params.id) });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/orders/:id/transfer', authMiddleware, asyncRoute(async (req, res) => {
  const { tableId } = req.body || {};
  if (typeof tableId !== 'string' || !tableId) return res.status(400).json({ error: 'Mesa de destino obrigatória.' });

  if (JSON_MODE) {
    const data = readJsonData();
    const order = data.orders.find((item) => item.id === req.params.id && item.status === 'open');
    const destination = data.tables.find((table) => table.id === tableId && table.active !== false);
    if (!order) return res.status(404).json({ error: 'Comanda aberta não encontrada.' });
    if (!destination) return res.status(404).json({ error: 'Mesa de destino não encontrada.' });
    if (order.tableId === tableId) return res.status(400).json({ error: 'A comanda já está nessa mesa.' });
    if (data.orders.some((item) => item.status === 'open' && item.tableId === tableId)) {
      return res.status(409).json({ error: 'A mesa de destino já possui uma comanda aberta.' });
    }
    const sourceTable = data.tables.find((table) => table.id === order.tableId);
    order.tableId = tableId;
    order.updatedAt = new Date().toISOString();
    if (sourceTable) sourceTable.status = 'free';
    destination.status = 'occupied';
    addJsonAudit(data, req.user, 'table_transferred', { orderId: order.id, tableId });
    writeJsonData(data);
    return res.json(jsonGetOrder(order.id));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const order = await client.query(
      `SELECT id, table_id AS "tableId" FROM orders WHERE id = $1 AND status = 'open' FOR UPDATE`,
      [req.params.id]
    );
    if (!order.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Comanda aberta não encontrada.' });
    }
    if (order.rows[0].tableId === tableId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'A comanda já está nessa mesa.' });
    }
    const destination = await client.query(
      'SELECT id FROM restaurant_tables WHERE id = $1 AND active = true FOR UPDATE',
      [tableId]
    );
    if (!destination.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Mesa de destino não encontrada.' });
    }
    const occupied = await client.query("SELECT id FROM orders WHERE table_id = $1 AND status = 'open'", [tableId]);
    if (occupied.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'A mesa de destino já possui uma comanda aberta.' });
    }
    await client.query('UPDATE orders SET table_id = $1, updated_at = now() WHERE id = $2', [tableId, req.params.id]);
    await client.query("UPDATE restaurant_tables SET status = 'free' WHERE id = $1", [order.rows[0].tableId]);
    await client.query("UPDATE restaurant_tables SET status = 'occupied' WHERE id = $1", [tableId]);
    await addAuditEvent(client, req.user, 'table_transferred', { orderId: req.params.id, tableId });
    await client.query('COMMIT');
    res.json(await getOrder(req.params.id));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/orders/:id/merge', authMiddleware, asyncRoute(async (req, res) => {
  const { sourceOrderId } = req.body || {};
  if (typeof sourceOrderId !== 'string' || !sourceOrderId || sourceOrderId === req.params.id) {
    return res.status(400).json({ error: 'Informe outra comanda aberta para juntar.' });
  }

  if (JSON_MODE) {
    const data = readJsonData();
    const survivor = data.orders.find((item) => item.id === req.params.id && item.status === 'open');
    const source = data.orders.find((item) => item.id === sourceOrderId && item.status === 'open');
    if (!survivor || !source) return res.status(404).json({ error: 'As duas comandas precisam estar abertas.' });
    const sourceSubtotal = source.items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.price), 0);
    const sourceTableId = source.tableId;
    const itemsByProduct = new Map(survivor.items.map((item) => [item.productId, item]));
    for (const item of source.items) {
      const existing = itemsByProduct.get(item.productId);
      if (existing) existing.quantity = Number(existing.quantity) + Number(item.quantity);
      else {
        const copy = { ...item, id: crypto.randomUUID() };
        survivor.items.push(copy);
        itemsByProduct.set(copy.productId, copy);
      }
    }
    const movedPayments = data.payments.filter((payment) => payment.orderId === source.id);
    movedPayments.forEach((payment) => { payment.orderId = survivor.id; });
    const survivorSubtotal = survivor.items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.price), 0);
    survivor.discountAmount = money(Math.min(
      survivorSubtotal,
      Number(survivor.discountAmount || 0) + Number(source.discountAmount || 0)
    ));
    survivor.serviceFeeAmount = money(Number(survivor.serviceFeeAmount || 0) + Number(source.serviceFeeAmount || 0));
    survivor.serviceFeeEnabled = false;
    survivor.serviceFeePercent = 0;
    survivor.paidTotal = money(Number(survivor.paidTotal || 0) + Number(source.paidTotal || 0));
    survivor.updatedAt = new Date().toISOString();
    source.status = 'cancelled';
    source.mergedIntoOrderId = survivor.id;
    source.cancellationReason = `Comanda unida à comanda ${survivor.id}.`;
    source.cancelledAt = new Date().toISOString();
    const sourceTable = data.tables.find((table) => table.id === sourceTableId);
    if (sourceTable) sourceTable.status = 'free';
    addJsonAudit(data, req.user, 'orders_merged', { survivorOrderId: survivor.id, sourceOrderId: source.id, sourceSubtotal });
    writeJsonData(data);
    return res.json(jsonGetOrder(survivor.id));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orders = await client.query(
      `SELECT id, table_id AS "tableId", discount_amount, service_fee_amount, paid_total
         FROM orders WHERE id = ANY($1::uuid[]) AND status = 'open' ORDER BY id FOR UPDATE`,
      [[req.params.id, sourceOrderId]]
    );
    if (orders.rowCount !== 2) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'As duas comandas precisam estar abertas.' });
    }
    const survivor = orders.rows.find((order) => order.id === req.params.id);
    const source = orders.rows.find((order) => order.id === sourceOrderId);
    const sourceItems = await client.query('SELECT * FROM order_items WHERE order_id = $1', [sourceOrderId]);
    for (const item of sourceItems.rows) {
      await client.query(
        `INSERT INTO order_items (id, order_id, product_id, product_name, production_station,
                                  quantity, price, production_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (order_id, product_id)
         DO UPDATE SET quantity = order_items.quantity + EXCLUDED.quantity,
                       production_status = CASE
                         WHEN order_items.production_status = 'pending' OR EXCLUDED.production_status = 'pending' THEN 'pending'
                         WHEN order_items.production_status = 'preparing' OR EXCLUDED.production_status = 'preparing' THEN 'preparing'
                         ELSE 'ready' END`,
        [crypto.randomUUID(), survivor.id, item.product_id, item.product_name, item.production_station,
          item.quantity, item.price, item.production_status]
      );
    }
    await client.query('UPDATE payments SET order_id = $1 WHERE order_id = $2', [survivor.id, source.id]);
    const totals = await client.query(
      'SELECT COALESCE(SUM(quantity * price), 0) AS subtotal FROM order_items WHERE order_id = $1',
      [survivor.id]
    );
    const discount = money(Math.min(Number(totals.rows[0].subtotal),
      Number(survivor.discount_amount) + Number(source.discount_amount)));
    await client.query(
      `UPDATE orders SET discount_amount = $1, discount_type = 'value', discount_value = $1,
                         service_fee_amount = service_fee_amount + $2,
                         service_fee_enabled = false, service_fee_percent = 0,
                         paid_total = paid_total + $3, updated_at = now()
        WHERE id = $4`,
      [discount, source.service_fee_amount, source.paid_total, survivor.id]
    );
    await client.query(
      `UPDATE orders SET status = 'cancelled', merged_into_order_id = $1, cancelled_at = now(),
                         cancelled_by = $2, cancellation_reason = $3, updated_at = now()
        WHERE id = $4`,
      [survivor.id, req.user.sub, `Comanda unida à comanda ${survivor.id}.`, source.id]
    );
    await client.query("UPDATE restaurant_tables SET status = 'free' WHERE id = $1", [source.tableId]);
    await client.query("UPDATE restaurant_tables SET status = 'occupied' WHERE id = $1", [survivor.tableId]);
    await addAuditEvent(client, req.user, 'orders_merged', { survivorOrderId: survivor.id, sourceOrderId: source.id });
    await client.query('COMMIT');
    res.json(await getOrder(survivor.id));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/orders/:id/cancel', authMiddleware, asyncRoute(async (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
  if (!reason) return res.status(400).json({ error: 'Informe o motivo do cancelamento.' });

  if (JSON_MODE) {
    const data = readJsonData();
    const order = data.orders.find((item) => item.id === req.params.id && item.status === 'open');
    if (!order) return res.status(404).json({ error: 'Comanda aberta não encontrada.' });
    if (Number(order.paidTotal || 0) > 0) return res.status(409).json({ error: 'Estorne os pagamentos antes de cancelar a comanda.' });
    order.status = 'cancelled';
    order.cancelledAt = new Date().toISOString();
    order.cancelledBy = req.user.sub;
    order.cancellationReason = reason;
    order.updatedAt = order.cancelledAt;
    const table = data.tables.find((item) => item.id === order.tableId);
    if (table) table.status = 'free';
    addJsonAudit(data, req.user, 'order_cancelled', { orderId: order.id, reason });
    writeJsonData(data);
    return res.json({ ok: true, order: jsonGetOrder(order.id) });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const order = await client.query(
      `SELECT id, table_id AS "tableId", paid_total FROM orders
        WHERE id = $1 AND status = 'open' FOR UPDATE`,
      [req.params.id]
    );
    if (!order.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Comanda aberta não encontrada.' });
    }
    if (Number(order.rows[0].paid_total) > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Estorne os pagamentos antes de cancelar a comanda.' });
    }
    await client.query(
      `UPDATE orders SET status = 'cancelled', cancelled_at = now(), cancelled_by = $1,
                         cancellation_reason = $2, updated_at = now() WHERE id = $3`,
      [req.user.sub, reason, req.params.id]
    );
    await client.query("UPDATE restaurant_tables SET status = 'free' WHERE id = $1", [order.rows[0].tableId]);
    await addAuditEvent(client, req.user, 'order_cancelled', { orderId: req.params.id, reason });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/orders/:id/payments/:paymentId/reverse', authMiddleware, managerMiddleware, asyncRoute(async (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
  if (!reason) return res.status(400).json({ error: 'Informe o motivo do estorno.' });

  if (JSON_MODE) {
    const data = readJsonData();
    const payment = data.payments.find((item) => item.id === req.params.paymentId && item.orderId === req.params.id);
    const order = data.orders.find((item) => item.id === req.params.id);
    if (!payment || !order) return res.status(404).json({ error: 'Pagamento não encontrado.' });
    if (payment.status === 'reversed') return res.status(409).json({ error: 'Pagamento já estornado.' });
    payment.status = 'reversed';
    payment.reversedAt = new Date().toISOString();
    payment.reversedBy = req.user.sub;
    payment.reversalReason = reason;
    order.paidTotal = money(Math.max(0, Number(order.paidTotal || 0) - Number(payment.amount)));
    order.updatedAt = payment.reversedAt;
    addJsonAudit(data, req.user, 'payment_reversed', { orderId: order.id, paymentId: payment.id, amount: payment.amount, reason });
    writeJsonData(data);
    return res.json({ ok: true, order: jsonGetOrder(order.id) });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const payment = await client.query(
      `SELECT id, amount FROM payments
        WHERE id = $1 AND order_id = $2 AND status = 'paid' FOR UPDATE`,
      [req.params.paymentId, req.params.id]
    );
    const order = await client.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!payment.rowCount || !order.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pagamento não encontrado ou já estornado.' });
    }
    await client.query("UPDATE payments SET status = 'reversed', details = details || $1::jsonb WHERE id = $2", [
      JSON.stringify({ reversalReason: reason, reversedBy: req.user.sub, reversedAt: new Date().toISOString() }),
      req.params.paymentId
    ]);
    await client.query(
      'UPDATE orders SET paid_total = GREATEST(0, paid_total - $1), updated_at = now() WHERE id = $2',
      [payment.rows[0].amount, req.params.id]
    );
    await addAuditEvent(client, req.user, 'payment_reversed', {
      orderId: req.params.id, paymentId: req.params.paymentId, amount: Number(payment.rows[0].amount), reason
    });
    await client.query('COMMIT');
    res.json({ ok: true, order: await getOrder(req.params.id) });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.get('/api/history', authMiddleware, asyncRoute(async (_req, res) => {
  if (JSON_MODE) {
    const data = readJsonData();
    const history = data.orders.filter((order) => order.status === 'closed').sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt)).slice(0, 200);
    return res.json(history.map((order) => jsonGetOrder(order.id)).filter(Boolean));
  }

  const result = await pool.query("SELECT id FROM orders WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 200");
  res.json((await Promise.all(result.rows.map((row) => getOrder(row.id)))).filter(Boolean));
}));

app.get('/api/report-options', authMiddleware, asyncRoute(async (_req, res) => {
  if (JSON_MODE) {
    return res.json(readJsonData().users
      .filter((user) => user.active !== false)
      .map((user) => ({ id: user.id, name: user.name }))
      .sort((a, b) => a.name.localeCompare(b.name)));
  }
  const result = await pool.query('SELECT id, name FROM users WHERE active = true ORDER BY name');
  res.json(result.rows);
}));

app.get('/api/reports', authMiddleware, asyncRoute(async (req, res) => {
  const fromDate = req.query.from ? new Date(`${req.query.from}T00:00:00.000Z`) : null;
  const toDate = req.query.to ? new Date(`${req.query.to}T00:00:00.000Z`) : null;
  const waiterId = req.query.waiterId || null;
  const paymentMethod = req.query.paymentMethod || null;
  if ((req.query.from && Number.isNaN(fromDate.getTime())) || (req.query.to && Number.isNaN(toDate.getTime()))
    || (fromDate && toDate && fromDate > toDate)
    || (waiterId !== null && typeof waiterId !== 'string')
    || (paymentMethod && !['dinheiro', 'pix', 'debito', 'credito'].includes(paymentMethod))) {
    return res.status(400).json({ error: 'Filtros de relatório inválidos.' });
  }
  const toExclusive = toDate ? new Date(toDate.getTime() + 24 * 60 * 60 * 1000) : null;
  let orders;
  if (JSON_MODE) {
    const data = readJsonData();
    orders = data.orders.filter((order) => order.status === 'closed'
      && (!fromDate || new Date(order.closedAt).getTime() >= fromDate.getTime())
      && (!toExclusive || new Date(order.closedAt).getTime() < toExclusive.getTime())
      && (!waiterId || (waiterId === '__none__' ? !order.waiterId : order.waiterId === waiterId)))
      .map((order) => jsonGetOrder(order.id))
      .filter((order) => !paymentMethod || (order.payments || []).some((payment) => payment.status !== 'reversed' && payment.method === paymentMethod));
    if (orders.length > 1000) return res.status(413).json({ error: 'Período contém mais de 1.000 comandas; reduza o intervalo.' });
    orders.sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt));
  } else {
    const conditions = ["o.status = 'closed'"];
    const params = [];
    if (fromDate) {
      params.push(fromDate.toISOString());
      conditions.push(`o.closed_at >= $${params.length}`);
    }
    if (toExclusive) {
      params.push(toExclusive.toISOString());
      conditions.push(`o.closed_at < $${params.length}`);
    }
    if (waiterId) {
      params.push(waiterId === '__none__' ? null : waiterId);
      conditions.push(waiterId === '__none__' ? 'o.waiter_id IS NULL' : `o.waiter_id = $${params.length}`);
    }
    if (paymentMethod) {
      params.push(paymentMethod);
      conditions.push(`EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'paid' AND p.method = $${params.length})`);
    }
    const result = await pool.query(
      `SELECT o.id FROM orders o WHERE ${conditions.join(' AND ')}
        ORDER BY o.closed_at DESC LIMIT 1001`,
      params
    );
    if (result.rowCount > 1000) return res.status(413).json({ error: 'Período contém mais de 1.000 comandas; reduza o intervalo.' });
    orders = (await Promise.all(result.rows.map((row) => getOrder(row.id)))).filter(Boolean);
  }

  const summary = {
    orderCount: orders.length,
    total: money(orders.reduce((sum, order) => sum + Number(order.total || 0), 0)),
    discounts: money(orders.reduce((sum, order) => sum + Number(order.discountAmount || 0), 0)),
    serviceFees: money(orders.reduce((sum, order) => sum + Number(order.serviceFeeAmount || 0), 0)),
    averageTicket: money(orders.length ? orders.reduce((sum, order) => sum + Number(order.total || 0), 0) / orders.length : 0)
  };
  const waiterTotals = new Map();
  const paymentTotals = new Map();
  for (const order of orders) {
    const waiterKey = order.waiterId || '__none__';
    const waiterSummary = waiterTotals.get(waiterKey) || {
      waiterId: order.waiterId || null, waiterName: order.waiterName || 'Sem garçom', orderCount: 0, total: 0
    };
    waiterSummary.orderCount += 1;
    waiterSummary.total += Number(order.total || 0);
    waiterTotals.set(waiterKey, waiterSummary);
    for (const payment of order.payments || []) {
      if (payment.status === 'reversed') continue;
      paymentTotals.set(payment.method, (paymentTotals.get(payment.method) || 0) + Number(payment.amount || 0));
    }
  }
  res.json({
    summary,
    byWaiter: [...waiterTotals.values()].map((entry) => ({ ...entry, total: money(entry.total) }))
      .sort((a, b) => b.total - a.total),
    byPaymentMethod: [...paymentTotals.entries()].map(([method, total]) => ({ method, total: money(total) }))
      .sort((a, b) => b.total - a.total),
    orders
  });
}));

app.get('/api/audit', authMiddleware, administratorMiddleware, asyncRoute(async (_req, res) => {
  if (JSON_MODE) return res.json(readJsonData().audit.slice(0, 200));
  const result = await pool.query(
    `SELECT id, actor_user_id AS "actorUserId", actor_name AS "actorName", action,
            detail, created_at AS "createdAt"
       FROM audit_events ORDER BY created_at DESC LIMIT 200`
  );
  res.json(result.rows);
}));

app.get('/api/notices', authMiddleware, asyncRoute(async (req, res) => {
  if (JSON_MODE) {
    const data = readJsonData();
    const notices = data.notices.filter((notice) => notice.toUserId == null || notice.toUserId === req.user.sub)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 100)
      .map((notice) => {
        const readAt = notice.readAt && typeof notice.readAt === 'object'
          ? notice.readAt[req.user.sub] || null
          : notice.readAt || null;
        return {
          ...notice,
          readAt: Array.isArray(notice.readBy) && !notice.readBy.includes(req.user.sub) ? null : readAt,
          fromName: notice.fromName || data.users.find((user) => user.id === notice.fromUserId)?.name || 'Equipe'
        };
      });
    return res.json(notices);
  }

  const result = await pool.query(
    `SELECT n.id, n.from_user_id AS "fromUserId", u.name AS "fromName",
            n.to_user_id AS "toUserId", n.table_id AS "tableId",
            n.type, n.message, COALESCE(nr.read_at, n.read_at) AS "readAt", n.created_at AS "createdAt"
       FROM notices n
       JOIN users u ON u.id = n.from_user_id
       LEFT JOIN notice_reads nr ON nr.notice_id = n.id AND nr.user_id = $1
      WHERE n.to_user_id IS NULL OR n.to_user_id = $1
      ORDER BY n.created_at DESC LIMIT 100`,
    [req.user.sub]
  );
  res.json(result.rows);
}));

app.patch('/api/notices/:id/read', authMiddleware, asyncRoute(async (req, res) => {
  if (JSON_MODE) {
    const data = readJsonData();
    const notice = data.notices.find((item) => item.id === req.params.id
      && (!item.toUserId || item.toUserId === req.user.sub));
    if (!notice) return res.status(404).json({ error: 'Aviso não encontrado.' });
    notice.readBy = Array.isArray(notice.readBy) ? notice.readBy : [];
    if (!notice.readBy.includes(req.user.sub)) notice.readBy.push(req.user.sub);
    const readAt = notice.readAt && typeof notice.readAt === 'object' ? { ...notice.readAt } : {};
    readAt[req.user.sub] = readAt[req.user.sub] || new Date().toISOString();
    notice.readAt = readAt;
    writeJsonData(data);
    return res.json({ ok: true });
  }

  const result = await pool.query(
    `INSERT INTO notice_reads (notice_id, user_id)
     SELECT id, $2 FROM notices WHERE id = $1 AND (to_user_id IS NULL OR to_user_id = $2)
     ON CONFLICT (notice_id, user_id) DO UPDATE SET read_at = now()
     RETURNING notice_id AS id, read_at AS "readAt"`,
    [req.params.id, req.user.sub]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Aviso não encontrado.' });
  res.json({ ok: true });
}));

app.post('/api/notices', authMiddleware, asyncRoute(async (req, res) => {
  const { message, toUserId = null, tableId = null, type = 'message' } = req.body || {};
  if (typeof message !== 'string' || !message.trim() || message.length > 1000) return res.status(400).json({ error: 'Informe uma mensagem de até 1.000 caracteres.' });
  if ((toUserId !== null && typeof toUserId !== 'string') || (tableId !== null && typeof tableId !== 'string')
    || typeof type !== 'string') {
    return res.status(400).json({ error: 'Destinatário, mesa ou tipo de aviso inválido.' });
  }

  if (JSON_MODE) {
    const data = readJsonData();
    if (toUserId && !data.users.some((user) => user.id === toUserId)) return res.status(404).json({ error: 'Destinatário não encontrado.' });
    if (tableId && !data.tables.some((table) => table.id === tableId)) return res.status(404).json({ error: 'Mesa não encontrada.' });
    const notice = {
      id: crypto.randomUUID(),
      fromUserId: req.user.sub,
      fromName: req.user.name,
      toUserId: toUserId || null,
      tableId: tableId || null,
      type: String(type).slice(0, 40),
      message: message.trim().slice(0, 1000),
      readBy: [req.user.sub],
      readAt: { [req.user.sub]: new Date().toISOString() },
      createdAt: new Date().toISOString()
    };
    data.notices.unshift(notice);
    writeJsonData(data);
    return res.status(201).json(notice);
  }

  if (toUserId) {
    const recipient = await pool.query('SELECT id FROM users WHERE id = $1 AND active = true', [toUserId]);
    if (!recipient.rowCount) return res.status(404).json({ error: 'Destinatário não encontrado ou inativo.' });
  }
  if (tableId) {
    const table = await pool.query('SELECT id FROM restaurant_tables WHERE id = $1 AND active = true', [tableId]);
    if (!table.rowCount) return res.status(404).json({ error: 'Mesa não encontrada.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO notices (id, from_user_id, to_user_id, table_id, type, message)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, from_user_id AS "fromUserId", to_user_id AS "toUserId", table_id AS "tableId",
                 type, message, read_at AS "readAt", created_at AS "createdAt"`,
      [crypto.randomUUID(), req.user.sub, toUserId, tableId, String(type).slice(0, 40), message.trim().slice(0, 1000)]
    );
    await client.query('INSERT INTO notice_reads (notice_id, user_id) VALUES ($1, $2)', [result.rows[0].id, req.user.sub]);
    await client.query('COMMIT');
    res.status(201).json({ ...result.rows[0], fromName: req.user.name });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/migration/import-legacy', authMiddleware, adminMiddleware, asyncRoute(async (req, res) => {
  if (JSON_MODE) return res.status(409).json({ error: 'A importação legada requer o PostgreSQL.' });

  const legacy = req.body?.state || req.body;
  if (!legacy || !Array.isArray(legacy.products) || !Array.isArray(legacy.comandas)) {
    return res.status(400).json({ error: 'Arquivo inválido. Selecione a exportação JSON do sistema inicial.' });
  }
  if (legacy.comandas.some((order) => !order || typeof order !== 'object' || Array.isArray(order))
    || legacy.products.some((product) => !product || typeof product !== 'object' || Array.isArray(product))
    || (Array.isArray(legacy.waiters) && legacy.waiters.some((waiter) => !waiter || typeof waiter !== 'object' || Array.isArray(waiter)))
    || (Array.isArray(legacy.notices) && legacy.notices.some((notice) => !notice || typeof notice !== 'object' || Array.isArray(notice)))
    || legacy.comandas.some((order) => !['open', 'closed', 'cancelled', 'canceled'].includes(order.status)
      || (Array.isArray(order.items) && order.items.some((item) => !item || typeof item !== 'object' || Array.isArray(item))))) {
    return res.status(400).json({ error: 'O backup contém registros em formato inválido.' });
  }
  if (legacy.products.length > 5000 || legacy.comandas.length > 50000
    || (Array.isArray(legacy.waiters) && legacy.waiters.length > 5000)
    || (Array.isArray(legacy.notices) && legacy.notices.length > 5000)) {
    return res.status(413).json({ error: 'O backup excede o limite de registros permitido.' });
  }

  const sourceHash = crypto.createHash('sha256').update(JSON.stringify(legacy)).digest('hex');
  const legacyTableCount = legacy.settings?.tables === undefined ? 0 : Number(legacy.settings.tables);
  if (legacyTableCount !== 0 && (!Number.isInteger(legacyTableCount) || legacyTableCount < 1 || legacyTableCount > 80)) {
    return res.status(400).json({ error: 'A quantidade de mesas do backup deve ser um inteiro entre 1 e 80.' });
  }
  const archivedLegacy = JSON.parse(JSON.stringify(legacy));
  if (Array.isArray(archivedLegacy.waiters)) {
    archivedLegacy.waiters = archivedLegacy.waiters.map((waiter) => {
      const { pin: _pin, ...safeWaiter } = waiter || {};
      return safeWaiter;
    });
  }
  if (Array.isArray(archivedLegacy.terminals)) {
    archivedLegacy.terminals = archivedLegacy.terminals.map((terminal) => {
      const { endpoint: _endpoint, ...safeTerminal } = terminal || {};
      return safeTerminal;
    });
  }
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const previousImport = await client.query(
      'SELECT result FROM migration_imports WHERE source_hash = $1',
      [sourceHash]
    );
    if (previousImport.rowCount) {
      await client.query('COMMIT');
      transactionOpen = false;
      return res.json({ ...previousImport.rows[0].result, alreadyImported: true });
    }

    const admin = await client.query('SELECT id FROM users WHERE id = $1 AND active = true', [req.user.sub]);
    if (!admin.rowCount) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      return res.status(401).json({ error: 'A conta de administrador não está mais ativa.' });
    }

    const maxTable = legacy.comandas.reduce((max, order) => Math.max(max, Number(order.table) || 0), 0);
    const configuredTables = legacyTableCount || 0;
    const requiredTables = Math.max(8, maxTable, Math.min(80, configuredTables));
    if (requiredTables > 80) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      return res.status(400).json({ error: 'O backup contém uma mesa acima do limite de 80.' });
    }
    for (let number = 1; number <= requiredTables; number += 1) {
      await client.query(
        'INSERT INTO restaurant_tables (id, number) VALUES ($1, $2) ON CONFLICT (number) DO NOTHING',
        [crypto.randomUUID(), number]
      );
    }
    const configuredTableCount = await client.query(
      "SELECT value FROM app_settings WHERE key = 'table_count'"
    );
    const tableCount = Math.max(Number(configuredTableCount.rows[0]?.value) || 8, requiredTables);
    await client.query(
      `INSERT INTO app_settings (key, value) VALUES ('table_count', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [String(tableCount)]
    );
    const legacySettings = legacy.settings || {};
    const settingsToImport = [
      ['restaurant_name', legacySettings.restaurantName ?? legacySettings.name, 'Comanda'],
      ['allow_discount', legacySettings.allowDiscount, 'true'],
      ['require_waiter', legacySettings.requireWaiter, 'true'],
      ['service_fee_percent', legacySettings.serviceFeePercent ?? legacySettings.serviceFeePct, '10'],
      ['service_fee_default', legacySettings.serviceFeeDefault, 'false'],
      ['discount_limit', legacySettings.discountLimit, '10']
    ];
    for (const [key, sourceValue, defaultValue] of settingsToImport) {
      if (sourceValue === undefined || sourceValue === null) continue;
      let value;
      if (['allow_discount', 'require_waiter', 'service_fee_default'].includes(key)) {
        if (typeof sourceValue !== 'boolean') throw new Error(`Configuração ${key} inválida no backup.`);
        value = String(sourceValue);
      } else if (['service_fee_percent', 'discount_limit'].includes(key)) {
        const number = Number(sourceValue);
        if (!Number.isFinite(number) || number < 0 || number > 100) {
          throw new Error(`Configuração ${key} inválida no backup.`);
        }
        value = String(number);
      } else {
        const name = String(sourceValue).trim();
        if (!name || name.length > 120) throw new Error('Nome do restaurante inválido no backup.');
        value = name;
      }
      await client.query(
        `INSERT INTO app_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
         WHERE app_settings.value = $3`,
        [key, value, defaultValue]
      );
    }
    await client.query('UPDATE restaurant_tables SET active = true WHERE number <= $1', [tableCount]);
    const tableRows = await client.query('SELECT id, number FROM restaurant_tables');
    const tableIds = new Map(tableRows.rows.map((table) => [Number(table.number), table.id]));

    const productsByLegacyId = new Map();
    let importedProducts = 0;
    for (const product of legacy.products) {
      if (!product || typeof product.name !== 'string' || !product.name.trim()) {
        throw new Error('Há um produto sem nome no backup; corrija o arquivo e tente novamente.');
      }
      const name = product.name.trim().slice(0, 180);
      const category = (typeof product.category === 'string' && product.category.trim()
        ? product.category.trim()
        : 'Sem categoria').slice(0, 80);
      const price = Number(product.price);
      if (!Number.isFinite(price) || price < 0) throw new Error(`Preço inválido no produto "${name}".`);
      const existing = await client.query(
        'SELECT id FROM products WHERE lower(name) = lower($1) AND lower(category) = lower($2) ORDER BY created_at LIMIT 1',
        [name, category]
      );
      let productId = existing.rows[0]?.id;
      if (!productId) {
        productId = crypto.randomUUID();
        const station = product.productionStation === 'bar' || product.production_station === 'bar'
          || (typeof product.sector === 'string' && /bar/i.test(product.sector))
          || /bebida|cerveja|drink|suco/i.test(category) ? 'bar' : 'kitchen';
        await client.query(
          `INSERT INTO products (id, name, category, price, production_station, active)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [productId, name, category, price, station, product.active !== false]
        );
        importedProducts += 1;
      }
      if (product.id != null) productsByLegacyId.set(String(product.id), productId);
    }

    const legacyWaiters = (Array.isArray(legacy.waiters) ? legacy.waiters : []).map((waiter) => ({
      id: String(waiter.id || '').slice(0, 160),
      name: String(waiter.name || 'Usuário legado').slice(0, 120),
      role: ['admin', 'gerente', 'operador'].includes(waiter.role) ? waiter.role : 'operador',
      active: waiter.active !== false
    }));
    let importedStaffProfiles = 0;
    const staffByLegacyId = new Map();
    const inactivePasswordHash = await bcrypt.hash(crypto.randomBytes(48).toString('base64url'), 12);
    for (let index = 0; index < legacyWaiters.length; index += 1) {
      const waiter = legacyWaiters[index];
      const legacyReference = waiter.id || `${sourceHash}:staff:${index}`;
      const exists = await client.query('SELECT id FROM users WHERE legacy_reference = $1', [legacyReference]);
      if (exists.rowCount) {
        if (waiter.id) staffByLegacyId.set(waiter.id, exists.rows[0].id);
        continue;
      }
      const internalEmailId = crypto.createHash('sha256').update(legacyReference).digest('hex').slice(0, 24);
      const createdUser = await client.query(
        `INSERT INTO users (id, name, email, password_hash, role, active, legacy_reference)
         VALUES ($1, $2, $3, $4, $5, false, $6) RETURNING id`,
        [
          crypto.randomUUID(), waiter.name, `legacy-${internalEmailId}@migration.invalid`,
          inactivePasswordHash, waiter.role, legacyReference
        ]
      );
      if (waiter.id) staffByLegacyId.set(waiter.id, createdUser.rows[0].id);
      importedStaffProfiles += 1;
    }

    let importedOrders = 0;
    let skippedOrders = 0;
    let importedItems = 0;
    let importedPayments = 0;
    for (const oldOrder of legacy.comandas) {
      const legacyReference = oldOrder?.id == null ? null : String(oldOrder.id).slice(0, 160);
      if (legacyReference) {
        const alreadyImported = await client.query(
          'SELECT 1 FROM orders WHERE legacy_reference = $1',
          [legacyReference]
        );
        if (alreadyImported.rowCount) {
          skippedOrders += 1;
          continue;
        }
      }
      const tableNumber = Number(oldOrder?.table);
      if (!Number.isInteger(tableNumber) || tableNumber < 1 || tableNumber > 80) {
        throw new Error(`Número de mesa inválido na comanda ${oldOrder?.seq || oldOrder?.id || ''}.`);
      }
      const tableId = tableIds.get(tableNumber);
      if (!tableId) throw new Error(`Não foi possível preparar a mesa ${tableNumber}.`);
      const isOpen = oldOrder.status === 'open';
      if (isOpen) {
        const conflict = await client.query(
          "SELECT 1 FROM orders WHERE table_id = $1 AND status = 'open'",
          [tableId]
        );
        if (conflict.rowCount) {
          throw new Error(`A mesa ${tableNumber} já possui uma comanda aberta. Feche-a antes de importar.`);
        }
      }

      const items = Array.isArray(oldOrder.items) ? oldOrder.items : [];
      const discountInfo = oldOrder.discountInfo && typeof oldOrder.discountInfo === 'object'
        ? oldOrder.discountInfo
        : typeof oldOrder.discount === 'object' ? oldOrder.discount : null;
      const discountValue = discountInfo
        ? Number(discountInfo.value) || 0
        : Number(oldOrder.discount) || 0;
      const discountType = discountInfo?.type || 'value';
      const subtotal = items.reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.qty ?? item.quantity) || 0), 0);
      const discountAmount = discountInfo && discountType === 'percent'
        ? money(subtotal * Math.min(100, Math.max(0, discountValue)) / 100)
        : money(Math.min(subtotal, Math.max(0, discountValue)));
      const oldFee = oldOrder.serviceFee || oldOrder.fee || {};
      const feePercent = Number(oldFee.pct ?? oldOrder.service_fee_percent) || 0;
      const serviceFeeAmount = Number(oldFee.amount ?? oldOrder.service_fee_amount)
        || (oldFee.on === true ? money(subtotal * feePercent / 100) : 0);
      if (!Number.isFinite(serviceFeeAmount) || serviceFeeAmount < 0
        || !Number.isFinite(feePercent) || feePercent < 0 || feePercent > 100) {
        throw new Error('Taxa de serviço inválida no backup.');
      }
      const closedAt = oldOrder.closedAt ? new Date(oldOrder.closedAt) : null;
      const openedAt = oldOrder.openedAt ? new Date(oldOrder.openedAt) : new Date();
      const orderId = crypto.randomUUID();
      const status = isOpen ? 'open' : ['cancelled', 'canceled'].includes(oldOrder.status) ? 'cancelled' : 'closed';
      const payments = Array.isArray(oldOrder.payments) ? oldOrder.payments : [];
      const paymentTotal = payments.reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
      const paidTotal = Math.max(0, Number(oldOrder.paidTotal) || paymentTotal);
      const waiterName = String(oldOrder.waiterName || 'Sem garçom').slice(0, 120);
      const waiterId = oldOrder.waiterId == null ? null : staffByLegacyId.get(String(oldOrder.waiterId)) || null;
      const discountAuth = oldOrder.discountAuth && typeof oldOrder.discountAuth === 'object'
        ? oldOrder.discountAuth : null;
      const discountAuthorizedBy = discountAuth?.byId == null
        ? null : staffByLegacyId.get(String(discountAuth.byId)) || null;
      const discountAuthorizedAt = discountAuth?.at ? new Date(discountAuth.at) : null;
      await client.query(
        `INSERT INTO orders (id, table_id, waiter_id, waiter_name, status, created_at, updated_at, closed_at,
                             discount_amount, discount_type, discount_value, discount_authorized_by,
                             discount_authorized_at, service_fee_amount,
                             service_fee_percent, service_fee_enabled, paid_total, notes, legacy_reference)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [
          orderId, tableId, waiterId, waiterName, status,
          Number.isNaN(openedAt.getTime()) ? new Date() : openedAt,
          closedAt && !Number.isNaN(closedAt.getTime()) ? closedAt : new Date(),
          status === 'open' ? null : (closedAt && !Number.isNaN(closedAt.getTime()) ? closedAt : new Date()),
          discountAmount, ['percent', 'value'].includes(discountType) ? discountType : 'value',
          Number.isFinite(discountValue) ? discountValue : 0, discountAuthorizedBy,
          discountAuthorizedAt && !Number.isNaN(discountAuthorizedAt.getTime()) ? discountAuthorizedAt : null,
          money(serviceFeeAmount),
          feePercent, oldFee.on === true, money(paidTotal),
          oldOrder.notes == null ? null : String(oldOrder.notes).slice(0, 5000), legacyReference
        ]
      );

      const usedProductIds = new Set();
      const importedItemIds = new Map();
      for (const item of items) {
        const quantity = Number(item.qty ?? item.quantity);
        const price = Number(item.price);
        const productName = String(item.name || item.productName || 'Produto legado').slice(0, 180);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999 || !Number.isFinite(price) || price < 0) {
          throw new Error(`Item inválido na comanda ${oldOrder.seq || oldOrder.id || ''}.`);
        }
        const legacyProductId = item.pid ?? item.productId;
        let productId = productsByLegacyId.get(String(legacyProductId));
        if (!productId) {
          const match = await client.query(
            'SELECT id FROM products WHERE lower(name) = lower($1) ORDER BY created_at LIMIT 1',
            [productName]
          );
          productId = match.rows[0]?.id || crypto.randomUUID();
        }
        if (usedProductIds.has(productId)) productId = crypto.randomUUID();
        usedProductIds.add(productId);
        const station = item.productionStation === 'bar' || item.production_station === 'bar'
          || (typeof item.sector === 'string' && /bar/i.test(item.sector))
          || /bebida|cerveja|drink|suco/i.test(productName) ? 'bar' : 'kitchen';
        const orderItemId = crypto.randomUUID();
        await client.query(
          `INSERT INTO order_items
             (id, order_id, product_id, product_name, production_station, quantity, price, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [orderItemId, orderId, productId, productName, station, quantity, price,
            item.addedAt && !Number.isNaN(new Date(item.addedAt).getTime()) ? new Date(item.addedAt) :
              (Number.isNaN(openedAt.getTime()) ? new Date() : openedAt)]
        );
        const legacyItemId = item.iid ?? item.id ?? item.pid ?? item.productId;
        if (legacyItemId != null) importedItemIds.set(String(legacyItemId), orderItemId);
        importedItems += 1;
      }

      for (const payment of payments) {
        const methodText = String(payment.method || '').toLowerCase();
        const method = methodText.includes('pix') ? 'pix'
          : methodText.includes('déb') || methodText.includes('deb') ? 'debito'
            : methodText.includes('créd') || methodText.includes('cred') ? 'credito'
              : methodText.includes('dinheiro') ? 'dinheiro' : null;
        const amount = Number(payment.amount);
        if (!method || !Number.isFinite(amount) || amount <= 0) {
          throw new Error(`Pagamento sem forma ou valor válido na comanda ${oldOrder.seq || oldOrder.id || ''}.`);
        }
        const paymentItems = Array.isArray(payment.items) ? payment.items : [];
        const allocations = paymentItems.map((allocation) => {
          const legacyItemId = allocation.iid ?? allocation.itemId ?? allocation.id ?? allocation.pid;
          const itemId = legacyItemId == null ? null : importedItemIds.get(String(legacyItemId));
          const quantity = Number(allocation.qty ?? allocation.quantity);
          if (!Number.isInteger(quantity) || quantity < 1) {
            throw new Error(`Rateio de pagamento inválido na comanda ${oldOrder.seq || oldOrder.id || ''}.`);
          }
          if (!itemId) {
            if (isOpen) throw new Error(`Não foi possível vincular um item pago na comanda aberta ${oldOrder.seq || oldOrder.id || ''}.`);
            return null;
          }
          return { itemId, quantity };
        }).filter(Boolean);
        const paymentDetails = {
          items: allocations,
          split: payment.mode || payment.split
            ? { mode: payment.mode || payment.split?.mode || 'legacy', label: payment.label || payment.split?.label || null }
            : null
        };
        await client.query(
          `INSERT INTO payments (id, order_id, method, amount, received, details, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            crypto.randomUUID(), orderId, method, money(amount),
            Number.isFinite(Number(payment.received)) && Number(payment.received) > 0 ? money(payment.received) : null,
            JSON.stringify(paymentDetails),
            payment.at && !Number.isNaN(new Date(payment.at).getTime()) ? new Date(payment.at) :
              (closedAt && !Number.isNaN(closedAt.getTime()) ? closedAt : new Date())
          ]
        );
        importedPayments += 1;
      }
      importedOrders += 1;
    }

    let importedNotices = 0;
    let skippedNotices = 0;
    for (const oldNotice of (Array.isArray(legacy.notices) ? legacy.notices : [])) {
      const toUserId = oldNotice.toId == null ? null : staffByLegacyId.get(String(oldNotice.toId)) || null;
      if (oldNotice.toId != null && !toUserId) {
        skippedNotices += 1;
        continue;
      }
      const legacyTable = Number(oldNotice.table);
      const tableId = Number.isInteger(legacyTable) ? tableIds.get(legacyTable) || null : null;
      const fromUserId = oldNotice.fromId == null
        ? admin.rows[0].id
        : staffByLegacyId.get(String(oldNotice.fromId)) || admin.rows[0].id;
      const kind = String(oldNotice.kind || '').toLowerCase();
      const message = String(oldNotice.text || oldNotice.message || (kind === 'chamada' ? 'Está chamando na mesa.' : '')).trim();
      if (!message) {
        skippedNotices += 1;
        continue;
      }
      const createdAt = oldNotice.at ? new Date(oldNotice.at) : new Date();
      const result = await client.query(
        `INSERT INTO notices (id, from_user_id, to_user_id, table_id, type, message, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          crypto.randomUUID(), fromUserId, toUserId, tableId,
          kind === 'chamada' ? 'call' : 'message', message.slice(0, 1000),
          Number.isNaN(createdAt.getTime()) ? new Date() : createdAt
        ]
      );
      const readAt = oldNotice.readAt && typeof oldNotice.readAt === 'object' ? oldNotice.readAt : {};
      for (const legacyReaderId of (Array.isArray(oldNotice.readBy) ? oldNotice.readBy : [])) {
        const readerId = staffByLegacyId.get(String(legacyReaderId));
        if (!readerId) continue;
        const readDate = readAt[legacyReaderId] ? new Date(readAt[legacyReaderId]) : new Date();
        await client.query(
          `INSERT INTO notice_reads (notice_id, user_id, read_at) VALUES ($1, $2, $3)
           ON CONFLICT (notice_id, user_id) DO NOTHING`,
          [result.rows[0].id, readerId, Number.isNaN(readDate.getTime()) ? new Date() : readDate]
        );
      }
      importedNotices += 1;
    }

    const importedSettings = {
      source: 'creao_comandas_v1',
      settings: legacy.settings && typeof legacy.settings === 'object' ? legacy.settings : {},
      waiters: legacyWaiters,
      terminals: (Array.isArray(legacy.terminals) ? legacy.terminals : [])
        .filter((terminal) => terminal && typeof terminal === 'object')
        .map((terminal) => ({
          label: String(terminal.label || '').slice(0, 120),
          model: String(terminal.model || '').slice(0, 80),
          mode: String(terminal.mode || '').slice(0, 20),
          active: terminal.active !== false
        })),
      audit: Array.isArray(legacy.audit) ? legacy.audit.slice(0, 200) : [],
      notices: { imported: importedNotices, skipped: skippedNotices }
    };
    if (typeof legacy.settings?.name === 'string' && legacy.settings.name.trim()) {
      await client.query(
        `INSERT INTO app_settings (key, value) VALUES ('restaurant_name', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [legacy.settings.name.trim().slice(0, 120)]
      );
    }
    await client.query(
      `INSERT INTO app_settings (key, value) VALUES ('legacy_migration_data', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(importedSettings)]
    );
    const result = {
      importedProducts,
      activeTableCount: tableCount,
      importedOrders,
      skippedOrders,
      importedItems,
      importedPayments,
      importedStaffProfiles,
      importedNotices,
      skippedNotices
    };
    await client.query(
      'INSERT INTO migration_imports (source_hash, result, source_data) VALUES ($1, $2, $3)',
      [sourceHash, JSON.stringify(result), JSON.stringify(archivedLegacy)]
    );
    await client.query('COMMIT');
    transactionOpen = false;
    res.json(result);
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK');
    if (error.code === '23505') {
      return res.status(409).json({ error: 'O backup conflita com dados existentes. Nenhum dado foi importado.' });
    }
    if (error.message.startsWith('Há um produto') || error.message.startsWith('Preço inválido')
      || error.message.startsWith('Número de mesa') || error.message.startsWith('Não foi possível')
      || error.message.startsWith('A mesa') || error.message.startsWith('Taxa de serviço')
      || error.message.startsWith('Item inválido') || error.message.startsWith('Pagamento sem')) {
      return res.status(400).json({ error: error.message });
    }
    throw error;
  } finally {
    client.release();
  }
}));

app.get('/api/backup', authMiddleware, adminMiddleware, asyncRoute(async (_req, res) => {
  let records;
  if (JSON_MODE) {
    records = readJsonData();
  } else {
    const [users, tables, products, orders, items, payments, notices, settings, migrationImports] = await Promise.all([
      pool.query('SELECT * FROM users ORDER BY created_at'),
      pool.query('SELECT * FROM restaurant_tables ORDER BY number'),
      pool.query('SELECT * FROM products ORDER BY category, name'),
      pool.query('SELECT * FROM orders ORDER BY created_at'),
      pool.query('SELECT * FROM order_items ORDER BY created_at'),
      pool.query('SELECT * FROM payments ORDER BY created_at'),
      pool.query('SELECT * FROM notices ORDER BY created_at'),
      pool.query('SELECT * FROM app_settings ORDER BY key'),
      pool.query('SELECT source_hash, imported_at, result, source_data FROM migration_imports ORDER BY imported_at')
    ]);
    records = {
      users: users.rows,
      tables: tables.rows,
      products: products.rows,
      orders: orders.rows,
      orderItems: items.rows,
      payments: payments.rows,
      notices: notices.rows,
      settings: settings.rows,
      migrationImports: migrationImports.rows
    };
  }

  const backup = {
    format: 'controle-restaurante-backup-v1',
    generatedAt: new Date().toISOString(),
    database: JSON_MODE ? 'json' : 'postgresql',
    records
  };
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="backup-restaurante-${date}.json"`);
  res.send(JSON.stringify(backup, null, 2));
}));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Rota não encontrada' }));
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

async function initializeDatabase() {
  if (JSON_MODE) {
    ensureJsonDataFile();
    return;
  }

  const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  await pool.query(schema);

  const adminEmail = process.env.ADMIN_EMAIL || 'admin@restaurante.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const passwordHash = await bcrypt.hash(adminPassword, 12);
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, role)
     VALUES ($1, 'Administrador', $2, $3, 'admin') ON CONFLICT (email) DO NOTHING`,
    [crypto.randomUUID(), adminEmail, passwordHash]
  );

  const tableCount = await pool.query('SELECT count(*)::int AS count FROM restaurant_tables');
  if (!tableCount.rows[0].count) {
    for (let number = 1; number <= 8; number += 1) {
      await pool.query('INSERT INTO restaurant_tables (id, number) VALUES ($1, $2)', [crypto.randomUUID(), number]);
    }
  }

  const productCount = await pool.query('SELECT count(*)::int AS count FROM products');
  if (!productCount.rows[0].count) {
    const products = [
      ['Água mineral', 'Bebidas', 5, 'bar'],
      ['Refrigerante lata', 'Bebidas', 7, 'bar'],
      ['Cerveja long neck', 'Cervejas', 12, 'bar'],
      ['Batata frita', 'Petiscos', 28, 'kitchen'],
      ['Frango a passarinho', 'Petiscos', 42, 'kitchen'],
      ['Filé à parmegiana', 'Pratos', 62, 'kitchen']
    ];
    for (const [name, category, price, station] of products) {
      await pool.query(
        'INSERT INTO products (id, name, category, price, production_station) VALUES ($1, $2, $3, $4, $5)',
        [crypto.randomUUID(), name, category, price, station]
      );
    }
  }
}

async function start() {
  if (!JWT_SECRET || JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET precisa ter pelo menos 32 caracteres. Configure-o no .env.');
  }
  await initializeDatabase();
  httpServer = app.listen(PORT, () => console.log(`Comanda disponível em http://localhost:${PORT}`));
}

let httpServer;

if (!pool && !JSON_MODE) {
  console.error('DATABASE_URL não configurada. Copie .env.example para .env e informe a conexão PostgreSQL.');
  process.exitCode = 1;
} else {
  start().catch((error) => {
    console.error(`Falha ao iniciar: ${error.message}`);
    process.exitCode = 1;
  });
}

process.on('SIGTERM', async () => {
  try {
    if (httpServer) {
      await new Promise((resolve, reject) => {
        httpServer.close((error) => error ? reject(error) : resolve());
      });
    }
    if (pool) await pool.end();
  } catch (error) {
    console.error(`Falha ao encerrar o servidor: ${error.message}`);
    process.exitCode = 1;
  }
});