ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "dingtalk_union_id" VARCHAR(191);

CREATE TABLE IF NOT EXISTS "project_square_settings" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "audience_type" VARCHAR(20),
  "settings_version" INTEGER NOT NULL DEFAULT 0,
  "selected_departments" JSONB NOT NULL,
  "selected_users" JSONB NOT NULL,
  "published_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  "updated_at" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("project_id"),
  CONSTRAINT "project_square_settings_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "demo_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "project_square_settings_tenant_id_enabled_idx" ON "project_square_settings" ("tenant_id", "enabled");

CREATE TABLE IF NOT EXISTS "project_square_audiences" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "type" VARCHAR(20) NOT NULL,
  "subject_id" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  "updated_at" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("project_id", "type", "subject_id"),
  CONSTRAINT "project_square_audiences_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "demo_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "project_square_audiences_tenant_id_type_subject_id_idx" ON "project_square_audiences" ("tenant_id", "type", "subject_id");

CREATE TABLE IF NOT EXISTS "square_audit_logs" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "actor_user_id" UUID NOT NULL,
  "project_id" UUID,
  "action" VARCHAR(20) NOT NULL,
  "result" VARCHAR(80) NOT NULL,
  "settings_version" INTEGER NOT NULL,
  "request_ip" VARCHAR(64) NOT NULL,
  "trace_id" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  "updated_at" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "square_audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "square_audit_logs_project_id_created_at_idx" ON "square_audit_logs" ("project_id", "created_at");
CREATE INDEX IF NOT EXISTS "square_audit_logs_actor_user_id_created_at_idx" ON "square_audit_logs" ("actor_user_id", "created_at");
