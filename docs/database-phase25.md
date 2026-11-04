# 双数据库业务仓储（Phase 25）

Server / Worker 现已通过同一仓储入口支持 PostgreSQL 和 MySQL。启动时读取 `DATABASE_PROVIDER` 与 `DATABASE_URL`，先完成真实连接、已应用迁移和数据库实例标识检查，再开放业务。省略 provider 继续使用 PostgreSQL；显式空值、协议不匹配、不可达或缺少迁移均退出，不静默回退。修改 env 后需重启进程。

## 运行与迁移

要求 Node.js 24、pnpm 11.19.0，以及已准备的 PostgreSQL 或 MySQL 8.4 数据库。连接参数、TLS 和独立迁移规则见 [Phase 24 配置指南](database-phase24.md)。以下连接变量应由运行环境安全注入，不写入命令历史或前端配置。

```sh
pnpm db:generate
pnpm build
DATABASE_PROVIDER=mysql DATABASE_URL="$MYSQL_DATABASE_URL" pnpm db:migrate:deploy
DATABASE_PROVIDER=mysql DATABASE_URL="$MYSQL_DATABASE_URL" pnpm db:smoke
```

运行 Server / Worker 时，给两个进程注入相同的 provider 和目标库，以及既有对象存储、认证、独立密码密钥等配置，再分别运行 `pnpm --filter @html-share/server start` 与 `pnpm --filter @html-share/worker start`。PostgreSQL 使用 `DATABASE_PROVIDER=postgresql` 和对应连接串，执行同样的迁移、检查和启动步骤。双客户端来自同一次构建，业务 API、Web、MCP 参数和 Demo URL 无数据库分支。

本页记录 Phase 25 的仓储交付。Phase 26 已增加双库 Compose、镜像与部署批准门禁；当前启动方式见 [部署指南](database-deployment.md)，完整矩阵验收状态见 [兼容证据](database-compatibility-evidence.md)。默认启动仍为 PostgreSQL，MySQL 通过独立拓扑启动。

## 事务与后台行为

- MySQL 使用 Read Committed，事务等待上限 5 秒、事务上限 10 秒；死锁/锁等待超时最多执行三次整事务尝试。密码生成、对象上传和其他外部副作用不放入重试回调。
- 准备、发布、密码管理、首页修改、删除按既有锁顺序串行，并在锁等待后重新核对状态、归属和版本。文件激活、配额结算、密码切换与任务结果在同一事务提交；失败保留旧内容和权限。
- 会话、Token、幂等键及文件路径使用摘要索引定位后核对完整原串。完整路径不截断，大小写不同的文件独立存取，摘要碰撞受控拒绝。
- 清理任务领取的 `attemptCount` 作为租约版本；完成和重试均锁后验证，旧 Worker 不能覆盖新领取者的状态。外部对象删除仍为幂等操作。
- 上传有效期为五分钟。崩溃任务到十分钟领取租约回收时已经过期，应释放预留并拒绝发布；清理任务和孤儿扫描按各自租约重新领取。测试不延长上传有效期来伪造可恢复发布。
- 未知驱动错误转换为受控数据库错误，不返回 SQL、原始连接串或驱动诊断。

## 真实双库契约验证

先创建并迁移两个本机隔离库，库名必须匹配 `html_share_phase25_*`。测试会写入并清理夹具，只能使用专用空测试库。通过环境注入两条测试连接串后执行：

```sh
pnpm build:packages
pnpm db:test:contract
```

必需变量为 `PHASE25_POSTGRES_URL` 和 `PHASE25_MYSQL_URL`。缺少任一库、非本机隔离库、任一用例 skipped/todo/失败都会使该入口失败。MySQL 测试账号另需只读访问 `performance_schema.data_lock_waits` 与 `performance_schema.data_locks`，用于确认不同连接实际发生锁等待；生产应用账号不因此需要这两项权限。

真实 HTTP、HTTPS 和浏览器回归可对专用 `html_share_phase25_http` 库运行，依次执行，避免测试端口冲突：

```sh
pnpm smoke:password-publication
pnpm smoke:password-access
pnpm smoke:password-management
```

注入 `PHASE25_DATABASE_PROVIDER`、`PHASE25_DATABASE_URL` 和 `PHASE10_MINIO_ENDPOINT`。此 HTTP 夹具严格限定 `127.0.0.1`：PostgreSQL 端口 `55439`、MySQL 端口 `53319`，数据库名均为 `html_share_phase25_http`；MinIO endpoint 必须是 `http://127.0.0.1:59000`。先为该独立 MinIO 配置测试账号 `password_test`、测试密钥 `local-password-test-only`，脚本固定使用这组合成凭据。它们只用于本机隔离测试，不复用业务对象存储账号。脚本创建随机 Bucket 并自清理夹具。

例如在已安全注入对应隔离连接串后，对两种 provider 分别执行上述三个命令，MySQL 设置 `PHASE25_DATABASE_PROVIDER=mysql`、`PHASE25_DATABASE_URL="$MYSQL_HTTP_TEST_URL"`；PostgreSQL 设置 `PHASE25_DATABASE_PROVIDER=postgresql`、`PHASE25_DATABASE_URL="$POSTGRES_HTTP_TEST_URL"`；两者均设置 `PHASE10_MINIO_ENDPOINT=http://127.0.0.1:59000`。MySQL 本机无 TLS 测试所用 `allowPublicKeyRetrieval=true` 仅为显式测试配置，部署应使用已验证 TLS，不照搬该参数。

首次运行前，在上述两个专用数据库实例中各创建空库 `html_share_phase25_http` 并授权测试账号，再按各自连接串执行迁移。不要将默认业务库用作该夹具：

```sh
DATABASE_PROVIDER=postgresql DATABASE_URL="$POSTGRES_HTTP_TEST_URL" pnpm db:migrate:deploy
DATABASE_PROVIDER=mysql DATABASE_URL="$MYSQL_HTTP_TEST_URL" pnpm db:migrate:deploy
```

## 切换边界

只改 env 不会复制、双写、清空或迁移原库，也不改写对象存储配置。空目标库不继承旧项目；已有 Demo 需要原数据库元数据与对象存储共同存在。跨引擎存量搬迁、备份恢复与目标部署验收必须独立完成。本阶段未宣称正式环境、真实钉钉、OSS/R2 或同镜像部署验收通过。

本地验证证据见 [Phase 25 验收记录](database-phase25-validation.md)。
