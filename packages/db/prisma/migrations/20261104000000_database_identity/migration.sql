-- Internal deployment identity. The singleton is stable across repeated deploys.
CREATE TABLE IF NOT EXISTS "database_identity" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "instance_id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "database_identity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "database_identity_singleton_check" CHECK ("id" = 1),
  CONSTRAINT "database_identity_instance_id_key" UNIQUE ("instance_id")
);
INSERT INTO "database_identity" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
