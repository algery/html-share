CREATE TYPE "demo_project_status" AS ENUM ('PENDING', 'ACTIVE', 'DELETED');
CREATE TYPE "revision_status" AS ENUM ('PENDING', 'ACTIVE', 'FAILED', 'OBSOLETE');
CREATE TYPE "upload_action" AS ENUM ('CREATE', 'REPLACE');
CREATE TYPE "upload_task_status" AS ENUM ('PREPARED', 'PROCESSING', 'COMPLETED', 'FAILED', 'EXPIRED');
CREATE TYPE "quota_reservation_status" AS ENUM ('RESERVED', 'SETTLED', 'RELEASED');

CREATE TABLE "demo_projects" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "owner_user_id" UUID NOT NULL,
  "project_key" VARCHAR(5) NOT NULL,
  "display_name" VARCHAR(80) NOT NULL,
  "status" "demo_project_status" NOT NULL DEFAULT 'PENDING',
  "current_revision_id" UUID,
  "file_count" INTEGER NOT NULL DEFAULT 0,
  "total_size" BIGINT NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "demo_projects_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "revisions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "revision_number" INTEGER NOT NULL,
  "status" "revision_status" NOT NULL DEFAULT 'PENDING',
  "file_count" INTEGER NOT NULL DEFAULT 0,
  "total_size" BIGINT NOT NULL DEFAULT 0,
  "cleanup_after" TIMESTAMP(3),
  "published_at" TIMESTAMP(3),
  "failed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "revisions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "upload_tasks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "owner_user_id" UUID NOT NULL,
  "revision_id" UUID NOT NULL,
  "action" "upload_action" NOT NULL,
  "status" "upload_task_status" NOT NULL DEFAULT 'PREPARED',
  "display_name" VARCHAR(80) NOT NULL,
  "target_html" TEXT NOT NULL,
  "declared_file_count" INTEGER NOT NULL,
  "declared_total_size" BIGINT NOT NULL,
  "manifest_digest" VARCHAR(64) NOT NULL,
  "risk_ack_digest" VARCHAR(64),
  "client_request_id" UUID NOT NULL,
  "temporary_object_key" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "completed_at" TIMESTAMP(3),
  "failed_at" TIMESTAMP(3),
  "failure_code" VARCHAR(80),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "upload_tasks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "file_objects" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "revision_id" UUID NOT NULL,
  "relative_path" TEXT NOT NULL,
  "size" BIGINT NOT NULL,
  "content_hash" VARCHAR(64) NOT NULL,
  "mime_type" VARCHAR(255) NOT NULL,
  "storage_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "file_objects_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "quota_reservations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "upload_task_id" UUID NOT NULL,
  "project_delta" INTEGER NOT NULL,
  "storage_bytes" BIGINT NOT NULL,
  "status" "quota_reservation_status" NOT NULL DEFAULT 'RESERVED',
  "expires_at" TIMESTAMP(3) NOT NULL,
  "settled_at" TIMESTAMP(3),
  "released_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "quota_reservations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "demo_projects_project_key_key" ON "demo_projects"("project_key");
CREATE UNIQUE INDEX "demo_projects_current_revision_id_key" ON "demo_projects"("current_revision_id");
CREATE INDEX "demo_projects_owner_user_id_status_idx" ON "demo_projects"("owner_user_id", "status");
CREATE INDEX "demo_projects_tenant_id_status_idx" ON "demo_projects"("tenant_id", "status");
CREATE UNIQUE INDEX "revisions_project_id_revision_number_key" ON "revisions"("project_id", "revision_number");
CREATE INDEX "revisions_tenant_id_status_idx" ON "revisions"("tenant_id", "status");
CREATE UNIQUE INDEX "upload_tasks_temporary_object_key_key" ON "upload_tasks"("temporary_object_key");
CREATE INDEX "upload_tasks_owner_user_id_client_request_id_created_at_idx" ON "upload_tasks"("owner_user_id", "client_request_id", "created_at");
CREATE INDEX "upload_tasks_status_expires_at_idx" ON "upload_tasks"("status", "expires_at");
CREATE INDEX "upload_tasks_project_id_status_idx" ON "upload_tasks"("project_id", "status");
CREATE UNIQUE INDEX "upload_tasks_one_active_task_per_project" ON "upload_tasks"("project_id") WHERE "status" IN ('PREPARED', 'PROCESSING');
CREATE UNIQUE INDEX "file_objects_storage_key_key" ON "file_objects"("storage_key");
CREATE UNIQUE INDEX "file_objects_project_id_revision_id_relative_path_key" ON "file_objects"("project_id", "revision_id", "relative_path");
CREATE INDEX "file_objects_tenant_id_project_id_revision_id_idx" ON "file_objects"("tenant_id", "project_id", "revision_id");
CREATE UNIQUE INDEX "quota_reservations_upload_task_id_key" ON "quota_reservations"("upload_task_id");
CREATE INDEX "quota_reservations_tenant_id_user_id_status_expires_at_idx" ON "quota_reservations"("tenant_id", "user_id", "status", "expires_at");

ALTER TABLE "demo_projects" ADD CONSTRAINT "demo_projects_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "demo_projects" ADD CONSTRAINT "demo_projects_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "demo_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "upload_tasks" ADD CONSTRAINT "upload_tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "demo_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "upload_tasks" ADD CONSTRAINT "upload_tasks_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "upload_tasks" ADD CONSTRAINT "upload_tasks_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "demo_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quota_reservations" ADD CONSTRAINT "quota_reservations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quota_reservations" ADD CONSTRAINT "quota_reservations_upload_task_id_fkey" FOREIGN KEY ("upload_task_id") REFERENCES "upload_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "demo_projects" ADD CONSTRAINT "demo_projects_current_revision_id_fkey" FOREIGN KEY ("current_revision_id") REFERENCES "revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
