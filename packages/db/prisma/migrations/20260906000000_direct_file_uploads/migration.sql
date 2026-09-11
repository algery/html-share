CREATE TYPE "upload_file_verification_status" AS ENUM ('PENDING', 'VERIFIED');

ALTER TABLE "upload_tasks"
  ALTER COLUMN "declared_archive_size" DROP NOT NULL,
  ALTER COLUMN "temporary_object_key" DROP NOT NULL;

CREATE TABLE "upload_files" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "upload_task_id" UUID NOT NULL,
  "revision_id" UUID NOT NULL,
  "relative_path" TEXT NOT NULL,
  "expected_size" BIGINT NOT NULL,
  "expected_sha256" VARCHAR(64) NOT NULL,
  "expected_content_md5" VARCHAR(24) NOT NULL,
  "mime_type" VARCHAR(255) NOT NULL,
  "storage_key" TEXT NOT NULL,
  "verification_status" "upload_file_verification_status" NOT NULL DEFAULT 'PENDING',
  "verified_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "upload_files_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "upload_files_storage_key_key" ON "upload_files"("storage_key");
CREATE UNIQUE INDEX "upload_files_upload_task_id_relative_path_key"
  ON "upload_files"("upload_task_id", "relative_path");
CREATE INDEX "upload_files_tenant_id_upload_task_id_verification_status_idx"
  ON "upload_files"("tenant_id", "upload_task_id", "verification_status");
CREATE INDEX "upload_files_revision_id_idx" ON "upload_files"("revision_id");

ALTER TABLE "upload_files"
  ADD CONSTRAINT "upload_files_upload_task_id_fkey"
  FOREIGN KEY ("upload_task_id") REFERENCES "upload_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "upload_files"
  ADD CONSTRAINT "upload_files_revision_id_fkey"
  FOREIGN KEY ("revision_id") REFERENCES "revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing active ZIP tasks cannot be safely resumed under the direct-file protocol.
-- Fail only transient tasks; active projects and their current revisions remain untouched.
UPDATE "upload_tasks"
SET "status" = 'FAILED',
    "failed_at" = CURRENT_TIMESTAMP,
    "failure_code" = 'UPLOAD_PROTOCOL_UNSUPPORTED',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "status" IN ('PREPARED', 'PROCESSING');

UPDATE "revisions" AS revision
SET "status" = 'FAILED',
    "failed_at" = CURRENT_TIMESTAMP,
    "cleanup_after" = GREATEST(
      CURRENT_TIMESTAMP,
      COALESCE((
        SELECT MAX(upload."expires_at") + INTERVAL '1 minute'
        FROM "upload_tasks" AS upload
        WHERE upload."revision_id" = revision."id"
          AND upload."failure_code" = 'UPLOAD_PROTOCOL_UNSUPPORTED'
      ), CURRENT_TIMESTAMP)
    ),
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" IN (
  SELECT "revision_id" FROM "upload_tasks" WHERE "failure_code" = 'UPLOAD_PROTOCOL_UNSUPPORTED'
)
AND "status" = 'PENDING';

UPDATE "quota_reservations"
SET "status" = 'RELEASED',
    "released_at" = CURRENT_TIMESTAMP,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "upload_task_id" IN (
  SELECT "id" FROM "upload_tasks" WHERE "failure_code" = 'UPLOAD_PROTOCOL_UNSUPPORTED'
)
AND "status" = 'RESERVED';
