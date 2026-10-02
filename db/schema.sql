CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(160) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role VARCHAR(40) NOT NULL DEFAULT 'admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS restaurant_tables (
  id UUID PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'free' CHECK (status IN ('free', 'occupied')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY,
  name VARCHAR(180) NOT NULL,
  category VARCHAR(80) NOT NULL,
  price NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY,
  table_id UUID NOT NULL REFERENCES restaurant_tables(id) ON DELETE RESTRICT,
  waiter_name VARCHAR(120) NOT NULL DEFAULT 'Garçom',
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  paid_total NUMERIC(10,2) NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS orders_open_table_unique
  ON orders (table_id)
  WHERE status = 'open';

CREATE TABLE IF NOT EXISTS order_items (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  product_name VARCHAR(180) NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  price NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_id, product_id)
);

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  method VARCHAR(20) NOT NULL CHECK (method IN ('dinheiro', 'pix', 'debito', 'credito')),
  amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  received NUMERIC(10,2),
  status VARCHAR(20) NOT NULL DEFAULT 'paid' CHECK (status IN ('paid')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notices (
  id UUID PRIMARY KEY,
  from_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  table_id UUID REFERENCES restaurant_tables(id) ON DELETE SET NULL,
  type VARCHAR(40) NOT NULL DEFAULT 'message',
  message TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS users_email_idx ON users (LOWER(email));
CREATE INDEX IF NOT EXISTS restaurant_tables_number_idx ON restaurant_tables (number);
CREATE INDEX IF NOT EXISTS orders_table_idx ON orders (table_id);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status, closed_at DESC);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id);
CREATE INDEX IF NOT EXISTS notices_user_idx ON notices (to_user_id, created_at DESC);
