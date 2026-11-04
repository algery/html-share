# Phase 24 本地验收记录

日期：2026-11-04。范围：数据库配置、双客户端生成、独立迁移与连接工具；不包含 Phase 25 的 MySQL 业务仓储或 Phase 26 的双数据库镜像部署。

## 环境

- Node 24.22.2、pnpm 11.19.0、Prisma / 两种 driver adapter 7.9.1。
- PostgreSQL 18.6、MySQL 8.4.13（InnoDB）；临时 MinIO 复用仓库固定版本。
- 所有数据库、Bucket、服务端口和浏览器数据均隔离。未迁移或重启用户原有服务、未写用户业务数据库；临时夹具与资源在收尾清理。

## 四步验证

| 验证        | 命令/方式                                                              | 实际结果                                                                  |
| ----------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Code Review | 独立 code-reviewer 从 Stage 1 开始审查，修复后使用 fresh reviewer 重审 | 最终 Stage 1 PASS、Stage 2 PASS，无 HIGH / MEDIUM；历史发现全部在下节记录 |
| 测试完整性  | 显式提供隔离 PostgreSQL、MySQL 和 MinIO 后执行 `pnpm test`             | 79 files / 602 tests passed，零跳过，19.57 秒                             |
| 编译验证    | `pnpm build`、`pnpm typecheck`、`pnpm lint`                            | 全部 exit 0；Web、Server、Worker 生产构建通过                             |
| 功能测试    | 双库迁移/就绪/约束/故障/升级、实际服务健康、MCP 发布与 Playwright      | 详细结果如下                                                              |

附加检查：`pnpm security:check` 为 `status: ok`；`pnpm db:schema:check` 为 16 models / 13 enums PASS；本次修改文件 Prettier 与 `git diff --check` 通过。

全仓 Prettier 检查另发现 4 个已存在、被 Git 忽略的 `.oil-ui/admin-refresh/` 过程文件不合格式：`capture.mjs`、`explore/direction.md`、`explore/review-package.md`、`logs/layout.json`。本阶段未修改这些范围外产物，不将全仓格式检查表述为通过。

## 真实功能证据

- PostgreSQL / MySQL 分别从空库执行对应迁移，再次 deploy 均成功；两个 provider 保持独立历史，PostgreSQL 既有迁移文件无改动。
- `pnpm db:test:integration`：8 项真实双库验证通过，覆盖连接/错误凭据/不可达、非泄密错误、迁移未完成、实例标识缺失、真实读写删除、Unicode/1024 单元长路径/大小写、BigInt、毫秒时间、唯一/FK/CHECK、活动任务互斥和 singleton。
- `pnpm db:upgrade:smoke`：先部署旧 PostgreSQL 迁移及夹具，再升级和重复 deploy，用户、会话、Token、项目、首页、密码材料、revision、文件与上传任务完整快照和旧迁移 checksum 均保持；输出 `PostgreSQL upgrade PASS: existing data and migration checksums preserved; repeat deploy passed`。
- 两种数据库分别执行 `db:smoke --write-check` 成功。临时 state 在同一事务中写入、读回和删除；默认 smoke 只读并执行实际 SQL，不以惰性 `$connect` 作为成功依据。
- MySQL 清空认证缓存后，显式 `allowPublicKeyRetrieval=true` 的本地非 TLS 连接读写成功。该选项不默认开启；TLS 配置独立支持。
- 主 Agent 在临时 MySQL 上安装一次性 CA 和 SAN 为 `127.0.0.1` 的证书，严格 TLS 下实际读写成功；换成同 CA、SAN 为 `127.0.0.2` 的证书后实际 SQL 查询被拒绝。已恢复正确证书并删除本地证书/私钥；没有把仅创建连接池当作 TLS 成功证据。
- 省略 provider 的真实 Server 与 Worker 在隔离端口启动，`/health/live` 分别返回 `{"service":"server","status":"ok"}` 和 `{"service":"worker","status":"ok"}`。
- 既有 `smoke:password-publication`：297 断言通过；Server 与 Worker 的发布正文 GetObject 次数和字节数均为 0，实际内容读取仍成功。
- Playwright：独立生产 Web 上 Chromium / WebKit 共 92 项通过，23.0 秒；覆盖列表、搜索分页、首页状态、详情、密码管理与按需复制分享。管理 API 全部拦截，不写真实项目。

## 审查修复与门禁边界

初轮审查发现静态 SQL 比较遗漏默认值、额外约束、CHECK 字符串/归属、破坏性语句、生成业务列和 PostgreSQL 元数据物理差异。已增加完整比较和反例，并以已审双库迁移 SQL 指纹作保底：任何未审 SQL 变化都会阻断，不能自动重生成指纹。新迁移只有完成独立审查与真实数据库验证后才能人工更新该指纹。最终 83 项 schema 门禁测试通过。

配置 Task 独立 Stage 1 / 2 已通过；最终 fresh reviewer 另独立复验配置/启动/TLS/schema 定向测试、typecheck、lint、安全扫描、双库只读 smoke、实际版本及错误凭据/不可达路径。TLS 证书切换、完整浏览器回归与旧库升级属于主 Agent 的实测证据，不冒充 reviewer 本人独立执行。

原始本机日志：`/tmp/html-share-phase24-tests.log`、`/tmp/html-share-phase24-build.log`、`/tmp/html-share-phase24-typecheck.log`、`/tmp/html-share-phase24-lint.log`、`/tmp/html-share-phase24-security.log`、`/tmp/html-share-phase24-schema.log`、`/tmp/html-share-phase24-browser.log`、`/tmp/html-share-phase24-publication.log`。TLS 与升级记录来自对应工具执行输出，未伪造为日志文件。

## 后续边界

本阶段可交付双数据库工具基础能力。MySQL 业务入口仍明确拒绝至 Phase 25；AC-060–066 只完成本阶段基础部分，不提前勾选完整 V1.9 验收。Phase 19–20 对象存储待办、Phase 23 原有用户验收和外部联调状态保持不变。
