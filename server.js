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
const DATA_FILE = path.join(__dirname, 'data', 'db.json');
const JSON_MODE = process.env.USE_JSON_DB === 'true' || !DATABASE_URL || !fs.existsSync(path.join(__dirname, 'db', 'schema.sql'));

app.use(express.json({ limit: '32kb' }));
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
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

function adminMiddleware(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso restrito ao administrador' });
  }
  next();
}

function money(value) {
  return Number(Number(value || 0).toFixed(2));
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
    settings: { restaurantName: 'Comanda' }
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
    return {
      users: (parsed.users || []).map((user) => ({
        ...user,
        password_hash: user.password_hash || user.passwordHash || null
      })),
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
      settings: {
        restaurantName: parsed.settings?.restaurantName || 'Comanda'
      }
    };
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

  return {
    id: order.id,
    tableId: order.tableId,
    tableNumber: data.tables.find((table) => table.id === order.tableId)?.number ?? null,
    waiterName: order.waiterName,
    status: order.status,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    closedAt: order.closedAt || null,
    discountAmount,
    paidTotal: money(order.paidTotal || 0),
    notes: order.notes || '',
    items,
    subtotal,
    total: money(Math.max(0, subtotal - discountAmount)),
  };
}

function jsonGetTables() {
  const data = readJsonData();
  return data.tables.map((table) => {
    const openOrder = data.orders.find((order) => order.tableId === table.id && order.status === 'open');
    const openOrderTotal = openOrder
      ? money((openOrder.items || []).reduce((sum, item) => sum + Number(item.quantity) * Number(item.price), 0) - Number(openOrder.discountAmount || 0))
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
    `SELECT o.id, o.table_id AS "tableId", t.number AS "tableNumber",
            o.waiter_name AS "waiterName", o.status, o.created_at AS "createdAt",
            o.updated_at AS "updatedAt", o.closed_at AS "closedAt",
            o.discount_amount AS "discountAmount", o.paid_total AS "paidTotal", o.notes
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

  return {
    ...order,
    items,
    subtotal,
    discountAmount,
    total: money(Math.max(0, subtotal - discountAmount)),
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
    if (!user || !passwordHash || !(await bcrypt.compare(password, passwordHash))) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    return res.json({
      token: signToken(user),
      user: { id: user.id, name: user.name, role: user.role, email: user.email }
    });
  }

  const result = await pool.query(
    'SELECT id, name, email, password_hash, role FROM users WHERE lower(email) = lower($1)',
    [email.trim()]
  );
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
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
    return res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
  }

  const result = await pool.query(
    'SELECT id, name, email, role FROM users WHERE id = $1',
    [req.user.sub]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Usuário não encontrado' });
  res.json(result.rows[0]);
}));

app.get('/api/products', authMiddleware, asyncRoute(async (_req, res) => {
  if (JSON_MODE) {
    const data = readJsonData();
    return res.json(data.products.filter((product) => product.active).map((product) => ({ ...product, price: money(product.price) })));
  }

  const result = await pool.query(
    'SELECT id, name, category, price, active, production_station AS "productionStation" FROM products WHERE active = true ORDER BY category, name'
  );
  res.json(result.rows.map((product) => ({ ...product, price: money(product.price) })));
}));

app.get('/api/settings', authMiddleware, asyncRoute(async (_req, res) => {
  if (JSON_MODE) {
    return res.json(readJsonData().settings);
  }

  const result = await pool.query("SELECT value AS \"restaurantName\" FROM app_settings WHERE key = 'restaurant_name'");
  res.json({ restaurantName: result.rows[0]?.restaurantName || 'Comanda' });
}));

app.patch('/api/settings', authMiddleware, adminMiddleware, asyncRoute(async (req, res) => {
  const restaurantName = typeof req.body?.restaurantName === 'string'
    ? req.body.restaurantName.trim()
    : '';
  if (!restaurantName || restaurantName.length > 120) {
    return res.status(400).json({ error: 'Informe um nome de restaurante com até 120 caracteres' });
  }

  if (JSON_MODE) {
    const data = readJsonData();
    data.settings.restaurantName = restaurantName;
    writeJsonData(data);
    return res.json(data.settings);
  }

  const result = await pool.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ('restaurant_name', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
     RETURNING value AS "restaurantName"`,
    [restaurantName]
  );
  res.json(result.rows[0]);
}));

