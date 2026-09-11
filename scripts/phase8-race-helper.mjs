import { spawn } from "node:child_process";

export function beginLockedPublication({ composeProject, projectKey, storageKey }) {
  let markLocked;
  let rejectLocked;
  let lockSeen = false;
  const locked = new Promise((resolve, reject) => {
    markLocked = resolve;
    rejectLocked = reject;
  });
  let output = "";
  let errors = "";
  const child = spawn("docker", [
    "compose",
    ...(composeProject === undefined ? [] : ["--project-name", composeProject]),
    "--env-file",
    ".env.example",
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "html_share",
    "-d",
    "html_share",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `BEGIN;
     SELECT 1 FROM demo_projects WHERE project_key = '${projectKey}' FOR UPDATE;
     SELECT 'PHASE8_RACE_LOCKED';
     SELECT pg_sleep(1);
     WITH project AS (
       SELECT id, tenant_id FROM demo_projects WHERE project_key = '${projectKey}'
     ), revision AS (
       INSERT INTO revisions (tenant_id, project_id, revision_number, status, file_count, total_size, updated_at)
       SELECT project.tenant_id, project.id,
         (SELECT COALESCE(MAX(revision_number), 0) + 1 FROM revisions WHERE project_id = project.id),
         'ACTIVE'::revision_status, 1, 10, now()
       FROM project
       RETURNING id, tenant_id, project_id
     )
     INSERT INTO file_objects (tenant_id, project_id, revision_id, relative_path, size, content_hash, mime_type, storage_key)
     SELECT tenant_id, project_id, id, 'published-during-delete.html', 10,
       repeat('0', 64), 'text/html', '${storageKey}'
     FROM revision;
     COMMIT;`,
  ]);
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
    if (output.includes("PHASE8_RACE_LOCKED")) {
      lockSeen = true;
      markLocked();
    }
  });
  child.stderr.on("data", (chunk) => {
    errors += String(chunk);
  });
  const completed = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      if (!lockSeen) rejectLocked(error);
      reject(error);
    });
    child.once("exit", (code) => {
      if (code === 0) return resolve(undefined);
      const error = new Error(`race publisher failed (${code}): ${errors || output}`);
      if (!lockSeen) rejectLocked(error);
      reject(error);
    });
  });
  return { completed, locked };
}
