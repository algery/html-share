# PostgreSQL / MySQL 部署与恢复

本指南面向部署者。业务数据后端由启动时 env 选择；普通用户不需要选择数据库。支持基线为 PostgreSQL 18、MySQL 8.4 / InnoDB / utf8mb4；连接与 TLS 参数见 [配置基础指南](database-phase24.md)，仓储和事务规则见 [Phase 25 指南](database-phase25.md)。

## 首次启动与升级

1. 备份现有数据库、对象存储及独立的两个密码加密密钥。确认全部进程使用同一目标逻辑库，已有对象仍在原 Bucket。
2. 配置 `DATABASE_PROVIDER`、`DATABASE_URL`，保留原认证、对象存储与加密配置。生产 URL 使用私有网络和已验证 TLS，连接串不写入前端或日志。
3. 停止 Server/Worker 写入口，执行所选 provider 的 `migrate deploy`。不得使用 reset、schema push 或修改已应用 SQL；PostgreSQL 与 MySQL 各自使用独立迁移目录。
4. 执行只读预检，实际检查 SQL、已交付 migration checksum、数据库 UUID，以及引擎实例/逻辑库/schema 指纹。引擎身份读取 PostgreSQL `pg_control_system().system_identifier` 或 MySQL `@@server_uuid`，不随逻辑 dump 复制；同名库复制表内 UUID 到另一实例仍会拒绝。主机别名不同但指向同一实际目标可以通过。
5. 启动同一版本的 Server/Worker。双方都完成实际目标确认后才开放监听和 Worker 作业；健康检查通过后再开放入口。

本地使用 `pnpm stack:up` 或 `pnpm stack:up --env-file=.env.mysql.example`，启动器负责停止两角色、重建容器并重跑迁移；数据库与 MinIO 数据卷保留。MySQL 拓扑只包含 MySQL，不依赖 PostgreSQL。仅启动依赖可用 `pnpm infra:up --env-file=.env.mysql.example`，宿主迁移可用：

```sh
DATABASE_PROVIDER=mysql DATABASE_URL="$MYSQL_DATABASE_URL" pnpm db:migrate:deploy
DATABASE_PROVIDER=mysql DATABASE_URL="$MYSQL_DATABASE_URL" pnpm db:smoke
```

PostgreSQL 换为对应 provider 和 URL，省略 provider 仍默认 PostgreSQL。显式空值、未知 provider、协议错配、错凭据、不可达、缺迁移或 checksum 不符都失败，不尝试其他数据库。

## 生产 / 1Panel 生命周期

一次构建的 Server 与 Worker 镜像都包含两套生成客户端和迁移资源；运行时不安装依赖或重新生成客户端。生产使用 `compose.production.yaml`；离线镜像打包及 1Panel 使用 `scripts/build-1panel-images.sh` 和 `compose.1panel.yaml`。给所有角色注入相同数据库目标，部署环境不重写 URL。

升级时先暂停外部写流量，并按以下顺序执行。把 `COMPOSE_FILE`、`DEPLOY_ENV_FILE` 设置为已审阅的配置路径；不要将含秘密的 Compose 完整渲染结果发布到日志。

```sh
docker compose --env-file "$DEPLOY_ENV_FILE" -f "$COMPOSE_FILE" stop server worker
docker compose --env-file "$DEPLOY_ENV_FILE" -f "$COMPOSE_FILE" up -d --force-recreate --wait
```

停止失败应终止升级，不继续第二步。每次升级重新运行迁移和批准，不能只替换一个业务进程后沿用旧批准。

四套拓扑使用独立 `deployment-targets` 卷。短初始化服务仅负责目录归属；迁移进程以普通用户写 `0600` 批准文件，新 nonce 使旧 receipt 失效。Server/Worker 读取 `DATABASE_DEPLOYMENT_TARGET_FILE`，各自比对真实 SQL 目标并写本角色 receipt；双方匹配后才启动。缺失、错配或对方失败时有界超时退出，业务数据库不因此写入任何批准数据。该卷不是业务备份，恢复部署时重新生成批准，不能复制旧批准绕过检查。

独立部署或排查时，可以给只读预检提供三个角色各自的私有 env 文件：

```sh
pnpm db:deployment:preflight --server-env=/secure/server.env --worker-env=/secure/worker.env --migration-env=/secure/migration.env
```

只读预检不会初始化身份。独立部署同样应启用双方批准文件并在停写后更新；默认仅检查当前 env 的预检不证明其他实际进程配置一致。具体共享目录应仅允许这三个服务账号访问，不通过 Web 静态目录或日志公开。

## 存活、就绪与故障恢复

- `/health/live` 只表示进程存活；部署探针使用 `/health/ready`，实际检查所选数据库、迁移和批准。
- Server 探针需发送 `Host: APP_HOST`；提供的 Compose 已设置。公开响应只有 service/status 或受控不可用错误，不返回实例身份、库名、连接串、SQL。
- 运行时目标或批准改变，Server 拒绝业务请求，Worker 在下一轮作业前停止写入；恢复正确连接与批准后才继续。不要用 live 代替 ready 绕过错误。
- `pnpm health` 检查实际 SQL、Server/Worker readiness、Web 和本地 MinIO；数据库检查不再仅探测 TCP。外部 OSS/R2 的完整运行期存储健康与切换验收仍按 Phase 20 待办执行，该本地命令不能替代。`/health/metrics` 仅通过内部监控网络采集。

数据库迁移不自动回滚。应用回滚前先停写，确认目标镜像认识现有 schema、密码密文与业务约束；不能回到不兼容客户端。回滚仍需重新执行批准和双角色确认。

## 备份、恢复与跨引擎边界

PostgreSQL 使用一致性 `pg_dump` / `pg_restore`；MySQL 使用事务一致性备份，例如 `mysqldump --single-transaction --no-tablespaces`。保存 migration 历史和数据库身份，并同时备份对象存储与两个独立密码密钥。只恢复数据库无法保证正文或历史密码详情可用。

恢复演练使用隔离空库和隔离 Bucket，核对全部元数据、migration checksum、准确路径内容、密码访问、删除后 404 与后台清理。恢复副本可以保留数据库中的原 UUID，但目标库或引擎实例变化都会改变实际目标指纹；部署到副本时须让三个角色明确指向它并重新生成批准，不沿用源环境批准。

只改 env 不复制、双写、清空或搬迁原数据库。空 MySQL 不继承 PostgreSQL，反向亦然。跨引擎存量迁移必须另行设计字段/标识/路径/密码材料/任务一致性映射，停写迁移并完整验收后才开放流量；本次不提供该搬迁工具。数据库配置不改写 Bucket 或 Demo URL，旧 Demo 需要对应数据库元数据与原对象共同存在。

实际自动化记录及外部待验见 [兼容验收记录](database-compatibility-evidence.md)。
