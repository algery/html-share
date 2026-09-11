CREATE TABLE "object_sweep_states" (
    "id" VARCHAR(32) NOT NULL,
    "continuation_token" TEXT,
    "run_after" TIMESTAMP(3) NOT NULL,
    "claimed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "object_sweep_states_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "object_sweep_states_run_after_claimed_at_idx"
ON "object_sweep_states"("run_after", "claimed_at");

-- Failed direct-upload metadata must remain for the 24-hour idempotency window.
UPDATE "revisions" AS revision
SET "cleanup_after" = GREATEST(
    revision."cleanup_after",
    upload."created_at" + INTERVAL '24 hours'
)
FROM "upload_tasks" AS upload
WHERE upload."revision_id" = revision."id"
  AND revision."status" = 'FAILED';
