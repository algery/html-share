ALTER TABLE `users` MODIFY COLUMN `dingtalk_user_id` LONGTEXT NULL;

CREATE TABLE IF NOT EXISTS `feishu_identities` (
  `id` CHAR(36) NOT NULL,
  `tenant_id` CHAR(36) NOT NULL,
  `user_id` CHAR(36) NOT NULL,
  `identity_key` VARCHAR(64) NOT NULL,
  `feishu_app_id` VARCHAR(191) NOT NULL,
  `feishu_tenant_key` VARCHAR(191) NOT NULL,
  `feishu_open_id` VARCHAR(191) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `feishu_identities_tenant_id_identity_key_key` (`tenant_id`, `identity_key`),
  UNIQUE INDEX `feishu_identities_user_id_key` (`user_id`),
  CONSTRAINT `feishu_identities_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `feishu_identities_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS `account_contacts` (
  `id` CHAR(36) NOT NULL,
  `tenant_id` CHAR(36) NOT NULL,
  `user_id` CHAR(36) NOT NULL,
  `provider` VARCHAR(16) NOT NULL,
  `phone` VARCHAR(16) NULL,
  `email` VARCHAR(254) NULL,
  `observed_at` DATETIME(3) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `account_contacts_user_id_provider_key` (`user_id`, `provider`),
  INDEX `account_contacts_tenant_id_phone_idx` (`tenant_id`, `phone`),
  INDEX `account_contacts_tenant_id_email_idx` (`tenant_id`, `email`),
  CONSTRAINT `account_contacts_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `account_contacts_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;
