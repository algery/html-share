# demo share

HTML 文件发布、受控分享和项目管理。文件正文存入私有对象存储；平台数据通过 env 选择 PostgreSQL 18 或 MySQL 8.4，Web、HTTP 和 MCP 使用同一套业务协议。

产品展示名称为 `demo share`。为兼容已有客户端与部署，`@html-share/*` 包名、MCP 连接名 `html-share`、Skill 安装目录和 ZIP 名、环境变量、Cookie、数据库及部署标识保持不变。

## 本地运行

要求 Node.js 24、pnpm 11.19.0 和 Docker Compose。两个示例都只含本地合成凭据。

```sh
pnpm install --frozen-lockfile
# 默认 PostgreSQL，兼容省略 DATABASE_PROVIDER 的旧配置
pnpm dev
# 或选择 MySQL；不要同时占用两套示例的应用端口
pnpm stack:up --env-file=.env.mysql.example
```

管理端 `http://app.localhost:3000`；API / 内容域 `http://app.localhost:3001`、`http://demo.localhost:3001`。默认使用钉钉模拟器。真实钉钉配置见 [runbook](docs/runbook.md)。

启动器按 provider 选择完整拓扑，只启动所选数据库和 MinIO。更新时先停止 Server/Worker，再重新执行迁移与批准门禁、启动所有服务；既有数据库卷保留。`pnpm infra:down` 不删除卷。需要保留本地私有配置时，用 `--env-file=.env.local` 指向已忽略的配置文件。

## 配置与部署

- `MAX_DEMOS_PER_USER` 控制每个账号的 Demo 数量上限，默认 `100`。例如在启动时选用的 `.env` 文件里设置 `MAX_DEMOS_PER_USER=150`，运行 `pnpm stack:up --env-file=.env` 应用配置；Compose 环境下需重新创建 API 容器才能读取新的环境变量。MySQL 和 PostgreSQL 使用相同规则，页面显示实际生效值。调低上限后，已有项目和已受理上传继续可用，达到新上限的账号需释放名额才能新建。

- `DATABASE_PROVIDER=postgresql|mysql`；省略使用 PostgreSQL，显式空值非法。
- `DATABASE_URL` 必须与 provider 协议匹配，仅注入服务端环境。
- 修改配置后重启全部数据库进程；空目标库不会继承旧项目。
- 同一 Server / Worker 镜像包含双客户端与独立迁移，不使用 provider 构建参数。

本地 `DATABASE_URL` 可以使用宿主端口。Compose 包装器仅把完整匹配示例账号、库名、端口的 loopback 目标转换为所选容器地址，外部连接保持原样；特殊网络可显式设置 `CONTAINER_DATABASE_URL`。生产与 1Panel 直接使用注入的目标，不进行本地重写。

详细迁移、进程一致性、健康检查、备份恢复与切换步骤见 [双数据库部署指南](docs/database-deployment.md)。生产示例位于 `deploy/production.env.example`、`deploy/1panel.env.example`。已有部署使用自己的密钥和备份，不能复制示例覆盖已有配置。

## 验证

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm security:check
pnpm db:schema:check
# 两个真实隔离数据库，缺库或关键用例跳过即失败
pnpm db:test:contract
# 迁移、门禁、浏览器、安全、容量及同镜像完整矩阵
pnpm db:test:compatibility
```

完整矩阵的隔离地址、变量、资源预算和真实结果见 [数据库兼容验收记录](docs/database-compatibility-evidence.md)。普通 `pnpm test` 可能跳过未配置的数据库集成测试，不能替代强制矩阵。

真实钉钉、OSS/R2、正式域名、1Panel/OpenResty 与真机验收按原待办独立追踪；本地模拟器和 MinIO 结果不代表这些外部环境已验收。