app.patch('/api/products/:id/production-station', authMiddleware, adminMiddleware, asyncRoute(async (req, res) => {
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
            GREATEST(0, COALESCE(SUM(oi.quantity * oi.price), 0) - COALESCE(o.discount_amount, 0)) AS "openOrderTotal"
       FROM restaurant_tables t
       LEFT JOIN orders o ON o.table_id = t.id AND o.status = 'open'
       LEFT JOIN order_items oi ON oi.order_id = o.id
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
  const { tableId, waiterName } = req.body || {};
  if (typeof tableId !== 'string' || !tableId) return res.status(400).json({ error: 'Mesa obrigatória' });

  if (JSON_MODE) {
    const data = readJsonData();
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
      waiterName: typeof waiterName === 'string' ? waiterName.slice(0, 120) : 'Garçom',
      status: 'open',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      closedAt: null,
      items: [],
      discountAmount: 0,
      paidTotal: 0,
      notes: ''
    };
    data.orders.push(order);
    const tableIndex = data.tables.findIndex((item) => item.id === tableId);
    if (tableIndex >= 0) data.tables[tableIndex].status = 'occupied';
    writeJsonData(data);
    return res.status(201).json({ order: jsonGetOrder(id) });
  }

  const table = await pool.query('SELECT id FROM restaurant_tables WHERE id = $1', [tableId]);
  if (!table.rowCount) return res.status(404).json({ error: 'Mesa não encontrada' });

  const id = crypto.randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO orders (id, table_id, waiter_name, status)
       VALUES ($1, $2, $3, 'open')`,
      [id, tableId, typeof waiterName === 'string' ? waiterName.slice(0, 120) : 'Garçom']
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
  if (!Number.isFinite(qty) || qty <= 0 || qty > 999) return res.status(400).json({ error: 'Quantidade inválida' });

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
    order.items.splice(index, 1);
    order.updatedAt = new Date().toISOString();
    writeJsonData(data);
    return res.json(jsonGetOrder(req.params.id));
  }

  const result = await pool.query(
    `DELETE FROM order_items oi USING orders o
      WHERE oi.id = $1 AND oi.order_id = o.id AND o.id = $2 AND o.status = 'open'`,
    [req.params.itemId, req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Item não encontrado ou comanda fechada' });
  await pool.query('UPDATE orders SET updated_at = now() WHERE id = $1', [req.params.id]);
  res.json(await getOrder(req.params.id));
}));

app.patch('/api/orders/:id/items/:itemId', authMiddleware, asyncRoute(async (req, res) => {
  const quantity = Number(req.body?.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 999) return res.status(400).json({ error: 'Quantidade inválida' });

  if (JSON_MODE) {
    const data = readJsonData();
    const order = data.orders.find((item) => item.id === req.params.id && item.status === 'open');
    if (!order) return res.status(404).json({ error: 'Item não encontrado ou comanda fechada' });
    const item = order.items.find((entry) => entry.id === req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Item não encontrado ou comanda fechada' });
    item.quantity = quantity;
    item.productionStatus = 'pending';
    order.updatedAt = new Date().toISOString();
    writeJsonData(data);
    return res.json(jsonGetOrder(req.params.id));
  }

  const result = await pool.query(
    `UPDATE order_items oi SET quantity = $1, production_status = 'pending'
       FROM orders o WHERE oi.id = $2 AND oi.order_id = o.id AND o.id = $3 AND o.status = 'open'`,
    [quantity, req.params.itemId, req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Item não encontrado ou comanda fechada' });
  await pool.query('UPDATE orders SET updated_at = now() WHERE id = $1', [req.params.id]);
  res.json(await getOrder(req.params.id));
}));

app.post('/api/orders/:id/discount', authMiddleware, asyncRoute(async (req, res) => {
  const { type, value } = req.body || {};
  const discount = Number(value);
  if (!Number.isFinite(discount) || discount < 0 || (type !== 'percent' && type !== 'value') || (type === 'percent' && discount > 100)) {
    return res.status(400).json({ error: 'Desconto inválido' });
  }

  if (JSON_MODE) {
    const data = readJsonData();
    const order = data.orders.find((item) => item.id === req.params.id && item.status === 'open');
    if (!order) return res.status(400).json({ error: 'Comanda inválida ou fechada' });
    const subtotal = (order.items || []).reduce((sum, item) => sum + Number(item.quantity) * Number(item.price), 0);
    const amount = Math.min(type === 'percent' ? subtotal * discount / 100 : discount, subtotal);
    order.discountAmount = money(amount);
    order.updatedAt = new Date().toISOString();
    writeJsonData(data);
    return res.json(jsonGetOrder(req.params.id));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const order = await client.query("SELECT id FROM orders WHERE id = $1 AND status = 'open' FOR UPDATE", [req.params.id]);
    if (!order.rowCount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Comanda inválida ou fechada' });
    }
    const subtotalResult = await client.query('SELECT COALESCE(SUM(quantity * price), 0) AS subtotal FROM order_items WHERE order_id = $1', [req.params.id]);
    const subtotal = Number(subtotalResult.rows[0].subtotal);
    const amount = Math.min(type === 'percent' ? subtotal * discount / 100 : discount, subtotal);
    await client.query('UPDATE orders SET discount_amount = $1, updated_at = now() WHERE id = $2', [money(amount), req.params.id]);
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
  const { method, amount, received } = req.body || {};
  const incoming = Number(amount);
  const allowedMethods = ['dinheiro', 'pix', 'debito', 'credito'];
  if (!Number.isFinite(incoming) || incoming <= 0 || !allowedMethods.includes(method)) {
    return res.status(400).json({ error: 'Pagamento inválido' });
  }

  if (JSON_MODE) {
    const data = readJsonData();
    const order = data.orders.find((item) => item.id === req.params.id && item.status === 'open');
    if (!order) return res.status(400).json({ error: 'Comanda inválida ou fechada' });
    const subtotal = (order.items || []).reduce((sum, item) => sum + Number(item.quantity) * Number(item.price), 0);
    const total = Math.max(0, subtotal - Number(order.discountAmount || 0));
    const remaining = Math.max(0, total - Number(order.paidTotal || 0));
    const paidAmount = money(Math.min(incoming, remaining));
    if (paidAmount <= 0) return res.status(400).json({ error: 'Comanda já está totalmente paga' });

    const payment = {
      id: crypto.randomUUID(),
      orderId: order.id,
      method,
      amount: paidAmount,
      received: Number.isFinite(Number(received)) && Number(received) > 0 ? Number(received) : null,
      createdAt: new Date().toISOString(),
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
    const discount = await client.query('SELECT discount_amount FROM orders WHERE id = $1', [req.params.id]);
    const total = Math.max(0, Number(totals.rows[0].subtotal) - Number(discount.rows[0].discount_amount));
    const remaining = Math.max(0, total - Number(orderResult.rows[0].paid_total));
    const paidAmount = money(Math.min(incoming, remaining));
    if (paidAmount <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Comanda já está totalmente paga' });
    }
    const paymentId = crypto.randomUUID();
    const paymentResult = await client.query(
      `INSERT INTO payments (id, order_id, method, amount, received)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, order_id AS "orderId", method, amount, received,
                 created_at AS "createdAt", status`,
      [paymentId, req.params.id, method, paidAmount, Number.isFinite(Number(received)) && Number(received) > 0 ? Number(received) : null]
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
    if (subtotal - Number(order.discountAmount || 0) > Number(order.paidTotal || 0) + 0.001) {
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
    const orderResult = await client.query("SELECT id, paid_total, discount_amount FROM orders WHERE id = $1 AND status = 'open' FOR UPDATE", [req.params.id]);
    if (!orderResult.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Comanda aberta não encontrada' });
    }
    const subtotal = await client.query('SELECT COALESCE(SUM(quantity * price), 0) AS subtotal FROM order_items WHERE order_id = $1', [req.params.id]);
    const order = orderResult.rows[0];
    if (Number(subtotal.rows[0].subtotal) - Number(order.discount_amount) > Number(order.paid_total) + 0.001) {
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

app.get('/api/history', authMiddleware, asyncRoute(async (_req, res) => {
  if (JSON_MODE) {
    const data = readJsonData();
    const history = data.orders.filter((order) => order.status === 'closed').sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt)).slice(0, 200);
    return res.json(history.map((order) => jsonGetOrder(order.id)).filter(Boolean));
  }

  const result = await pool.query("SELECT id FROM orders WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 200");
  res.json((await Promise.all(result.rows.map((row) => getOrder(row.id)))).filter(Boolean));
}));

app.get('/api/notices', authMiddleware, asyncRoute(async (req, res) => {
  if (JSON_MODE) {
    const data = readJsonData();
    const notices = data.notices.filter((notice) => notice.toUserId == null || notice.toUserId === req.user.sub).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 100);
    return res.json(notices);
  }

  const result = await pool.query(
    `SELECT id, from_user_id AS "fromUserId", to_user_id AS "toUserId", table_id AS "tableId",
            type, message, read_at AS "readAt", created_at AS "createdAt"
       FROM notices WHERE to_user_id IS NULL OR to_user_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [req.user.sub]
  );
  res.json(result.rows);
}));

