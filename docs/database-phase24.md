# 数据库配置基础能力（Phase 24）

本阶段提供 PostgreSQL / MySQL 配置解析、双客户端生成、独立迁移、连接就绪和隔离验证工具。普通业务仍使用 PostgreSQL；Server / Worker 收到 `DATABASE_PROVIDER=mysql` 时会在创建业务连接前明确退出，业务仓储在 Phase 25 接线。修改 env 不会自动迁移已有数据。

## 配置与兼容

| 变量                | 规则                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `DATABASE_PROVIDER` | `postgresql` / `mysql`；省略默认为 `postgresql`，显式空值非法                                      |
| `DATABASE_URL`      | 必填，PostgreSQL 使用 `postgresql://` / `postgres://`，MySQL 使用 `mysql://`，必须与 provider 匹配 |

连接串只注入服务端环境，不放入 `NEXT_PUBLIC_*`。配置错误只报告变量名或类别，连接与迁移错误不输出原始驱动诊断。现有 PostgreSQL 业务接口、文件链接与对象存储配置不变。

## 生成、迁移与就绪检查

以下命令在项目代码目录运行，要求 Node 24 / pnpm 11.19.0：

```sh
pnpm db:generate
pnpm db:schema:check
pnpm build:packages
pnpm db:migrate:deploy
```

生成命令无需数据库在线或真实凭据，同时产生两套客户端。schema 等价检查比较逻辑模型、物理差异白名单、默认值、主键/索引/外键、CHECK 及内部实例初始化，并锁定已审迁移 SQL 指纹。任何 SQL 变化都会失败；新增或修改迁移须先完成独立审查和真实数据库验证，再人工更新已审指纹，不能自动重生成指纹绕过检查。

`db:migrate:deploy` 使用现有 `.env.example` 的本地默认值，显式环境变量优先。部署环境应通过密钥系统提供连接串。例如，已安全注入 `MYSQL_DATABASE_URL` 时：

```sh
DATABASE_PROVIDER=mysql DATABASE_URL="$MYSQL_DATABASE_URL" pnpm db:migrate:deploy
DATABASE_PROVIDER=mysql DATABASE_URL="$MYSQL_DATABASE_URL" pnpm db:smoke
```

PostgreSQL 保留原 schema、生成目录和已应用迁移；MySQL 使用 `packages/db/prisma-mysql/` 下的独立迁移历史。迁移命令按 provider 自动选择，不重写历史、不执行 reset/schema push、不搬运用户数据。

`db:smoke` 默认只读，实际执行 SQL 往返、检查所需迁移与内部数据库实例标识，并释放连接。只建立惰性连接池不能代表数据库已就绪。

## MySQL 参数与 TLS

默认连接池为 5，连接/获取超时均为 5 秒，使用 UTC、`utf8mb4` 和 BigInt。支持 Prisma 的 `connection_limit`、`connect_timeout`、`pool_timeout`、`socket_timeout`、`max_idle_connection_lifetime`、`socket`，以及对应的原生驱动参数；秒值按驱动单位转换。

- `sslcert` 为 CA 文件，`sslidentity` 为 PFX 文件，`sslpassword` 为对应口令；相对路径以 `packages/db/prisma-mysql/` 为基准。
- 原生 `ssl=true`、JSON TLS 参数及 `ssl.ca` / `ssl.cert` / `ssl.key` / `ssl.pfx` 可用，原生文件相对路径以运行目录为基准；证书链和服务端主机身份均校验。
- 不支持、重复、矛盾、会泄露参数日志或改变数据精度的选项受控拒绝；不会静默忽略 TLS 参数。
- 本地非 TLS MySQL 的 `caching_sha2_password` 冷认证可显式配置 `allowPublicKeyRetrieval=true`；不会默认启用该选项。生产环境使用受信任 TLS 或已固定的服务器 RSA 公钥。

数据库内部元数据表 `database_identity` 只有一条记录，实例标识跨重复 deploy 保持稳定，供后续部署一致性预检使用；不进入普通用户 API。

## 隔离验证

`db:test:integration` 必须同时提供两套连接，缺任一库即失败。库名必须以 `html_share_phase24_` 开头，避免误写开发或生产数据：

```sh
PHASE24_POSTGRES_URL="$ISOLATED_POSTGRES_URL" \
PHASE24_MYSQL_URL="$ISOLATED_MYSQL_URL" \
pnpm db:test:integration
```

该验证覆盖真实读写、毫秒时间、Unicode/长路径、精确唯一、外键、密码 CHECK、活动任务互斥、迁移未完成与实例标识缺失。

`db:smoke --write-check` 额外要求 `DATABASE_TEST_ISOLATED=1` 与上述测试库名；临时 state 在同一事务中写入、读回并删除。

`db:upgrade:smoke` 仅接受空的专用 PostgreSQL 库 `html_share_phase24_upgrade*`，且要求 `DATABASE_TEST_ISOLATED=1`。工具先部署旧迁移、写入升级夹具，再升级和重复 deploy，对比用户、会话、Token、项目、首页、密码材料与旧迁移 checksum；成功后删除夹具，并清理临时配置目录。失败后应丢弃该专用测试库，不将其作为业务库使用。

修改 provider 后必须重启使用数据库的进程。指向空 MySQL 不会继承 PostgreSQL 数据；存量跨引擎迁移及同一镜像部署验收在后续阶段另行完成。
