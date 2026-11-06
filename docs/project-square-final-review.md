# 项目广场最终独立复审

日期：2026-11-07。审查者：fresh code-reviewer。基线：`feat/project-square`，审查时 HEAD `59aa279`，包含本轮已暂存业务增量。依据：父目录 `Product-Spec.md:837` 的 REQ-013/014、AC-067–082，`Design-Brief.md:49` 和 `DEV-PLAN.md:1528`–Phase 30。按 `.agents/skills/code-review/SKILL.md` 先完成 Stage 1，再执行 Stage 2；未修改业务代码、未提交、未派生子任务。

**Stage 1：本地实现 PASS。Stage 2：PASS。未发现需要阻塞本轮交付的 HIGH 或 MEDIUM 问题。** 结论覆盖代码与本地可重复验证，不包含真实企业钉钉权限、人员变动或真机验收。凭据门禁四个文件按派发范围排除，不能由本报告推导其审查结论，也不能推导全 workspace 凭据扫描通过。

## Stage 1：逐项 Spec Compliance

下表的“通过”指本地实现与验证匹配。带“外部待验”的条目没有将合成 provider 冒充真实钉钉。

| AC     | 结论                            | 代码证据与实际验证                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------ | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-067 | 通过                            | 无设置行返回 `enabled=false/audienceType=null/version=0`：`packages/core/src/square/contracts.ts:107`、`packages/db/src/square-mapping.ts:93`；两库模型默认关闭：`packages/db/prisma/square.prisma:5`、`packages/db/prisma-mysql/square.prisma:5`。UI 初次未选范围不提交，发布经确认弹窗：`apps/web/src/components/project-square-manager.tsx:108`、`:165`、`:217`。双库用例断言项目整行未被共享写入改变：`scripts/database-contract-square.test.mjs:16`；真实旧 schema 升级检查默认关闭：`scripts/project-square-upgrade-smoke.mjs:214`、`:233`。 |
| AC-068 | 通过                            | tenant/ACTIVE/current revision/shared 以及 owner、organization、verified member 并集组成同一 where：`packages/db/src/square-mapping.ts:26`。两库 count 与 findMany 均使用这个 where，再加搜索/分页：`packages/db/src/square-repository.ts:33`、`packages/db/src/mysql/square-repository.ts:33`。双库用例覆盖大小写不同企业 ID、子部门、异租户及隐藏搜索计数：`scripts/database-contract-square.test.mjs:42`、`:238`。                                                                                                                              |
| AC-069 | 通过                            | 关闭在目录查询之前返回，保留上次范围：`packages/core/src/square/service.ts:157`、`packages/db/src/square-writer.ts:40`、`:53`；每次广场请求重查数据库，不缓存项目授权。UI 已保存状态和草稿分离，重新发布再次确认：`apps/web/src/components/project-square-manager.tsx:16`、`:123`、`:165`。真实脚本检查缩小后下一次请求以及撤回后准确链接：`scripts/project-square-smoke.mjs:209`、`:248`。                                                                                                                                                        |
| AC-070 | 通过                            | PG/MySQL 在项目行锁后重验 owner/tenant/revision/version/upload 状态，设置、目标、成功审计位于同一事务：`packages/db/src/square-writer.ts:10`、`packages/db/src/mysql/square-writer.ts:11`。双连接并发仅一个成功，审计写失败回滚，上传互斥：`scripts/database-contract-square.test.mjs:113`。当前 revision 与删除门禁：`packages/db/src/square-mapping.ts:35`、`:62`；覆盖与删除用例：`scripts/database-contract-square.test.mjs:147`。                                                                                                             |
| AC-071 | 通过                            | 独立查询投影与响应白名单：`packages/db/src/square-mapping.ts:8`、`packages/core/src/square/service.ts:44`、`:129`；不含密码、存储键、目标名单、历史 revision。实际成员持自己的 CSRF 直接尝试本人详情、共享、首页、密码、删除、MCP 覆盖：`scripts/project-square-smoke.mjs:143`、`scripts/project-square-mutation-checks.mjs:9`。只读页面不存在管理控件：`apps/web/src/components/square-detail.tsx:75`；浏览器断言零 owner API 请求：`scripts/project-square-browser-support.mjs:23`、`scripts/project-square-browser.mjs:269`。                   |
| AC-072 | 通过                            | app Host + app session，失败 401/404，响应 `private, no-store`：`apps/server/src/modules/square/request.ts:19`；无资格详情统一 404：`packages/core/src/square/service.ts:123`。浏览器每次加载清空旧内容且请求 no-store：`apps/web/src/components/square-browser.tsx:17`、`apps/web/src/components/square-detail.tsx:16`。独立复跑 HTTP 测试覆盖无会话、Bearer、demo cookie、异 Host、跨 Origin：`apps/server/src/square.test.ts:28`；真实密码凭证拒绝广场：`scripts/project-square-smoke.mjs:189`。                                                |
| AC-073 | 通过                            | 现有内容授权只依赖组织会话/项目密码和准确路径，无广场范围条件：`apps/server/src/modules/content/authorize-content.ts:24`、`:102`。真实链路先限范围再撤回，两次验证范围外组织成员和有效密码均可读取：`scripts/project-square-smoke.mjs:163`、`:199`、`:253`。共享区明示边界：`apps/web/src/lib/square-types.ts:73`。                                                                                                                                                                                                                                |
| AC-074 | 通过                            | 路径按每段 encodeURIComponent：`packages/core/src/square/service.ts:134`；复用首页判定，缺失首页只提示从内容选择文件：`apps/web/src/components/square-detail.tsx:95`；当前文件筛选和准确新窗口链接：`:75`、`:150`。实际浏览器打开嵌套中文 HTML 并验证双域接力：`scripts/project-square-browser-support.mjs:155`。已独立打开 375px/200% 实际截图，长路径完整换行，无管理动作；200% 是 CSS zoom 覆盖，非真实工具栏缩放或真机。                                                                                                                       |
| AC-075 | 通过；真实钉钉外部待验          | 分页树/搜索、路径、部门人员混选、稳定 ID 去重、移除：`apps/web/src/components/square-directory-browser.tsx:51`、`:105`、`:128`，`square-audience-picker.tsx:17`、`:79`。实际浏览器脚本先验证 005 账号数为 0 再选择和首次登录：`scripts/project-square-browser.mjs:146`、`:152`。浏览器交互回归包含同名、分页、去重：`tests/browser/project-square.spec.ts:49`、`:231`；真实钉钉内置客户端仍未验。                                                                                                                                                  |
| AC-076 | 通过；真实人员变更外部待验      | 成员每次刷新由 unionId 映射企业 userId，再查当前部门与祖先链：`packages/dingtalk/src/directory-client.ts:49`。过滤使用当前 member 的 userId/departmentIds，不使用保存时人员展开快照：`packages/db/src/square-mapping.ts:26`。双库测试切换企业 ID、子部门命中：`scripts/database-contract-square.test.mjs:42`；缓存测试刷新返回变化后的成员：`packages/core/src/organization/directory-service.test.ts:42`。                                                                                                                                        |
| AC-077 | 通过                            | payload/版本/1–100 个唯一目标/organization 禁止附目标；所有指定 ID 必须存在于本租户授权快照：`packages/core/src/square/service.ts:144`、`:186`、`:215`、`:228`。写路由验证管理会话、同源和 CSRF：`apps/server/src/modules/square/routes.ts:45`、`apps/server/src/modules/projects/write-request.ts:11`。独立复跑 malformed/无 CSRF/拒绝目录输入测试：`apps/server/src/square.test.ts:48`、`:92`；双库无效目标保持旧状态：`scripts/project-square-smoke.mjs:200`。                                                                                  |
| AC-078 | 通过；真实应用权限外部待验      | 上游 HTTP/业务错误/超时变为受控错误；分页不完整或循环拒绝刷新：`packages/dingtalk/src/directory-http.ts:25`、`:88`、`directory-snapshot.ts:122`。过期缓存不会回退旧授权：`packages/core/src/organization/directory-service.ts:49`；目录失败时仅 owner/organization 分支可见：`packages/core/src/square/service.ts:27`、`packages/db/src/square-mapping.ts:40`。关闭无目录 IO 已独立测试：`apps/server/src/square.test.ts:73`；UI 保留草稿并提供重试：`tests/browser/project-square.spec.ts:99`。                                                   |
| AC-079 | 通过；真实调岗/离职外部待验     | TTL 上限 300000ms，从请求开始计算，tenant/corp/unionId 隔离；过期删除、刷新失败不复用；并发刷新合并：`packages/core/src/organization/directory-service.ts:14`、`:28`、`:44`。独立复跑恰到边界、慢请求耗尽 TTL、失败重试和缓存篡改防护：`directory-service.test.ts:42`、`:80`、`:100`。范围缩小不等待缓存：`scripts/project-square-smoke.mjs:220`。                                                                                                                                                                                                 |
| AC-080 | 通过；真实 unionId 联调外部待验 | users/me 的 openId 原样保留为旧登录键，仅可信响应补充 unionId：`packages/dingtalk/src/client.ts:230`；PG 仍按 tenant+旧 ID upsert：`packages/db/src/auth-repository.ts:27`；MySQL 旧摘要索引与原文核对不变：`packages/db/src/mysql/auth-repository.ts:29`。双库检查同一内部 userId、原项目和 Token 归属：`scripts/database-contract-square.test.mjs:191`；旧 schema 升级对比原始数据：`scripts/project-square-upgrade-smoke.mjs:214`、`:224`、`:266`。                                                                                             |
| AC-081 | 通过                            | 仅新增两库迁移、共享模型和可空身份列；设置存储与发布对象独立：`packages/db/prisma/migrations/20261107000000_project_square/migration.sql:1`、`packages/db/prisma-mysql/migrations/20261107000000_project_square/migration.sql:1`。现有日志证明双库契约全量运行；升级脚本先移除新迁移/schema 字段，证实无 unionId 后再升级且重复 deploy 不变：`scripts/project-square-upgrade-smoke.mjs:78`、`:214`、`:278`。真实发布脚本检查 Worker 零正文读取：`scripts/project-square-smoke.mjs:281`。                                                           |
| AC-082 | 通过；真机状态外部待验          | 骨架/空/错误/过期/不可见状态：`apps/web/src/components/square-load-state.tsx:12`、`square-browser.tsx:101`、`square-directory-browser.tsx:164`。分页目录只返回必要投影：`packages/dingtalk/src/directory-snapshot.ts:109`、`apps/server/src/modules/directory/routes.ts:27`。审计只有 actor/project/action/result/version/IP/trace/time，无密码和完整目录：`packages/db/src/square-writer.ts:71`、`:87`。已核对日志固定分类不记录 query/body：`apps/server/src/plugins/security.ts:68`、`:123`。                                                   |

