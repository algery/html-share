-- Additive defaults preserve every existing project's organization-only access.
ALTER TABLE "demo_projects"
  ADD COLUMN IF NOT EXISTS "access_mode" TEXT NOT NULL DEFAULT 'organization',
  ADD COLUMN IF NOT EXISTS "password_hash" TEXT,
  ADD COLUMN IF NOT EXISTS "password_version" INTEGER NOT NULL DEFAULT 0;

-- NULL pending/requested values distinguish legacy tasks from explicit settings.
ALTER TABLE "upload_tasks"
  ADD COLUMN IF NOT EXISTS "requested_access_mode" TEXT,
  ADD COLUMN IF NOT EXISTS "regenerate_password" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "pending_access_mode" TEXT,
  ADD COLUMN IF NOT EXISTS "pending_password_hash" TEXT,
  ADD COLUMN IF NOT EXISTS "pending_password_version" INTEGER,
  ADD COLUMN IF NOT EXISTS "encrypted_password_result" TEXT,
  ADD COLUMN IF NOT EXISTS "password_result_expires_at" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "password_access_grants" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "password_version" INTEGER NOT NULL,
  "grant_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "password_access_grants_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'demo_projects_password_access_check' AND conrelid = 'demo_projects'::regclass) THEN
    ALTER TABLE "demo_projects" ADD CONSTRAINT "demo_projects_password_access_check" CHECK (
      "password_version" >= 0 AND (
        ("access_mode" = 'organization' AND "password_hash" IS NULL) OR
        ("access_mode" = 'password' AND "password_hash" IS NOT NULL AND length(trim("password_hash")) > 0 AND "password_version" > 0)
      )
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'upload_tasks_password_access_check' AND conrelid = 'upload_tasks'::regclass) THEN
    ALTER TABLE "upload_tasks" ADD CONSTRAINT "upload_tasks_password_access_check" CHECK (
      ("requested_access_mode" IS NULL OR "requested_access_mode" IN ('organization', 'password')) AND
      ("pending_access_mode" IS NULL OR "pending_access_mode" IN ('organization', 'password')) AND
      ("pending_password_version" IS NULL OR "pending_password_version" >= 0) AND
      ("pending_password_hash" IS NULL OR length(trim("pending_password_hash")) > 0)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'password_access_grants_tenant_id_fkey' AND conrelid = 'password_access_grants'::regclass) THEN
    ALTER TABLE "password_access_grants" ADD CONSTRAINT "password_access_grants_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'password_access_grants_project_id_fkey' AND conrelid = 'password_access_grants'::regclass) THEN
    ALTER TABLE "password_access_grants" ADD CONSTRAINT "password_access_grants_project_id_fkey"
      FOREIGN KEY ("project_id") REFERENCES "demo_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "password_access_grants_grant_hash_key" ON "password_access_grants"("grant_hash");
CREATE INDEX IF NOT EXISTS "password_access_grants_tenant_id_project_id_password_version_idx"
  ON "password_access_grants"("tenant_id", "project_id", "password_version");
CREATE INDEX IF NOT EXISTS "password_access_grants_expires_at_idx" ON "password_access_grants"("expires_at");
CREATE INDEX IF NOT EXISTS "password_access_grants_revoked_at_idx" ON "password_access_grants"("revoked_at");
CREATE INDEX IF NOT EXISTS "upload_tasks_password_result_expires_at_idx" ON "upload_tasks"("password_result_expires_at");