app.post('/api/notices', authMiddleware, asyncRoute(async (req, res) => {
  const { message, toUserId = null, tableId = null, type = 'message' } = req.body || {};
  if (typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'Mensagem obrigatória' });

  if (JSON_MODE) {
    const data = readJsonData();
    const notice = {
      id: crypto.randomUUID(),
      fromUserId: req.user.sub,
      toUserId: toUserId || null,
      tableId: tableId || null,
      type: String(type).slice(0, 40),
      message: message.trim().slice(0, 1000),
      readAt: null,
      createdAt: new Date().toISOString()
    };
    data.notices.unshift(notice);
    writeJsonData(data);
    return res.status(201).json(notice);
  }

  const result = await pool.query(
    `INSERT INTO notices (id, from_user_id, to_user_id, table_id, type, message)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, from_user_id AS "fromUserId", to_user_id AS "toUserId", table_id AS "tableId",
               type, message, read_at AS "readAt", created_at AS "createdAt"`,
    [crypto.randomUUID(), req.user.sub, toUserId, tableId, String(type).slice(0, 40), message.trim().slice(0, 1000)]
  );
  res.status(201).json(result.rows[0]);
}));

app.get('/api/backup', authMiddleware, adminMiddleware, asyncRoute(async (_req, res) => {
  let records;
  if (JSON_MODE) {
    records = readJsonData();
  } else {
    const [users, tables, products, orders, items, payments, notices, settings] = await Promise.all([
      pool.query('SELECT * FROM users ORDER BY created_at'),
      pool.query('SELECT * FROM restaurant_tables ORDER BY number'),
      pool.query('SELECT * FROM products ORDER BY category, name'),
      pool.query('SELECT * FROM orders ORDER BY created_at'),
      pool.query('SELECT * FROM order_items ORDER BY created_at'),
      pool.query('SELECT * FROM payments ORDER BY created_at'),
      pool.query('SELECT * FROM notices ORDER BY created_at'),
      pool.query('SELECT * FROM app_settings ORDER BY key')
    ]);
    records = {
      users: users.rows,
      tables: tables.rows,
      products: products.rows,
      orders: orders.rows,
      orderItems: items.rows,
      payments: payments.rows,
      notices: notices.rows,
      settings: settings.rows
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
  app.listen(PORT, () => console.log(`Comanda disponível em http://localhost:${PORT}`));
}

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
  if (pool) await pool.end();
});