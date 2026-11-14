ALTER TABLE "users" ALTER COLUMN "dingtalk_user_id" DROP NOT NULL;

CREATE TABLE IF NOT EXISTS "feishu_identities" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "identity_key" VARCHAR(64) NOT NULL,
  "feishu_app_id" VARCHAR(191) NOT NULL,
  "feishu_tenant_key" VARCHAR(191) NOT NULL,
  "feishu_open_id" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "feishu_identities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "feishu_identities_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "feishu_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "feishu_identities_tenant_id_identity_key_key" ON "feishu_identities"("tenant_id", "identity_key");
CREATE UNIQUE INDEX IF NOT EXISTS "feishu_identities_user_id_key" ON "feishu_identities"("user_id");

CREATE TABLE IF NOT EXISTS "account_contacts" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "provider" VARCHAR(16) NOT NULL,
  "phone" VARCHAR(16),
  "email" VARCHAR(254),
  "observed_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "account_contacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "account_contacts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "account_contacts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "account_contacts_user_id_provider_key" ON "account_contacts"("user_id", "provider");
CREATE INDEX IF NOT EXISTS "account_contacts_tenant_id_phone_idx" ON "account_contacts"("tenant_id", "phone");
CREATE INDEX IF NOT EXISTS "account_contacts_tenant_id_email_idx" ON "account_contacts"("tenant_id", "email");
