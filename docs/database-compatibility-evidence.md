# Phase 26 数据库兼容验收

日期：2026-11-04。范围为 REQ-012 / AC-060–066 的本地双库交付。最终全量套件、强制矩阵和独立两阶段审查均通过，本地四步验证完成；用户于2026-11-05在MySQL验收环境测试后确认合并主分支。

## 环境和产物

宿主 Node.js 24.22.2、pnpm 11.19.0；PostgreSQL 18.6、MySQL 8.4.13、独立 MinIO。数据库均为本次专用容器与测试库，原本地业务服务、数据卷及已存数据不参与测试。Docker 目标为 `linux/amd64`，同一 Server / Worker 镜像分别在两种后端运行；本机为 ARM，镜像运行由 Docker 仿真。容量使用同一宿主 Node、同一套服务与真实双库，不能把宿主时延当作仿真镜像或生产环境的 SLA。

没有新增外部依赖或 schema/migration SQL 修改；两套已审迁移历史及指纹保留。

## 最终四步验证结果

| 检查             | 当场命令与输出                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 独立 Code Review | fresh reviewer Stage 1 / Stage 2 PASS，无未修复 HIGH / MEDIUM；文档与修复增量已复核                                                                     |
| 全量测试         | `pnpm test`（显式继承本次隔离 env）：112 files / 844 tests passed，零跳过；20:52:34，41.25秒                                                            |
| 强制双库契约     | `pnpm db:test:contract`：12 files / 72 tests passed，零跳过；20:53:16，14.15秒                                                                          |
| 完整交付矩阵     | `pnpm db:test:compatibility`：`database-compatibility-check-ok`；2461项 HTTP/浏览器/容量断言，另有迁移20、真实门禁24、两库同名异实例与镜像/恢复独立证据 |
| 编译与质量       | `pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm security:check`、`pnpm db:schema:check` 全通过；schema为16 models /13 enums                          |
| 格式与文件检查   | 改动文件 Prettier、`git diff --check`；代码文件均≤300行                                                                                                 |

两种数据库使用完全相同的以下镜像 ID。两库各通过100项镜像业务断言，且均在内部无外网网络完成迁移和双角色 SQL readiness；实际 Worker 指向另一库时双方不开放监听，两库共30个业务表计数不变：

```text
Server sha256:02c774d9d8bf708d8c1ad173c00b30251a57ca5dbddb44f5b442c3c044a7eb6d
Worker sha256:42dce52acb31c8e096f4e2d56344111b0296730aca08533916b9843f323c4d32
```

真实后端每库均通过：MCP/HTTP发布297断言、HTTPS访问127断言及密码浏览器14项、密码管理71断言、安全56断言。额外真实管理浏览器 PG255 / MySQL251断言，Chromium/WebKit×三宽度；旧拦截API回归每库98项、零skip/unexpected/flaky。

| 后端       | 元数据P95 ms | 最慢发布 ms | 单Demo20读P95 ms | 十项目100读P95 ms | 管理100并发P95 ms |
| ---------- | -----------: | ----------: | ---------------: | ----------------: | ----------------: |
| postgresql |       234.71 |      315.72 |            73.25 |            226.27 |            117.10 |
| mysql      |       364.64 |      450.51 |            52.24 |            245.87 |            209.82 |

容量两库各执行319次真实Server readiness、1轮Worker readiness；峰值连接均5，死锁0、事务失败/重试0、发布正文下载0、容量任务与清理积压0。PG锁等待峰值1、MySQL峰值3；MySQL累计锁等待18。PG缺少数据库级累计锁等待计数，报告保留 `null`，未填假0。镜像删除后的未来清理作业仍按签名到期加宽限排期（PG待4、MySQL待1），不虚假要求短烟测内清空未来任务；重试和运行中作业均0。

两库实际dump/restore分别62474 /46579字节，16模型及迁移checksum一致；恢复库中非空密码项目成功解密、发grant、读50字节Unicode正文、删除即拒绝、独立Bucket后台清理（PG8 /MySQL5项作业）。源数据库与源正文均未变。另一真实引擎实例的同名库即使复制UUID和schema，也被只读门禁拒绝且业务表不变。

原始日志：`/tmp/html-share-phase26-matrix-final.log`、`/tmp/html-share-phase26-summary.json`、`/tmp/html-share-phase26-tests-final.log`、`/tmp/html-share-phase26-contract-final.log`、`/tmp/html-share-phase26-final-{build,typecheck,lint,security-check,db-schema-check}.log`；固定镜像构建记录为 `html-share-phase26-{server,worker}-approved-build.log`。这些是本机临时证据，复验时重新采集。

## 可重复入口与隔离前提

