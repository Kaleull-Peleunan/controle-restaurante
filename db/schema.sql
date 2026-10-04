CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  slug VARCHAR(60) NOT NULL UNIQUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key VARCHAR(100) NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, key)
);

CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events (created_at DESC);

INSERT INTO app_settings (key, value)
VALUES ('restaurant_name', 'Comanda')
ON CONFLICT DO NOTHING;
INSERT INTO app_settings (key, value)
VALUES ('table_count', '8')
ON CONFLICT DO NOTHING;
INSERT INTO app_settings (key, value)
VALUES ('allow_discount', 'true'), ('require_waiter', 'true'),
       ('service_fee_percent', '10'), ('service_fee_default', 'false'),
       ('discount_limit', '10')
ON CONFLICT DO NOTHING;

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
    ON CONFLICT DO NOTHING;
  END IF;
END;
$migration$;

CREATE INDEX IF NOT EXISTS users_email_idx ON users (LOWER(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_legacy_reference_unique
  ON users (legacy_reference) WHERE legacy_reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS restaurant_tables_number_idx ON restaurant_tables (number);
CREATE INDEX IF NOT EXISTS orders_table_idx ON orders (table_id);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status, closed_at DESC);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id);
CREATE INDEX IF NOT EXISTS order_items_production_idx ON order_items (production_status, created_at);
CREATE INDEX IF NOT EXISTS notices_user_idx ON notices (to_user_id, created_at DESC);

INSERT INTO tenants (id, name, slug)
VALUES ('00000000-0000-4000-8000-000000000001', 'Comanda', 'legado')
ON CONFLICT (id) DO NOTHING;

DO $tenant_migration$
DECLARE
  table_name TEXT;
  constraint_name TEXT;
  tenant_tables TEXT[] := ARRAY[
    'users', 'restaurant_tables', 'products', 'orders', 'order_items',
    'payments', 'notices', 'notice_reads', 'app_settings',
    'migration_imports', 'audit_events', 'idempotency_keys'
  ];
BEGIN
  FOREACH table_name IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id UUID', table_name);
    EXECUTE format('UPDATE %I SET tenant_id = $1 WHERE tenant_id IS NULL', table_name)
      USING '00000000-0000-4000-8000-000000000001'::uuid;
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT current_setting(''app.tenant_id'')::uuid',
      table_name
    );
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL', table_name);
    constraint_name := table_name || '_tenant_id_fkey';
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = constraint_name) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE',
        table_name,
        constraint_name
      );
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END
$tenant_migration$;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
DROP INDEX IF EXISTS users_email_lower_unique;
CREATE UNIQUE INDEX IF NOT EXISTS users_tenant_email_unique
  ON users (tenant_id, LOWER(email));
DROP INDEX IF EXISTS restaurant_tables_number_idx;
ALTER TABLE restaurant_tables DROP CONSTRAINT IF EXISTS restaurant_tables_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS restaurant_tables_tenant_number_unique
  ON restaurant_tables (tenant_id, number);
DROP INDEX IF EXISTS orders_open_table_unique;
CREATE UNIQUE INDEX orders_open_table_unique
  ON orders (tenant_id, table_id)
  WHERE status = 'open';
ALTER TABLE app_settings DROP CONSTRAINT IF EXISTS app_settings_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS app_settings_tenant_key_unique
  ON app_settings (tenant_id, key);
ALTER TABLE migration_imports DROP CONSTRAINT IF EXISTS migration_imports_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS migration_imports_tenant_hash_unique
  ON migration_imports (tenant_id, source_hash);
