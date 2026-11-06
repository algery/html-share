// Recognize exactly the reviewed guarded ALTER block. Never interpret arbitrary
// PREPARE/SET SQL; any other dynamic statement remains unsupported and fails closed.
const guardedUnionColumn = `SET @square_union_column_exists = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'dingtalk_union_id');
SET @square_union_ddl = IF(@square_union_column_exists = 0, 'ALTER TABLE \`users\` ADD COLUMN \`dingtalk_union_id\` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL', 'SELECT 1');
PREPARE square_union_statement FROM @square_union_ddl;
EXECUTE square_union_statement;
DEALLOCATE PREPARE square_union_statement;`;
export const unionColumnDefinition =
  "VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL";
export function normalizeSquareMysqlDdl(sql) {
  return sql.replace(
    guardedUnionColumn,
    `ALTER TABLE \`users\` ADD COLUMN \`dingtalk_union_id\` ${unionColumnDefinition};`,
  );
}
