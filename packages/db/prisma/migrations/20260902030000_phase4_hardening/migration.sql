ALTER TABLE "upload_tasks"
  ADD COLUMN "declared_archive_size" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "claimed_at" TIMESTAMP(3),
  ADD COLUMN "staged_object_keys" JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX "upload_tasks_status_claimed_at_expires_at_idx"
  ON "upload_tasks"("status", "claimed_at", "expires_at");