完整实现：上表全部本地能力。部分实现/未实现：本地范围未发现。外部待验：真实企业通讯录权限、部分授权、真实 unionId、调岗/离职响应及钉钉真机，不能将 AC-075/076/078/079/080 的真实环境部分标成已完成。

引导真实性：搜索框对应已实现的部门/姓名或项目/文件查询；目录分页与重试有实际处理；缺首页提示通往只读内容选择，不引导访客设置首页。证据：`square-directory-browser.tsx:27`、`:105`、`:196`，`square-project-list.tsx:80`，`square-detail.tsx:117`。

Spec 漂移：未发现新增成员邀请、独立项目成员角色、MCP 广场管理工具、下载/导出或越权管理入口。新增两个页面与六个业务路由、新增三张表和身份列均对应计划契约；接线见 `apps/server/src/app.ts:190`、`apps/server/src/main.ts:83`，模型见 `packages/db/prisma/square.prisma:1`，页面见 `apps/web/src/app/square/page.tsx:1` 与 `[projectId]/page.tsx:1`。

## Stage 2：Code Quality、安全及视觉

- 代码质量通过：扫描本轮 80 个业务相关 TS/TSX/MJS 文件，均不超过 300 行；未发现 `any` 类型。文本命中的 `expect.any(String)`、注释及测试标题不是 any 类型。复杂实现按 HTTP、快照、最小值校验、缓存、仓储、UI 状态拆分；PG/MySQL writer 的近似结构服务于两种独立事务接口，未混入页面。独立 `eslint . --max-warnings 0` 退出 0，`git diff --cached --check` 退出 0。
- 安全扫描通过：未发现新增 eval、HTML 字符串执行、unsafe SQL 或公开环境变量凭据；事务行锁使用 Prisma 参数化模板：`packages/db/src/square-writer.ts:11`、`packages/db/src/mysql/square-writer.ts:12`。上游 token 只放请求，错误脱敏且不转发原始个人资料：`packages/dingtalk/src/directory-http.ts:25`、`:56`、`:112`。本结论不扩展到 ignored 私有配置；其已知扫描限制保留在 `docs/project-square-validation.md:33`。
- 测试真实性通过：双库用例实际双连接竞争，强制审计失败后比较持久化状态，不只 mock 成功结果：`scripts/database-contract-square.test.mjs:113`。真实越权调用使用范围内成员自己的 CSRF 与 MCP Token：`scripts/project-square-smoke.mjs:143`、`project-square-mutation-checks.mjs:28`。升级前确实执行旧迁移并验证不存在新列：`project-square-upgrade-smoke.mjs:209`。UI mock 测试只用于交互，实际 API/MinIO/Worker 脚本与四组真实浏览器补上集成层；真实钉钉未覆盖的边界明确保留。
- schema 门禁通过：原 SQL 指纹在 normalize 之前核对，仅识别精确 guarded ALTER 块，不放宽任意 PREPARE/SET：`scripts/database-schema-sql.mjs:94`、`database-schema-square-ddl.mjs:1`。本次独立复跑 85 个 schema 对抗用例和一致性检查全部通过。
- 视觉一致性通过：独立打开真实生产截图进行邻居比较：`/tmp/html-share-square/live-postgresql-chromium-my-demos-1440.png` 与 `live-postgresql-chromium-square-1440.png`，顶栏、标题、搜索、表头边线、白底行和分页保持同一视觉；广场去除本人配额及管理列，保留名称主权重。独立查看 `live-mysql-webkit-settings-375.png` 和 `live-mysql-webkit-detail-200percent.png`，目录/已选区及长路径没有页面横向溢出，控件与文字完整可见。共享样式数值为 workspace max-width 1280、标题 24/600、surface 8px、控件最小 40px：`apps/web/src/app/management.css:2`、`:16`、`:37`、`:64`；触控修复是 `square-directory-browser.tsx:86` 和 `square-audience-picker.tsx:125` 的 40×40；真实测量断言见 `scripts/project-square-browser-support.mjs:75`。200% 明确限定为 CSS zoom 2，不声称完成工具栏缩放/真机。
- 旧问题复验通过：重复 q 在 trim 之前拒绝且不调用仓储：`packages/core/src/square/service.ts:101`、`apps/server/src/square.test.ts:157`；目录新增加载骨架：`square-directory-browser.tsx:184`；触控目标按上述代码和截图复核。旧详情测试只增 square GET fixture、按钮精确定位，保留原安全断言：`tests/browser/demo-detail.spec.ts:47`、`:226`。

