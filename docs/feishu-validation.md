# 飞书登录验收记录

日期：2026-11-14。范围：GitHub 公共版 main 的飞书登录、钉钉联系方式刷新与账户关联。基线 `28faea8`。真实飞书应用发布与生产部署不在本次自动验收范围。

## 环境与证据

Node.js 24.22.3、pnpm 11.19.0；按仓库锁文件安装 Next.js 16.4.1 / React 19.2.8。PostgreSQL 18.6、MySQL 8.4、MinIO 均使用本次单独临时容器和测试数据库，没有连接已有业务库。自动化的手机号、邮箱、应用密钥均为合成值。

| 检查                      | 命令 / 证据                                                                         | 结果                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 全量测试                  | `pnpm test`                                                                         | 102 文件、867 项通过；204 项按环境条件跳过，相关本次双库测试另单独运行                       |
| 双库完整契约              | `node scripts/database-contract-check.mjs` + 两个 `PHASE25_*_URL`                   | 15 文件、116 项通过，零跳过                                                                  |
| 存量升级、重复 deploy/SQL | `vitest run scripts/feishu-migration.test.mjs` + 两个空的 `PHASE39_*_MIGRATION_URL` | 2 项通过，零跳过；User/Tenant、Demo、Revision、Upload、Token、配额快照保留                   |
| 新授权路由                | `vitest run apps/server/src/feishu-auth.test.ts`                                    | 17 项通过：匹配、双域、PKCE、取消、重放、浏览器/来源隔离、故障、长中文路径、限流 Cookie 清理 |
| 既有界面回归 | `node scripts/feishu-regression-smoke.mjs` | Chromium/WebKit 154 项通过，API 全部拦截，不写业务库 |
| 真实本地浏览器链路        | `node scripts/feishu-browser-smoke.mjs`                                             | 两库 × Chromium/WebKit × 1440/375px，99 断言通过                                             |
| 结构一致性                | `node scripts/database-schema-check.mjs`                                            | 22 models / 13 enums，一致性通过；迁移 fingerprint 经独立 SQL 审查及真实迁移验证后更新       |
| 类型与构建                | `pnpm typecheck`、`pnpm build`                                                      | packages、Server、Worker、Web 通过                                                           |
| 静态检查                  | `pnpm lint`、`git diff --check`                                                     | 通过                                                                                         |

浏览器链路使用生产 Feishu 客户端解析真实 HTTP 响应，通过注入 fetcher 将官方请求送入本地合成授权服务；合成服务核验 redirect_uri、应用凭据、单次 code 和 S256 verifier。真实私有存储发布文件，验证：飞书进入原钉钉账户、读取原 Demo 和 Token、管理到内容域一次性接力、密码页飞书入口、取消后回密码页、组织外拒绝、退出撤销、准确文件路径，以及 CSP 下按钮间距。

数据库额外覆盖双方登录先后顺序、仅手机号、仅邮箱、规范化、同来源占用、分裂命中、多账户歧义、跨组织不匹配、联系方式缺失/30天过期、并发首次登录、停用账户/组织、会话签发再次查状态、已有身份不改绑和旧资产不迁移。零跳过契约与独立升级测试共同补足默认全量中的本次集成测试。

复现浏览器验收需要 `PHASE25_POSTGRES_URL` / `PHASE25_MYSQL_URL` 指向 loopback 的 `html_share_phase25_*` 专用库，以及 `127.0.0.1:59008` 的独立 MinIO；脚本创建唯一测试桶、组织和资产并自动清理。授权模拟器监听 55120、API 55100、Web 55500，不修改已有应用端口。默认每次构建 Web；仅确认产物与配置完全相同时可设置 `FEISHU_REUSE_WEB_BUILD=true` 复用。

## 审查修复

- 长中文编码文件路径超过 2048 字符：完整路径放在服务端 AuthState，签名 Cookie 只含有界的随机 state、audience、PKCE verifier 与过期时间；通过成功和取消路径回归。
- 密码页 CSP 拦截行内按钮间距：改为 nonce 样式块规则，四种浏览器/宽度组合检查实际 computed margin。
- 限流回调在 cookie 插件序列化后清理失效：用 cookie 库序列化清理响应头；17 项 API 契约包含真实 Set-Cookie 断言。
- 同步确认钉钉侧账户冲突返回可操作提示，纯飞书账户不继承钉钉管理员或受限广场资格。

## 最终独立审查

fresh code-reviewer 对最终暂存版本执行两阶段审查，Stage 1 / Stage 2 均 PASS，无未解决 HIGH / MEDIUM。审查员另跑 7 文件111项定向测试、2项DDL测试、Server类型检查和暂存内容扫描；628文件无凭据发现。既有私有 `.local` 环境文件未加入暂存区。

## 外部待验

真实飞书 App ID/Secret、允许 tenant_key、权限审批、组织成员可用范围、管理域和内容域回调，以及飞书客户端真机登录需要部署方完成。手机号和邮箱可能由管理员导入，用户已选择信任本组织维护数据自动匹配；本次没有验证其实际持有权，也未声称已完成真实飞书联调。

部署先运行对应数据库增量迁移，再更新服务。详见 [配置与账户规则](feishu-login.md)。本次只推 GitHub main，不同步 GitLab，不执行生产部署。