在代码目录运行，先生成双客户端并构建：

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm db:test:contract
pnpm db:test:compatibility
```

`test` 只有在显式配置集成变量时才包含全部真实用例。强制契约与完整矩阵缺任一后端、关键用例跳过、浏览器 flaky/unexpected 或证据缺失均失败；不提供跳过后端、浏览器或容量的参数。完整矩阵写入专用测试库，绝不能指向已有业务库。

完整矩阵需要准备以下本机资源。连接串只注入进程环境，协议必须与 provider 匹配；MySQL 本机合成测试允许显式 `allowPublicKeyRetrieval=true`，生产使用已验证 TLS。

| 用途                             | PostgreSQL                                                 | MySQL                      |
| -------------------------------- | ---------------------------------------------------------- | -------------------------- |
| 业务、契约与门禁实例             | `127.0.0.1:55439`                                          | `127.0.0.1:53319`          |
| 同名异实例克隆验证               | 独立实例 `127.0.0.1:55440`                                 | 独立实例 `127.0.0.1:53320` |
| 契约库（先迁移）                 | `html_share_phase25_pg`                                    | `html_share_phase25_mysql` |
| HTTP 库（先迁移）                | `html_share_phase25_http`                                  | `html_share_phase25_http`  |
| 门禁库（先迁移）                 | `html_share_phase26_gate`、`html_share_phase26_gate_other` | 同左                       |
| 旧 schema 负例（保留空库）       | `html_share_phase26_gate_old`                              | 同左                       |
| 克隆实例（先迁移）               | 独立实例中的 `html_share_phase26_gate`                     | 同左                       |
| 首次迁移验收（每轮新空库）       | `html_share_phase26_empty`                                 | 同左                       |
| 旧 PostgreSQL 升级（每轮新空库） | `html_share_phase24_upgrade26`                             | 不适用                     |
| 镜像业务源（由镜像迁移）         | `html_share_phase26_image`                                 | 同左                       |
| 恢复目标（每轮新空库）           | `html_share_phase26_restore`                               | 同左                       |

另提供 MinIO `http://127.0.0.1:59000`，合成测试账号 `password_test`、合成测试密钥 `local-password-test-only`。HTTP 脚本的数据库账号可由连接串指定；镜像与恢复夹具固定使用本次专用 `phase25` / `phase25-local-test` 合成账号。MySQL 测试遥测额外需要 `PROCESS` 及 `performance_schema.data_locks/data_lock_waits` 的只读权限，生产应用账号不需要因此扩大权限。

按上表向目标账号授权并对“先迁移”库执行 `pnpm db:migrate:deploy`。空库验收脚本会拒绝非空目标，不自动 reset；重复完整演练需由操作者明确重建自己的专用空库。历史回归另需隔离 PostgreSQL `55432/html_share_password`、`html_share_phase25_quota`、`html_share_phase24_pg` 和 MySQL `html_share_phase24_mysql`，按 Phase 24–25 指南迁移。

必需的矩阵环境变量：

```dotenv
PHASE25_POSTGRES_URL=<已迁移契约库 URL>
PHASE25_MYSQL_URL=<已迁移契约库 URL>
PHASE26_POSTGRES_HTTP_URL=<上表固定端口的 HTTP 库 URL>
PHASE26_MYSQL_HTTP_URL=<上表固定端口的 HTTP 库 URL>
PHASE10_MINIO_ENDPOINT=http://127.0.0.1:59000
PHASE26_POSTGRES_MIGRATION_URL=<新空库 URL>
PHASE26_MYSQL_MIGRATION_URL=<新空库 URL>
PHASE26_POSTGRES_UPGRADE_URL=<新空升级库 URL>
PHASE26_GATE_POSTGRES_URL=<门禁库 URL>
PHASE26_GATE_MYSQL_URL=<门禁库 URL>
PHASE26_CLONE_POSTGRES_URL=<独立克隆实例同名门禁库 URL>
PHASE26_CLONE_MYSQL_URL=<独立克隆实例同名门禁库 URL>
PHASE26_IMAGE_TEST_ISOLATED=1
PHASE26_SERVER_IMAGE=html-share-server:phase26
PHASE26_WORKER_IMAGE=html-share-worker:phase26
PHASE26_POSTGRES_CONTAINER_URL=<下述专用网络的 PostgreSQL 镜像库 URL>
PHASE26_MYSQL_CONTAINER_URL=<下述专用网络的 MySQL 镜像库 URL>
```

镜像夹具使用专用网络 `html-share-phase26-test`，数据库别名 `phase26-pg:5432`、`phase26-mysql:3306`、MinIO `phase26-minio:9000`；仅接受 `html_share_phase26_image` 镜像库。源容器命名为 `html-share-phase26-pg`、`html-share-phase26-mysql`、`html-share-phase26-minio`，备份命令只接受这些专用容器。另建 `docker network create --internal html-share-phase26-offline`，把这三个容器以同样别名接入；镜像先在该无外网网络执行迁移和双角色 readiness，使用容器内 HTTP 探针，不依赖宿主发布端口。

