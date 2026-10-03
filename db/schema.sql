CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(160) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role VARCHAR(40) NOT NULL DEFAULT 'admin',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  pin_hash TEXT,
  legacy_reference VARCHAR(160),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS pin_hash TEXT,
  ADD COLUMN IF NOT EXISTS legacy_reference VARCHAR(160);

CREATE TABLE IF NOT EXISTS restaurant_tables (
  id UUID PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'free' CHECK (status IN ('free', 'occupied')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE restaurant_tables ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY,
  name VARCHAR(180) NOT NULL,
  category VARCHAR(80) NOT NULL,
  price NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  production_station VARCHAR(20) NOT NULL DEFAULT 'kitchen' CHECK (production_station IN ('kitchen', 'bar')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS production_station VARCHAR(20) NOT NULL DEFAULT 'kitchen';

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY,
  table_id UUID NOT NULL REFERENCES restaurant_tables(id) ON DELETE RESTRICT,
  waiter_id UUID REFERENCES users(id) ON DELETE SET NULL,
  waiter_name VARCHAR(120) NOT NULL DEFAULT 'Garçom',
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  discount_type VARCHAR(20) CHECK (discount_type IN ('percent', 'value')),
  discount_value NUMERIC(10,2),
  discount_authorized_by UUID REFERENCES users(id) ON DELETE SET NULL,
  discount_authorized_at TIMESTAMPTZ,
  service_fee_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  service_fee_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (service_fee_percent BETWEEN 0 AND 100),
  service_fee_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  paid_total NUMERIC(10,2) NOT NULL DEFAULT 0,
  notes TEXT,
  cancelled_at TIMESTAMPTZ,
  cancelled_by UUID REFERENCES users(id) ON DELETE SET NULL,
  cancellation_reason TEXT,
  merged_into_order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  legacy_reference VARCHAR(160)
);

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS discount_type VARCHAR(20),
  ADD COLUMN IF NOT EXISTS discount_value NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS discount_authorized_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS discount_authorized_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS service_fee_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS service_fee_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS service_fee_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS waiter_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
  ADD COLUMN IF NOT EXISTS merged_into_order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS legacy_reference VARCHAR(160);

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders
  ADD CONSTRAINT orders_status_check CHECK (status IN ('open', 'closed', 'cancelled'));

CREATE UNIQUE INDEX IF NOT EXISTS orders_open_table_unique
  ON orders (table_id)
  WHERE status = 'open';
CREATE UNIQUE INDEX IF NOT EXISTS orders_legacy_reference_unique
  ON orders (legacy_reference)
  WHERE legacy_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS order_items (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  product_name VARCHAR(180) NOT NULL,
  production_station VARCHAR(20) NOT NULL DEFAULT 'kitchen'
    CHECK (production_station IN ('kitchen', 'bar')),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  price NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  production_status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (production_status IN ('pending', 'preparing', 'ready')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_id, product_id)
);

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS production_station VARCHAR(20) NOT NULL DEFAULT 'kitchen',
  ADD COLUMN IF NOT EXISTS production_status VARCHAR(20) NOT NULL DEFAULT 'pending';

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  method VARCHAR(20) NOT NULL CHECK (method IN ('dinheiro', 'pix', 'debito', 'credito')),
  amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  received NUMERIC(10,2),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'paid' CHECK (status IN ('paid', 'reversed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS details JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE payments
  ADD CONSTRAINT payments_status_check CHECK (status IN ('paid', 'reversed'));

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

CREATE TABLE IF NOT EXISTS notice_reads (
  notice_id UUID NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (notice_id, user_id)
);

CREATE TABLE IF NOT EXISTS app_settings (
  key VARCHAR(80) PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS migration_imports (
  source_hash CHAR(64) PRIMARY KEY,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  result JSONB NOT NULL,
  source_data JSONB NOT NULL
);

ALTER TABLE migration_imports ADD COLUMN IF NOT EXISTS source_data JSONB;
UPDATE migration_imports SET source_data = '{}'::jsonb WHERE source_data IS NULL;
ALTER TABLE migration_imports ALTER COLUMN source_data SET NOT NULL;

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_name VARCHAR(120) NOT NULL,
  action VARCHAR(80) NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events (created_at DESC);

INSERT INTO app_settings (key, value)
VALUES ('restaurant_name', 'Comanda')
ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value)
VALUES ('table_count', '8')
ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value)
VALUES ('allow_discount', 'true'), ('require_waiter', 'true'),
       ('service_fee_percent', '10'), ('service_fee_default', 'false'),
       ('discount_limit', '10')
ON CONFLICT (key) DO NOTHING;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app_settings WHERE key = 'production_station_migration_v1'
  ) THEN
    UPDATE products
       SET production_station = 'bar'
     WHERE category ILIKE '%bebida%' OR category ILIKE '%cerveja%' OR category ILIKE '%drink%';

    INSERT INTO app_settings (key, value)
    VALUES ('production_station_migration_v1', 'done')
    ON CONFLICT (key) DO NOTHING;
  END IF;
END;
$migration$;

CREATE INDEX IF NOT EXISTS users_email_idx ON users (LOWER(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique ON users (LOWER(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_legacy_reference_unique
  ON users (legacy_reference) WHERE legacy_reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS restaurant_tables_number_idx ON restaurant_tables (number);
CREATE INDEX IF NOT EXISTS orders_table_idx ON orders (table_id);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status, closed_at DESC);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id);
CREATE INDEX IF NOT EXISTS order_items_production_idx ON order_items (production_status, created_at);
CREATE INDEX IF NOT EXISTS notices_user_idx ON notices (to_user_id, created_at DESC);
