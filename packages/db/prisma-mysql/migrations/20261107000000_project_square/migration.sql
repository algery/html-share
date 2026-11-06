-- Preserve the historic openId login key. Union identity is populated only by trusted login.
SET @square_union_column_exists = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'dingtalk_union_id');
SET @square_union_ddl = IF(@square_union_column_exists = 0, 'ALTER TABLE `users` ADD COLUMN `dingtalk_union_id` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL', 'SELECT 1');
PREPARE square_union_statement FROM @square_union_ddl;
EXECUTE square_union_statement;
DEALLOCATE PREPARE square_union_statement;

CREATE TABLE IF NOT EXISTS `project_square_settings` (
  `id` CHAR(36) NOT NULL,
  `tenant_id` CHAR(36) NOT NULL,
  `project_id` CHAR(36) NOT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT false,
  `audience_type` VARCHAR(20),
  `settings_version` INTEGER NOT NULL DEFAULT 0,
  `selected_departments` JSON NOT NULL,
  `selected_users` JSON NOT NULL,
  `published_at` DATETIME(3),
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE (`project_id`),
  CONSTRAINT `project_square_settings_project_id_fkey` FOREIGN KEY (`project_id`) REFERENCES `demo_projects` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  INDEX `project_square_settings_tenant_id_enabled_idx` (`tenant_id`, `enabled`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS `project_square_audiences` (
  `id` CHAR(36) NOT NULL,
  `tenant_id` CHAR(36) NOT NULL,
  `project_id` CHAR(36) NOT NULL,
  `type` VARCHAR(20) NOT NULL,
  `subject_id` VARCHAR(191) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE (`project_id`, `type`, `subject_id`),
  CONSTRAINT `project_square_audiences_project_id_fkey` FOREIGN KEY (`project_id`) REFERENCES `demo_projects` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  INDEX `project_square_audiences_tenant_id_type_subject_id_idx` (`tenant_id`, `type`, `subject_id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS `square_audit_logs` (
  `id` CHAR(36) NOT NULL,
  `tenant_id` CHAR(36) NOT NULL,
  `actor_user_id` CHAR(36) NOT NULL,
  `project_id` CHAR(36),
  `action` VARCHAR(20) NOT NULL,
  `result` VARCHAR(80) NOT NULL,
  `settings_version` INTEGER NOT NULL,
  `request_ip` VARCHAR(64) NOT NULL,
  `trace_id` VARCHAR(64) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  CONSTRAINT `square_audit_logs_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  INDEX `square_audit_logs_project_id_created_at_idx` (`project_id`, `created_at`),
  INDEX `square_audit_logs_actor_user_id_created_at_idx` (`actor_user_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;
