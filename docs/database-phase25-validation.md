# Phase 25 本地验收记录

日期：2026-11-04。范围：V1.9 双数据库业务仓储与事务一致性；本地四步验证通过，待用户验收。Phase 26 镜像、部署门禁、完整安全/容量组合矩阵仍待开发，AC-060–066 不在此整体勾选完成。

## 环境与隔离

Node.js 24.22.2、pnpm 11.19.0；PostgreSQL 18.6 与 MySQL 8.4.13，均为本次创建的独立容器、独立测试账号和 `html_share_phase25_*` 测试库。兼容回归另使用独立 `html_share_phase24_*` 与历史脚本专用 `html_share_password` 库；MinIO 使用本次独立容器。

未切换或重启已有本地业务服务，未写入已有业务库。测试容器、测试卷与临时启动进程在收尾时删除；缓存镜像和已有业务卷保留。本阶段没有修改 schema、既有 migration 或迁移 SQL 指纹，没有新增依赖。

## 四步验证

| 步骤           | 命令或证据                                                                                        | 结果                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 独立代码审查   | fresh `code-reviewer` 全量检查新增和改动文件；逐项对照 Phase 25 与 REQ-012                        | Stage 1 PASS / Stage 2 PASS，无 HIGH、MEDIUM、LOW 待修问题                              |
| 测试完整性     | `pnpm test`，显式提供两库、历史集成与隔离 MinIO 环境                                              | 97 文件、723 项通过，零跳过                                                             |
| 强制双库契约   | `pnpm db:test:contract`                                                                           | 11 文件、68 项通过，零跳过；含真实 MySQL 死锁恢复                                       |
| 编译验证       | `pnpm build`、`pnpm typecheck`                                                                    | Server / Worker / Web 及全部包通过，tsc 零错误                                          |
| 质量检查       | `pnpm lint`、`pnpm security:check`、`pnpm db:schema:check`、改动文件 Prettier、`git diff --check` | 通过；schema 等价检查为 16 models / 13 enums                                            |
| 实际入口启动   | 同一份编译后的 Server / Worker，仅切 provider 和专用目标库                                        | 两库各两个进程 `/health/live` 均 200，随后停止临时进程                                  |
| HTTP/MCP 发布  | 两库各运行 `pnpm smoke:password-publication`                                                      | 各 297 断言通过；Server/Worker GetObject=0、正文下载=0；内容网关各 16 次读取、400 字节  |
| HTTPS 访问     | 两库各运行 `pnpm smoke:password-access`                                                           | 各 126 断言通过，真实 HTTPS；此入口未请求浏览器                                         |
| 真实浏览器管理 | 两库各运行 `pnpm smoke:password-management`                                                       | 各 71 断言通过；Chromium / WebKit，真实 Server、production Web、Worker finalizer、MinIO |

仓库全量格式检查仍包含四个既有且被忽略的 `.oil-ui/admin-refresh/` 过程产物；本阶段不改动这些文件。所有本阶段新增/修改代码文件均不超过 300 行，改动文件格式检查通过。

## 关键故障与并发证据

- 两库共享授权、state 一次性消费、Token、发布/覆盖、幂等、配额、密码、首页、删除/审计及后台契约。独立事务连接通过 PostgreSQL/MySQL 锁等待视图确认真实重叠，再释放锁并断言最终结果。
- 后置约束失败发生在文件写入之后，验证 revision、文件、密码、grant 和配额结算全部回滚，原内容仍有效，错误无驱动信息泄露。
- MySQL 两个事务反向加行锁制造真实死锁，受害事务先前写入回滚，整事务重试后两个计数均准确为 2，未重复累加。
- 清理任务、孤儿扫描租约回收后旧领取者不能提交；上传任务按真实五分钟生命周期在十分钟崩溃回收时过期、释放预留并拒绝发布。
- 中文、emoji、`A.html`/`a.html`、同前缀长路径、1024 单元边界、BigInt、NULL、UTC、到期和幂等窗口均有双库用例。摘要碰撞使用受控单测注入，未声称构造真实 SHA-256 碰撞。
- 修复既有 PostgreSQL 失败/过期新建重试绕过配额的问题：旧实现复现 9 项失败，修复后新增 15 项及原有 3 项真实 PG 回归全部通过。成功幂等请求不重复预留。
- 会话及 MCP Token 使用摘要索引定位，再复核完整原串及有效状态；独立审查发现的索引使用缺口已经修复并纳入最终审查。
- HTTPS 回归按 Phase 18 的跨域一次性接力验证准确原路径；未缩减旧权限或零文件字节断言。

## 本机原始证据

以下为本次运行的临时日志，不作为仓库长期附件或 CI 产物；可按配置指南重新执行：

- `/tmp/html-share-phase25-final-test.log`、`/tmp/html-share-phase25-final-db-test-contract.log`
- `/tmp/html-share-phase25-final-{build,typecheck,lint,security-check,db-schema-check}.log`
- `/tmp/html-share-phase25-runtime.log`
- `/tmp/html-share-phase25-{mysql,postgres}-{http,access,management}.log`
- `/tmp/phase25-review-{unit,typecheck,lint}.log`

原始结果摘录：

```text
Test Files  97 passed (97)
     Tests  723 passed (723)

Test Files  11 passed (11)
     Tests  68 passed (68)

build PASS
typecheck PASS
lint PASS
security:check PASS
db:schema:check PASS
```

后续执行 Phase 26，验证固定镜像 digest、完整部署/性能/恢复矩阵与进程目标一致性。既有真实钉钉、OSS/R2、正式域名、1Panel/OpenResty 与真机待验记录继续保留，不用本地模拟器结果替代。
