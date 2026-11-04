-- MySQL 8.4 only. Full text is retained; binary SHA-256 virtual columns index
-- UTF-8 bytes without prefix truncation. utf8mb4_0900_bin is case-sensitive/NO PAD.
-- VIRTUAL avoids MySQL's stored-generated-column restrictions on cascading FKs.
SET time_zone = '+00:00';

CREATE TABLE `mcp_tokens` (
  `id` CHAR(36) NOT NULL, `user_id` CHAR(36) NOT NULL,
  `name` LONGTEXT NOT NULL, `token_digest` LONGTEXT NOT NULL,
  `token_suffix` LONGTEXT NOT NULL, `status` ENUM('ACTIVE', 'REVOKED') NOT NULL DEFAULT 'ACTIVE',
  `expires_at` DATETIME(3) NOT NULL, `last_used_at` DATETIME(3) NULL,
  `revoked_at` DATETIME(3) NULL, `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL, `token_digest_hash` BINARY(32) GENERATED ALWAYS AS (UNHEX(SHA2(CONVERT(`token_digest` USING utf8mb4), 256))) VIRTUAL,
  INDEX `mcp_tokens_user_id_created_at_idx`(`user_id`, `created_at`), INDEX `mcp_tokens_status_expires_at_idx`(`status`, `expires_at`),
  UNIQUE INDEX `mcp_tokens_token_digest_hash_key`(`token_digest_hash`), PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

CREATE TABLE `access_sessions` (
  `id` CHAR(36) NOT NULL, `user_id` CHAR(36) NOT NULL,
  `token_digest` LONGTEXT NOT NULL, `audience` ENUM('APP', 'DEMO') NOT NULL,
  `expires_at` DATETIME(3) NOT NULL, `revoked_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updated_at` DATETIME(3) NOT NULL,
  `token_digest_hash` BINARY(32) GENERATED ALWAYS AS (UNHEX(SHA2(CONVERT(`token_digest` USING utf8mb4), 256))) VIRTUAL, INDEX `access_sessions_user_id_audience_idx`(`user_id`, `audience`),
  INDEX `access_sessions_audience_expires_at_idx`(`audience`, `expires_at`), UNIQUE INDEX `access_sessions_token_digest_hash_key`(`token_digest_hash`),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

CREATE TABLE `auth_states` (
  `id` CHAR(36) NOT NULL, `state_digest` LONGTEXT NOT NULL,
  `audience` ENUM('APP', 'DEMO') NOT NULL, `return_path` LONGTEXT NOT NULL,
  `expires_at` DATETIME(3) NOT NULL, `consumed_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updated_at` DATETIME(3) NOT NULL,
  `state_digest_hash` BINARY(32) GENERATED ALWAYS AS (UNHEX(SHA2(CONVERT(`state_digest` USING utf8mb4), 256))) VIRTUAL, INDEX `auth_states_audience_expires_at_idx`(`audience`, `expires_at`),
  UNIQUE INDEX `auth_states_state_digest_hash_key`(`state_digest_hash`), PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

CREATE TABLE `cleanup_jobs` (
  `id` CHAR(36) NOT NULL, `kind` ENUM('PROJECT', 'REVISION', 'UPLOAD', 'AUTH_STATE') NOT NULL,
  `target_id` LONGTEXT NOT NULL, `object_keys` JSON NOT NULL DEFAULT ('[]'),
  `status` ENUM('PENDING', 'RUNNING', 'RETRY', 'COMPLETED') NOT NULL DEFAULT 'PENDING', `attempt_count` INTEGER NOT NULL DEFAULT 0,
  `run_after` DATETIME(3) NOT NULL, `last_error` VARCHAR(120) NULL,
  `completed_at` DATETIME(3) NULL, `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL, `target_id_digest` BINARY(32) GENERATED ALWAYS AS (UNHEX(SHA2(CONVERT(`target_id` USING utf8mb4), 256))) VIRTUAL,
  INDEX `cleanup_jobs_status_run_after_idx`(`status`, `run_after`), UNIQUE INDEX `cleanup_jobs_kind_target_id_digest_key`(`kind`, `target_id_digest`),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

CREATE TABLE `object_sweep_states` (
  `id` VARCHAR(32) NOT NULL, `continuation_token` LONGTEXT NULL,
  `run_after` DATETIME(3) NOT NULL, `claimed_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updated_at` DATETIME(3) NOT NULL,
  INDEX `object_sweep_states_run_after_claimed_at_idx`(`run_after`, `claimed_at`), PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

CREATE TABLE `audit_logs` (
  `id` CHAR(36) NOT NULL, `action` ENUM('PROJECT_DELETE', 'ADMIN_RATE_LIMITED', 'PASSWORD_ACCESS_ENABLE', 'PASSWORD_ACCESS_REGENERATE', 'PASSWORD_ACCESS_DISABLE') NOT NULL,
  `actor_user_id` CHAR(36) NOT NULL, `project_id` CHAR(36) NULL,
  `owner_user_id` CHAR(36) NULL, `reason` VARCHAR(500) NULL,
  `request_ip` VARCHAR(64) NOT NULL, `trace_id` VARCHAR(64) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), INDEX `audit_logs_project_id_created_at_idx`(`project_id`, `created_at`),
  INDEX `audit_logs_actor_user_id_created_at_idx`(`actor_user_id`, `created_at`), PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

CREATE TABLE `database_identity` (
  `id` INTEGER NOT NULL DEFAULT 1, `instance_id` CHAR(36) NOT NULL DEFAULT (UUID()),
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `database_identity_instance_id_key`(`instance_id`), PRIMARY KEY (`id`),
  CONSTRAINT `database_identity_singleton_check` CHECK (`id` = 1)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

CREATE TABLE `tenants` (
  `id` CHAR(36) NOT NULL, `name` LONGTEXT NOT NULL,
  `dingtalk_app_key_ref` LONGTEXT NOT NULL, `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updated_at` DATETIME(3) NOT NULL,
  `app_key_digest` BINARY(32) GENERATED ALWAYS AS (UNHEX(SHA2(CONVERT(`dingtalk_app_key_ref` USING utf8mb4), 256))) VIRTUAL, UNIQUE INDEX `tenants_app_key_digest_key`(`app_key_digest`),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

CREATE TABLE `users` (
  `id` CHAR(36) NOT NULL, `tenant_id` CHAR(36) NOT NULL,
  `dingtalk_user_id` LONGTEXT NOT NULL, `display_name` LONGTEXT NOT NULL,
  `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE', `last_login_at` DATETIME(3) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updated_at` DATETIME(3) NOT NULL,
  `dingtalk_user_digest` BINARY(32) GENERATED ALWAYS AS (UNHEX(SHA2(CONVERT(`dingtalk_user_id` USING utf8mb4), 256))) VIRTUAL, UNIQUE INDEX `users_tenant_id_dingtalk_user_digest_key`(`tenant_id`, `dingtalk_user_digest`),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

CREATE TABLE `demo_projects` (
  `id` CHAR(36) NOT NULL, `tenant_id` CHAR(36) NOT NULL,
  `owner_user_id` CHAR(36) NOT NULL, `project_key` VARCHAR(5) NOT NULL,
  `display_name` VARCHAR(80) NOT NULL, `status` ENUM('PENDING', 'ACTIVE', 'DELETED') NOT NULL DEFAULT 'PENDING',
  `access_mode` LONGTEXT NOT NULL DEFAULT ('organization'), `homepage_path` LONGTEXT NULL,
  `password_hash` LONGTEXT NULL, `encrypted_password` LONGTEXT NULL,
  `password_version` INTEGER NOT NULL DEFAULT 0, `current_revision_id` CHAR(36) NULL,
  `file_count` INTEGER NOT NULL DEFAULT 0, `total_size` BIGINT NOT NULL DEFAULT 0,
  `deleted_at` DATETIME(3) NULL, `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL, UNIQUE INDEX `demo_projects_project_key_key`(`project_key`),
  UNIQUE INDEX `demo_projects_current_revision_id_key`(`current_revision_id`), INDEX `demo_projects_owner_user_id_status_idx`(`owner_user_id`, `status`),
  INDEX `demo_projects_tenant_id_status_idx`(`tenant_id`, `status`), INDEX `demo_projects_status_deleted_at_idx`(`status`, `deleted_at`),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

CREATE TABLE `revisions` (
  `id` CHAR(36) NOT NULL, `tenant_id` CHAR(36) NOT NULL,
  `project_id` CHAR(36) NOT NULL, `revision_number` INTEGER NOT NULL,
  `status` ENUM('PENDING', 'ACTIVE', 'FAILED', 'OBSOLETE') NOT NULL DEFAULT 'PENDING', `file_count` INTEGER NOT NULL DEFAULT 0,
  `total_size` BIGINT NOT NULL DEFAULT 0, `cleanup_after` DATETIME(3) NULL,
  `published_at` DATETIME(3) NULL, `failed_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updated_at` DATETIME(3) NOT NULL,
  INDEX `revisions_tenant_id_status_idx`(`tenant_id`, `status`), UNIQUE INDEX `revisions_project_id_revision_number_key`(`project_id`, `revision_number`),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

CREATE TABLE `upload_tasks` (
  `id` CHAR(36) NOT NULL, `tenant_id` CHAR(36) NOT NULL,
  `project_id` CHAR(36) NOT NULL, `owner_user_id` CHAR(36) NOT NULL,
  `revision_id` CHAR(36) NOT NULL, `action` ENUM('CREATE', 'REPLACE') NOT NULL,
  `status` ENUM('PREPARED', 'PROCESSING', 'COMPLETED', 'FAILED', 'EXPIRED') NOT NULL DEFAULT 'PREPARED', `display_name` VARCHAR(80) NOT NULL,
  `target_html` LONGTEXT NOT NULL, `declared_file_count` INTEGER NOT NULL,
  `declared_total_size` BIGINT NOT NULL, `declared_archive_size` BIGINT NULL,
  `manifest_digest` VARCHAR(64) NOT NULL, `risk_ack_digest` VARCHAR(64) NULL,
  `requested_access_mode` LONGTEXT NULL, `regenerate_password` BOOLEAN NOT NULL DEFAULT false,
  `pending_access_mode` LONGTEXT NULL, `pending_password_hash` LONGTEXT NULL,
  `pending_encrypted_password` LONGTEXT NULL, `pending_password_version` INTEGER NULL,
  `encrypted_password_result` LONGTEXT NULL, `password_result_expires_at` DATETIME(3) NULL,
  `client_request_id` CHAR(36) NOT NULL, `trace_id` VARCHAR(64) NULL,
  `temporary_object_key` LONGTEXT NULL, `expires_at` DATETIME(3) NOT NULL,
  `completed_at` DATETIME(3) NULL, `failed_at` DATETIME(3) NULL,
  `failure_code` VARCHAR(80) NULL, `claimed_at` DATETIME(3) NULL,
  `staged_object_keys` JSON NOT NULL DEFAULT ('[]'), `temporary_cleaned_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updated_at` DATETIME(3) NOT NULL,
  `temporary_object_key_digest` BINARY(32) GENERATED ALWAYS AS (UNHEX(SHA2(CONVERT(`temporary_object_key` USING utf8mb4), 256))) VIRTUAL, `active_project_id` CHAR(36) GENERATED ALWAYS AS (CASE WHEN `status` IN ('PREPARED', 'PROCESSING') THEN `project_id` ELSE NULL END) VIRTUAL,
  INDEX `upload_tasks_owner_user_id_client_request_id_created_at_idx`(`owner_user_id`, `client_request_id`, `created_at`), INDEX `upload_tasks_status_expires_at_idx`(`status`, `expires_at`),
  INDEX `upload_tasks_project_id_status_idx`(`project_id`, `status`), INDEX `upload_tasks_password_result_expires_at_idx`(`password_result_expires_at`),
  UNIQUE INDEX `upload_tasks_temporary_object_key_digest_key`(`temporary_object_key_digest`), UNIQUE INDEX `upload_tasks_one_active_task_per_project`(`active_project_id`),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

CREATE TABLE `password_access_grants` (
  `id` CHAR(36) NOT NULL, `tenant_id` CHAR(36) NOT NULL,
  `project_id` CHAR(36) NOT NULL, `password_version` INTEGER NOT NULL,
  `grant_hash` LONGTEXT NOT NULL, `expires_at` DATETIME(3) NOT NULL,
  `revoked_at` DATETIME(3) NULL, `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL, `grant_hash_digest` BINARY(32) GENERATED ALWAYS AS (UNHEX(SHA2(CONVERT(`grant_hash` USING utf8mb4), 256))) VIRTUAL,
  INDEX `password_access_grants_tenant_id_project_id_password_version_idx`(`tenant_id`, `project_id`, `password_version`), INDEX `password_access_grants_expires_at_idx`(`expires_at`),
  INDEX `password_access_grants_revoked_at_idx`(`revoked_at`), UNIQUE INDEX `password_access_grants_grant_hash_digest_key`(`grant_hash_digest`),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

CREATE TABLE `upload_files` (
  `id` CHAR(36) NOT NULL, `tenant_id` CHAR(36) NOT NULL,
  `upload_task_id` CHAR(36) NOT NULL, `revision_id` CHAR(36) NOT NULL,
  `relative_path` LONGTEXT NOT NULL, `expected_size` BIGINT NOT NULL,
  `expected_sha256` VARCHAR(64) NOT NULL, `expected_content_md5` VARCHAR(24) NOT NULL,
  `mime_type` VARCHAR(255) NOT NULL, `storage_key` LONGTEXT NOT NULL,
  `verification_status` ENUM('PENDING', 'VERIFIED') NOT NULL DEFAULT 'PENDING', `verified_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updated_at` DATETIME(3) NOT NULL,
  `relative_path_digest` BINARY(32) GENERATED ALWAYS AS (UNHEX(SHA2(CONVERT(`relative_path` USING utf8mb4), 256))) VIRTUAL, `storage_key_digest` BINARY(32) GENERATED ALWAYS AS (UNHEX(SHA2(CONVERT(`storage_key` USING utf8mb4), 256))) VIRTUAL,
  INDEX `upload_files_tenant_id_upload_task_id_verification_status_idx`(`tenant_id`, `upload_task_id`, `verification_status`), INDEX `upload_files_revision_id_idx`(`revision_id`),
  UNIQUE INDEX `upload_files_upload_task_id_relative_path_digest_key`(`upload_task_id`, `relative_path_digest`), UNIQUE INDEX `upload_files_storage_key_digest_key`(`storage_key_digest`),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

CREATE TABLE `file_objects` (
  `id` CHAR(36) NOT NULL, `tenant_id` CHAR(36) NOT NULL,
  `project_id` CHAR(36) NOT NULL, `revision_id` CHAR(36) NOT NULL,
  `relative_path` LONGTEXT NOT NULL, `size` BIGINT NOT NULL,
  `content_hash` VARCHAR(64) NOT NULL, `mime_type` VARCHAR(255) NOT NULL,
  `storage_key` LONGTEXT NOT NULL, `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `relative_path_digest` BINARY(32) GENERATED ALWAYS AS (UNHEX(SHA2(CONVERT(`relative_path` USING utf8mb4), 256))) VIRTUAL, `storage_key_digest` BINARY(32) GENERATED ALWAYS AS (UNHEX(SHA2(CONVERT(`storage_key` USING utf8mb4), 256))) VIRTUAL,
  INDEX `file_objects_tenant_id_project_id_revision_id_idx`(`tenant_id`, `project_id`, `revision_id`), UNIQUE INDEX `file_objects_project_id_revision_id_relative_path_digest_key`(`project_id`, `revision_id`, `relative_path_digest`),
  UNIQUE INDEX `file_objects_storage_key_digest_key`(`storage_key_digest`), PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

CREATE TABLE `quota_reservations` (
  `id` CHAR(36) NOT NULL, `tenant_id` CHAR(36) NOT NULL,
  `user_id` CHAR(36) NOT NULL, `upload_task_id` CHAR(36) NOT NULL,
  `project_delta` INTEGER NOT NULL, `storage_bytes` BIGINT NOT NULL,
  `status` ENUM('RESERVED', 'SETTLED', 'RELEASED') NOT NULL DEFAULT 'RESERVED', `expires_at` DATETIME(3) NOT NULL,
  `settled_at` DATETIME(3) NULL, `released_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `quota_reservations_upload_task_id_key`(`upload_task_id`), INDEX `quota_reservations_tenant_id_user_id_status_expires_at_idx`(`tenant_id`, `user_id`, `status`, `expires_at`),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

ALTER TABLE `mcp_tokens` ADD CONSTRAINT `mcp_tokens_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `access_sessions` ADD CONSTRAINT `access_sessions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `users` ADD CONSTRAINT `users_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `demo_projects` ADD CONSTRAINT `demo_projects_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `demo_projects` ADD CONSTRAINT `demo_projects_owner_user_id_fkey` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `demo_projects` ADD CONSTRAINT `demo_projects_current_revision_id_fkey` FOREIGN KEY (`current_revision_id`) REFERENCES `revisions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `revisions` ADD CONSTRAINT `revisions_project_id_fkey` FOREIGN KEY (`project_id`) REFERENCES `demo_projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `upload_tasks` ADD CONSTRAINT `upload_tasks_project_id_fkey` FOREIGN KEY (`project_id`) REFERENCES `demo_projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `upload_tasks` ADD CONSTRAINT `upload_tasks_owner_user_id_fkey` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `upload_tasks` ADD CONSTRAINT `upload_tasks_revision_id_fkey` FOREIGN KEY (`revision_id`) REFERENCES `revisions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `password_access_grants` ADD CONSTRAINT `password_access_grants_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `password_access_grants` ADD CONSTRAINT `password_access_grants_project_id_fkey` FOREIGN KEY (`project_id`) REFERENCES `demo_projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `upload_files` ADD CONSTRAINT `upload_files_upload_task_id_fkey` FOREIGN KEY (`upload_task_id`) REFERENCES `upload_tasks`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `upload_files` ADD CONSTRAINT `upload_files_revision_id_fkey` FOREIGN KEY (`revision_id`) REFERENCES `revisions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `file_objects` ADD CONSTRAINT `file_objects_revision_id_fkey` FOREIGN KEY (`revision_id`) REFERENCES `revisions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `file_objects` ADD CONSTRAINT `file_objects_project_id_fkey` FOREIGN KEY (`project_id`) REFERENCES `demo_projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `quota_reservations` ADD CONSTRAINT `quota_reservations_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `quota_reservations` ADD CONSTRAINT `quota_reservations_upload_task_id_fkey` FOREIGN KEY (`upload_task_id`) REFERENCES `upload_tasks`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX `upload_tasks_status_claimed_at_expires_at_idx` ON `upload_tasks` (`status`, `claimed_at`, `expires_at`);
CREATE INDEX `upload_tasks_status_temporary_cleaned_at_idx` ON `upload_tasks` (`status`, `temporary_cleaned_at`);

ALTER TABLE `demo_projects` ADD CONSTRAINT `demo_projects_password_access_check` CHECK (
  `password_version` >= 0 AND (
    (`access_mode` = 'organization' AND `password_hash` IS NULL AND `encrypted_password` IS NULL) OR
    (`access_mode` = 'password' AND `password_hash` IS NOT NULL AND CHAR_LENGTH(TRIM(`password_hash`)) > 0 AND `password_version` > 0)
  )
);
ALTER TABLE `upload_tasks` ADD CONSTRAINT `upload_tasks_password_access_check` CHECK (
  (`requested_access_mode` IS NULL OR `requested_access_mode` IN ('organization', 'password')) AND
  (`pending_access_mode` IS NULL OR `pending_access_mode` IN ('organization', 'password')) AND
  (`pending_password_version` IS NULL OR `pending_password_version` >= 0) AND
  (`pending_password_hash` IS NULL OR CHAR_LENGTH(TRIM(`pending_password_hash`)) > 0)
);
INSERT INTO `database_identity` (`id`, `updated_at`) VALUES (1, CURRENT_TIMESTAMP(3));
