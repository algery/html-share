-- V1.5 keeps existing password hashes untouched. Legacy password projects
-- therefore continue to authenticate, while their plaintext remains unavailable
-- until the owner explicitly regenerates it.
ALTER TABLE "demo_projects"
  ADD COLUMN IF NOT EXISTS "encrypted_password" TEXT;

ALTER TABLE "upload_tasks"
  ADD COLUMN IF NOT EXISTS "pending_encrypted_password" TEXT;

ALTER TABLE "demo_projects"
  DROP CONSTRAINT IF EXISTS "demo_projects_password_access_check";

ALTER TABLE "demo_projects"
  ADD CONSTRAINT "demo_projects_password_access_check" CHECK (
    "password_version" >= 0 AND (
      (
        "access_mode" = 'organization' AND
        "password_hash" IS NULL AND
        "encrypted_password" IS NULL
      ) OR
      (
        "access_mode" = 'password' AND
        "password_hash" IS NOT NULL AND
        length(trim("password_hash")) > 0 AND
        "password_version" > 0
      )
    )
  );

ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'PASSWORD_ACCESS_ENABLE';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'PASSWORD_ACCESS_REGENERATE';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'PASSWORD_ACCESS_DISABLE';