## 实际执行与原始输出

本次独立执行核心/目录/身份/HTTP/配置测试，未访问业务库、未重建 `.next`：

```text
RUN  v4.1.0 /Users/zhangxiang/Work/html-share/html-share

Test Files  8 passed (8)
     Tests  57 passed (57)
  Start at  01:05:07
  Duration  1.13s (transform 183ms, setup 0ms, import 467ms, tests 230ms, environment 0ms)
```

命令：`pnpm exec vitest run packages/core/src/square/service.test.ts packages/core/src/organization/directory-service.test.ts packages/dingtalk/src/directory-client.test.ts packages/dingtalk/src/directory-snapshot.test.ts packages/dingtalk/src/client.test.ts packages/config/src/directory-environment.test.ts apps/server/src/square.test.ts apps/server/src/directory.test.ts`，使用 `/tmp/html-share-square-tools/bin` 的 Node 24，退出 0。

```text
Test Files  2 passed (2)
     Tests  85 passed (85)
  Start at  01:06:50
  Duration  409ms (transform 27ms, setup 0ms, import 49ms, tests 245ms, environment 0ms)

$ node scripts/database-schema-check.mjs
Database schema equivalence PASS: 19 models, 13 enums; fields, relations, indexes, CHECKs and physical whitelist verified.
```

