ALTER TABLE "upload_tasks"
  ADD COLUMN "temporary_cleaned_at" TIMESTAMP(3);

CREATE INDEX "upload_tasks_status_temporary_cleaned_at_idx"
  ON "upload_tasks"("status", "temporary_cleaned_at");
