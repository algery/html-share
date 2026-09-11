CREATE TYPE "cleanup_job_kind" AS ENUM ('PROJECT', 'REVISION', 'UPLOAD', 'AUTH_STATE');
CREATE TYPE "cleanup_job_status" AS ENUM ('PENDING', 'RUNNING', 'RETRY', 'COMPLETED');
CREATE TYPE "audit_action" AS ENUM ('PROJECT_DELETE');

ALTER TABLE "demo_projects" ADD COLUMN "deleted_at" TIMESTAMP(3);
CREATE INDEX "demo_projects_status_deleted_at_idx" ON "demo_projects"("status", "deleted_at");

CREATE TABLE "cleanup_jobs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "kind" "cleanup_job_kind" NOT NULL,
  "target_id" TEXT NOT NULL,
  "object_keys" JSONB NOT NULL DEFAULT '[]',
  "status" "cleanup_job_status" NOT NULL DEFAULT 'PENDING',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "run_after" TIMESTAMP(3) NOT NULL,
  "last_error" VARCHAR(120),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "cleanup_jobs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "cleanup_jobs_kind_target_id_key" ON "cleanup_jobs"("kind", "target_id");
CREATE INDEX "cleanup_jobs_status_run_after_idx" ON "cleanup_jobs"("status", "run_after");

CREATE TABLE "audit_logs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "action" "audit_action" NOT NULL,
  "actor_user_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "owner_user_id" UUID NOT NULL,
  "reason" VARCHAR(500),
  "request_ip" VARCHAR(64) NOT NULL,
  "trace_id" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "audit_logs_project_id_created_at_idx" ON "audit_logs"("project_id", "created_at");
CREATE INDEX "audit_logs_actor_user_id_created_at_idx" ON "audit_logs"("actor_user_id", "created_at");
