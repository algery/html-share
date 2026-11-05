# 本机 MySQL 真实接入测试

2026-11-05（Asia/Shanghai）。用户确认使用独立本机 MySQL。测试通过；未修改业务代码或切换现有 PostgreSQL 服务。

## 实际部署

使用仓库 `compose.mysql.yaml`，独立项目 `html-share-mysql-real-20261105`，通过临时覆盖文件复用 `html-share-{server,worker,web}:phase26` 已构建镜像；未重新构建或在运行时生成客户端。覆盖文件只设置镜像、合成测试配置与隔离端口。

- MySQL 8.4.13，真实 InnoDB 数据库 `html_share_phase26_image`，宿主端口53319。
- 真实 MinIO、Server、Worker、production Web；端口59000、55531、55532、55530。
- 实际执行部署初始化、MySQL migration、目标预检与 nonce 双角色启动批准。MySQL、MinIO、Server、Worker、Web 全部 healthy。
- 本项目中没有 PostgreSQL 服务。事务测试另起独立 PostgreSQL 对照容器，以复用不允许跳过后端的共享契约；不访问现有业务库。

## 本次证据

| 验证              | 执行与结果                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 完整 Compose 启动 | `docker compose ... -f compose.mysql.yaml ... up -d --no-build --wait` 成功；初始化/迁移退出0，五个运行服务健康                                      |
| 实际容器 API/MCP  | 调用现有 `exerciseDatabaseImage()`，连接运行中的容器，94项断言通过                                                                                   |
| 业务链路          | 模拟钉钉登录、CSRF、Token创建/吊销、逐文件直传、Worker发布、新建/覆盖、密码模式、Unicode文件详情、列表、首页设置、删除立即不可见、匿名访问零文件字节 |
| 真实 Web 浏览器   | Chromium、WebKit 直接访问本次 Web镜像和Server；没有拦截业务API。两引擎均完成登录、详情、首页保存后刷新持久化、列表复制链接和密码、Token创建及吊销    |
| 事务一致性        | `node scripts/database-contract-check.mjs` 显式提供两套隔离URL；12文件/72测试通过，零跳过，17.18秒                                                   |
| 故障与并发        | 上述真实契约包含发布后置失败全部回滚、失败保旧、MySQL死锁整事务重试、幂等、配额争抢、密码/首页/删除交错、多Worker领取与租约隔离、整页锁等待          |
| 重复迁移          | 对实际应用的MySQL库再次执行 `database-migrate.mjs`，输出 `Database migrations deployed (mysql)`                                                      |
| Worker正文边界    | 实际Worker `/health/metrics`：`getObjectCalls=0`、`bodyBytesRead=0`；retrying/running均0                                                             |

通过 SQL 直接查询应用使用的 MySQL，结果为：

```text
mysql_version        actual_database
8.4.13               html_share_phase26_image
ACTIVE projects      1
DELETED projects     1
COMPLETED uploads    3
file_objects         3
revoked_tokens       3
applied_migrations   1
```

这证明应用业务数据真实写入 MySQL。浏览器首页保存后刷新仍保留选项；Token吊销状态来自实际接口及数据库。复制测试只替代浏览器剪贴板写入接口以读取测试结果，数据获取、权限校验和数据库操作均走真实服务。

删除项目的一个清理作业尚未到达签名有效期加宽限时间，表现为 pending=1，属于正常未来调度；未声称它在短烟测内完成。事务契约验证了可达清理时间及旧Worker提交拒绝。

## 隔离与收尾

本次 Compose 容器、独立数据卷、网络、PostgreSQL对照容器及临时合成配置在结束时删除，已验证镜像保留。原 `html-share-server-1`、`worker-1`、`postgres-1`、`minio-1` 仍健康，未重启或切换。

原始本机日志保留在 `/tmp/html-share-mysql-real-20261105/`：`compose-up.log`、`actual-api.log`、`browser.log`、`contracts.log`、`repeat-migration.log`、`worker-metrics.log`、`cleanup.log`；含密钥的临时配置已删除。此测试使用钉钉模拟器和本机MinIO，不代表指定远程MySQL、真实钉钉或OSS/R2环境已验收。
