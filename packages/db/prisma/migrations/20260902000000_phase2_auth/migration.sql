CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  CREATE TYPE tenant_status AS ENUM ('ACTIVE', 'DISABLED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE user_status AS ENUM ('ACTIVE', 'DISABLED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE access_audience AS ENUM ('APP', 'DEMO');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  dingtalk_app_key_ref TEXT NOT NULL UNIQUE,
  status tenant_status NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  dingtalk_user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status user_status NOT NULL DEFAULT 'ACTIVE',
  last_login_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_tenant_id_dingtalk_user_id_key UNIQUE (tenant_id, dingtalk_user_id)
);

CREATE TABLE IF NOT EXISTS access_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_digest TEXT NOT NULL UNIQUE,
  audience access_audience NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_digest TEXT NOT NULL UNIQUE,
  audience access_audience NOT NULL,
  return_path TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS access_sessions_user_id_audience_idx
  ON access_sessions(user_id, audience);
CREATE INDEX IF NOT EXISTS access_sessions_audience_expires_at_idx
  ON access_sessions(audience, expires_at);
CREATE INDEX IF NOT EXISTS auth_states_audience_expires_at_idx
  ON auth_states(audience, expires_at);