正常镜像业务容器发布端口 `55531/55532`，HTTP/HTTPS/production Web 夹具使用 `55100/55443/55500`。先确认端口空闲；矩阵串行测试，不覆盖日常 `3000/3001/3002/5432/9000` 服务。备份源和恢复 Bucket 独立，恢复业务清理不删除源对象。

构建只需一次，没有数据库 provider 构建参数：

```sh
docker build --target server -t html-share-server:phase26 .
docker build --target worker -t html-share-worker:phase26 .
```

## 验收映射与实际检查

| 验收项                  | 强制证据                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| AC-060 默认 PostgreSQL  | 省略 provider 首次迁移、旧库升级快照及历史 checksum 不变、完整业务和容量                                         |
| AC-061 MySQL 同产物     | 固定 Server/Worker image ID、双库真实启动及 HTTP/MCP 发布/覆盖/详情/首页/删除/Token、真实浏览器                  |
| AC-062 配置与目标一致   | 解析负例、真实 SQL/checksum/UUID/引擎身份/逻辑目标、不同地址同库正例、实际错库 Worker 双方无监听且两库业务表不变 |
| AC-063 并发与原子性     | 真实锁等待/死锁/回滚/配额/密码/首页/删除、租约 fencing、十并发领取与超过一页候选                                 |
| AC-064 字符、精度、边界 | 共享真实双库路径/BigInt/NULL/UTC/容量契约、Unicode 浏览器与恢复正文                                              |
| AC-065 独立迁移         | 双库实际空库首次/重复部署、PostgreSQL 升级及 checksum、真实 dump/restore                                         |
| AC-066 无自动搬迁       | 两方向空目标/源库完整快照不变、数据库 × OSS/R2 四组合静态配置、恢复源数据/对象不变及运维说明                     |

容量须包含实际生产路径的 SQL、迁移 checksum、实例身份与 nonce/双 receipt 校验，报告记录 Server 检查次数及 Worker 轮次。两库均为单 Node / 共享 pool5、十并行 finalizer、两秒生产轮询节拍；十项目/百次读取、单 Demo 二十并发和百并发管理 API 使用相同阈值。元数据 P95≤5 秒、全部发布≤60 秒、TTFB/API P95≤500ms；从测量开始到对应任务实际完成轮次的上界计时，不用顺畅纯函数或快速重试代替。

浏览器覆盖 Chromium/WebKit × 1440/1065/375，真实登录、Token、列表、详情、首页、刷新与最新分享文本；既有拦截 API 回归独立执行。密码浏览器生成安全聚合 JSON，跳过或 flaky 不能只凭子进程 exit0 混过门禁。

恢复先比较 16 模型及迁移历史，再要求非空 ACTIVE 密码项目；在独立 Bucket 真实解密、发 grant、读取准确 Unicode 正文、删除后立即拒绝、按实际上传到期加宽限执行清理，并验证源数据库及源正文未变。该过程的正文下载属于备份恢复，不计入发布 Worker 的零正文元数据指标。

## 限制与交接

PostgreSQL/MySQL × OSS/R2 四组合只做静态配置验证；Phase 19 适配器已实现，Phase 20 真实 OSS/R2 Bucket 联调仍待独立执行。真实钉钉、正式域名、1Panel/OpenResty、真机和原有外部镜像扫描待办保留，本地 MinIO/模拟器不替代它们。

MariaDB 驱动故障测试覆盖完成连接释放后的实际断网、503 与恢复；在驱动异步 reset 恰遇断网的排障中曾观察到上游未处理异常，没有通过全局吞错隐藏。提供的容器保留失败重启策略；数据库故障时仍需监控 readiness 与容器退出，不能把存活探针视为业务可用。

一次完整矩阵在真实浏览器子进程失败，原捕获层未保留错误类别，原因未能定位。随后两个同后端独立完整浏览器回归通过；捕获层已增加仅输出 React 数字码、错误类别及限定源码位置的安全诊断，保留原浏览器断言。最终矩阵结果单独记录，不将该未定位失败描述为已修复的产品缺陷；后续再次发生仍会阻断矩阵。

全量格式检查包含四个既有且被忽略的 `.oil-ui/admin-refresh/` 过程产物，本阶段不改动；新增/修改文件单独通过格式检查。全部新增/修改代码文件保持≤300行。

最终原始证据记录在本机 `/tmp/html-share-phase26-*` 日志；临时合成 env、测试容器、测试卷及网络在收尾删除，构建产物保留。跨引擎存量搬迁不属于本次交付，下一步按 [部署指南](database-deployment.md) 与已有外部验收清单推进。
