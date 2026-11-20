ALTER TABLE `upload_tasks` ADD COLUMN `cover_homepage_path` LONGTEXT NULL;
ALTER TABLE `upload_tasks` ADD COLUMN `cover_content_md5` VARCHAR(24) NULL;
ALTER TABLE `upload_tasks` ADD COLUMN `cover_size` INTEGER NULL;
ALTER TABLE `upload_tasks` ADD COLUMN `cover_storage_key` VARCHAR(191) NULL;

CREATE INDEX `upload_tasks_cover_storage_key_idx` ON `upload_tasks` (`cover_storage_key`);
