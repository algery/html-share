DO $$
BEGIN
  CREATE TYPE mcp_token_status AS ENUM ('ACTIVE', 'REVOKED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS mcp_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_digest TEXT NOT NULL UNIQUE,
  token_suffix TEXT NOT NULL,
  status mcp_token_status NOT NULL DEFAULT 'ACTIVE',
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_tokens_user_id_created_at_idx
  ON mcp_tokens(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mcp_tokens_status_expires_at_idx
  ON mcp_tokens(status, expires_at);
