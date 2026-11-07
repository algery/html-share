CREATE TABLE IF NOT EXISTS "project_square_covers" (
  "project_id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "revision_id" UUID NOT NULL,
  "homepage_path" TEXT NOT NULL,
  "target_hash" CHAR(64) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  "lease_id" UUID,
  "leased_until" TIMESTAMP(3),
  "private_image_key" VARCHAR(191),
  "width" INTEGER,
  "height" INTEGER,
  "generated_at" TIMESTAMP(3),
  "updated_at" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("project_id"),
  CONSTRAINT "project_square_covers_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "demo_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "project_square_covers_status_next_attempt_at_idx" ON "project_square_covers" ("status", "next_attempt_at");