命令分别为 `pnpm exec vitest run scripts/database-schema-check.test.mjs scripts/database-schema-square-ddl.test.mjs` 与 `pnpm db:schema:check`，均退出 0。另一次 schema 定向命令只匹配了 2 个用例，本报告采用随后完整的 85 用例结果。

直接读取本轮已有原始日志 `/tmp/html-share-square/tests.log`、`browser-regression.log`，不是本次独立重跑全量：

```text
Test Files  121 passed (121)
     Tests  909 passed (909)
  Start at  00:59:18
  Duration  56.02s (transform 1.21s, setup 0ms, import 5.86s, tests 43.33s, environment 5ms)

116 passed (28.7s)
```

直接读取 `/tmp/html-share-square/typecheck.log` 的完整编译输出：

```text
$ pnpm build:packages && tsc -p tsconfig.json --noEmit && pnpm --filter './apps/**' --filter './packages/**' run --if-present typecheck
$ pnpm --filter './packages/**' run --if-present build
Scope: 6 of 10 workspace projects
packages/core build$ tsc -p tsconfig.build.json
packages/config build$ tsc -p tsconfig.build.json
packages/observability build$ tsc -p tsconfig.build.json
packages/storage build$ tsc -p tsconfig.build.json
packages/observability build: Done
packages/config build: Done
packages/storage build: Done
packages/core build: Done
packages/db build$ tsc -p tsconfig.build.json
packages/dingtalk build$ tsc -p tsconfig.build.json
packages/dingtalk build: Done
packages/db build: Done
Scope: 9 of 10 workspace projects
packages/core typecheck$ tsc --noEmit -p tsconfig.json
packages/config typecheck$ tsc --noEmit -p tsconfig.json
packages/observability typecheck$ tsc --noEmit -p tsconfig.json
packages/storage typecheck$ tsc --noEmit -p tsconfig.json
packages/observability typecheck: Done
packages/core typecheck: Done
packages/storage typecheck: Done
packages/config typecheck: Done
apps/web typecheck$ tsc --noEmit
packages/db typecheck$ tsc --noEmit -p tsconfig.json
packages/dingtalk typecheck$ tsc --noEmit -p tsconfig.json
packages/dingtalk typecheck: Done
apps/web typecheck: Done
packages/db typecheck: Done
apps/server typecheck$ tsc --noEmit -p tsconfig.json
apps/worker typecheck$ tsc --noEmit -p tsconfig.json
apps/worker typecheck: Done
apps/server typecheck: Done
Scope: 2 of 10 workspace projects
apps/server build$ tsc -p tsconfig.build.json
apps/worker build$ tsc -p tsconfig.build.json
apps/worker build: Done
apps/server build: Done
```

已直接读取主 Agent 最终重跑留下的 `/tmp/html-share-square/build.log`，以下为原始输出节选（最终修复后的完整 `pnpm build`，原日志含两库 client 生成、所有 packages 与 apps）：

```text
$ pnpm db:generate && pnpm build:packages && pnpm build:apps
$ node scripts/database-generate.mjs
Generated postgresql client
Generated mysql client
apps/web build: ▲ Next.js 16.3.3 (webpack)
apps/worker build: Done
apps/server build: Done
apps/web build: ✓ Compiled successfully in 802ms
apps/web build:   Running TypeScript ...
apps/web build:   Finished TypeScript in 505ms ...
apps/web build: ✓ Generating static pages using 9 workers (9/9) in 102ms
apps/web build: Route (app)
apps/web build: ┌ ○ /
apps/web build: ├ ○ /_not-found
apps/web build: ├ ○ /admin/project-removal
apps/web build: ├ ƒ /api/health
apps/web build: ├ ○ /demos
apps/web build: ├ ƒ /demos/[projectId]
apps/web build: ├ ƒ /login
apps/web build: ├ ○ /square
apps/web build: ├ ƒ /square/[projectId]
apps/web build: └ ○ /tokens
apps/web build: ○  (Static)   prerendered as static content
apps/web build: ƒ  (Dynamic)  server-rendered on demand
apps/web build: Done
```

已直接读取 `/tmp/html-share-square/api-smoke.log` 和 `live-browser.log` 的原始终态输出。API 的 assertions 为累积计数，即两库各 69、合计 138；浏览器为四组 754：

```json
{"status":"project-square-smoke-ok","provider":"postgresql","assertions":69}
{"status":"project-square-smoke-ok","provider":"mysql","assertions":138}
{"status":"project-square-browser-case-ok","provider":"postgresql","browser":"chromium"}
{"status":"project-square-browser-case-ok","provider":"postgresql","browser":"webkit"}
{"status":"project-square-browser-case-ok","provider":"mysql","browser":"chromium"}
{"status":"project-square-browser-case-ok","provider":"mysql","browser":"webkit"}
{"status":"project-square-browser-ok","assertions":754,"reports":[{"provider":"postgresql","browser":"chromium","status":"passed"},{"provider":"postgresql","browser":"webkit","status":"passed"},{"provider":"mysql","browser":"chromium","status":"passed"},{"provider":"mysql","browser":"webkit","status":"passed"}],"productionWeb":true,"realDatabaseAndMinio":true,"syntheticDirectory":true,"interceptedApi":false,"widths":[1440,1065,375],"cssZoom":"200% at 750 CSS px","screenshotDirectory":"/tmp/html-share-square"}
```

两库旧 schema 升级记录位于 `docs/project-square-validation.md:11`，可重复过程已逐段核对 `scripts/project-square-upgrade-smoke.mjs:199`。本次核对实际脚本、原始日志和四张截图，未再启动并发双库/Worker 验收，也未把主 Agent 的执行记录描述成本次亲自重跑。

## 结论边界

本地需求实现、授权、事务、交互与质量审查通过。真实钉钉仍按 `docs/project-square-dingtalk.md:1` 的外部边界待验；本次官方文档打开尝试未取得可读正文，不据此追加“真实接口已验证”的声明。阶段完成状态和用户业务环境部署由主 Agent 更新，本报告不替代发布或真实企业验收。
