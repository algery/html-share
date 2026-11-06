# 项目广场增量独立审查（首轮）

日期：2026-11-07。审查角色：code-reviewer；依据 `.agents/skills/code-review/SKILL.md` 执行两阶段审查。范围为未提交的 REQ-013/014、AC-067–082、Design-Brief 1.1 与 DEV-PLAN Phase 27–30 增量。凭据门禁四项既有改动不纳入本轮业务审查。审查员未修改业务代码、迁移或测试；报告按主 Agent 的后续明确指令落盘。

## 结论

**Stage 1：本地实现与可执行验收通过。Stage 2：通过。当前未关闭 HIGH / MEDIUM / LOW：0 / 0 / 0。** 首轮发现的触控尺寸、目录加载骨架及重复搜索参数处理问题均已由主 Agent 修复，并完成对应复核。

此结论覆盖真实 PostgreSQL / MySQL、MinIO、Server / Worker、生产构建 Web 和合成钉钉目录。真实企业通讯录权限、实际调岗/离职响应和钉钉客户端真机仍是外部待验，不能据此声称真实企业上线验收通过。200% 证据使用 CSS zoom，未冒充浏览器工具栏缩放。边界见 `docs/project-square-browser.md:32`、`:47` 与 `docs/project-square-dingtalk.md` 的“自动验证与外部待验”。

## Stage 1：Spec Compliance

下表逐条覆盖全部 16 项 AC。“通过”指本地实现及本轮隔离验证；涉及真实钉钉的外部条件按上文保留。

| AC  | 结论与实现证据                                                                                                                                                                                                                                                                                                                           | 验证证据                                                                                                                                                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 067 | 通过。无设置行视为关闭，首次范围为 null；确认发布才提交。`packages/core/src/square/contracts.ts:107`、`packages/db/src/square-mapping.ts:93`、`apps/web/src/components/project-square-manager.tsx:108`、`:166`、`:217`。共享写入不修改项目/配额。`packages/db/src/square-writer.ts:42`。                                                 | `scripts/database-contract-square.test.mjs:16` 比较项目原记录不变；`scripts/project-square-upgrade-smoke.mjs:218` 确认真正旧 schema，`:233` 验证新表为空、`:237` 验证关闭；真实浏览器默认/确认流程见 `scripts/project-square-browser.mjs:76`。                                                                                   |
| 068 | 通过。租户、有效项目/revision、共享开关为公共前置；owner、全组织、部门/人员并集才通过。`packages/db/src/square-mapping.ts:26`。同一 where 用于 count、搜索、分页、详情。`packages/db/src/square-repository.ts:33`、`:49`；MySQL 同路径实现。                                                                                             | `scripts/database-contract-square.test.mjs:16`、`:238` 覆盖大小写、父部门、异租户、不可见搜索计数；`scripts/project-square-smoke.mjs:87` 开始的混合范围闭环及真实四组浏览器。                                                                                                                                                    |
| 069 | 通过。关闭只提交版本与 false，保留上次范围且不查目录；每次请求重读共享设置。`packages/core/src/square/service.ts:159`、`packages/db/src/square-writer.ts:40`、`:53`、`apps/web/src/components/project-square-manager.tsx:84`。重发再次确认，风险说明持续显示。                                                                           | `scripts/database-contract-square.test.mjs:87`；`tests/browser/project-square.spec.ts:12`、`:99`；真实浏览器缩小、撤回、重发及准确链接闭环。                                                                                                                                                                                     |
| 070 | 通过。项目行锁内重新验证 owner/ACTIVE、版本及 PREPARED/PROCESSING 上传；设置、目标、成功审计同事务。`packages/db/src/square-writer.ts:10`、`:31`、`:71`，MySQL `packages/db/src/mysql/square-writer.ts:11`。读取当前 revision，不改发布链路。                                                                                            | `scripts/database-contract-square.test.mjs:113` 真实并发写、上传互斥、审计失败回滚；`:147` 当前集合替换、旧集合等待及删除；真实 smoke 覆盖/撤回/删除通过。                                                                                                                                                                       |
| 071 | 通过。独立只读白名单，不读取本人含密码 DTO；管理权限仍为 owner。`packages/db/src/square-mapping.ts:8`、`packages/core/src/square/service.ts:44`、`:123`、`packages/db/src/project-reader.ts:32`、`packages/db/src/password-management-repository.ts:25`、`packages/db/src/upload-repository-preparation.ts:214`。                        | `scripts/project-square-smoke.mjs:143` 同范围内访客拒绝本人详情/共享/首页；`scripts/project-square-mutation-checks.mjs:9` 使用该访客会话及其本人 Token 验证密码变更、删除、MCP 覆盖拒绝且项目不变。密码读取包含在本人详情拒绝中。真实浏览器响应逐层白名单、零 owner API 请求见 `scripts/project-square-browser-support.mjs:93`。 |
| 072 | 通过。只接受 app Host + app 会话，401/404、private no-store；密码和 MCP Token 不作为广场身份。`apps/server/src/modules/square/request.ts:19`、`:24`、`:59`；资格过滤见 `packages/db/src/square-mapping.ts:34`。前端失败清旧数据。`apps/web/src/components/square-browser.tsx:19`、`square-detail.tsx:18`。                               | `apps/server/src/square.test.ts:17` 身份/Host/CORS矩阵；`scripts/project-square-smoke.mjs:189` 密码凭证401；真实范围外详情404与撤回后内容清除；`tests/browser/project-square.spec.ts:270` 过期状态。                                                                                                                             |
| 073 | 通过。准确内容读取只用原租户、项目与当前 revision，未引入 square 条件。`packages/db/src/project-reader.ts:52`；MySQL `packages/db/src/mysql/project-reader.ts` 同实现。范围说明 `apps/web/src/lib/square-types.ts:76`。                                                                                                                  | `scripts/project-square-smoke.mjs:163` 在限范围与撤回后分别实测范围外组织会话、有效密码凭证读取；真实浏览器经过双域接力打开内容。                                                                                                                                                                                                |
| 074 | 通过。只读文件路径搜索、分段 URL 编码、失效首页提示、当前集合与响应式卡片。`packages/core/src/square/service.ts:131`、`apps/web/src/components/square-detail.tsx:75`、`:150`、`square-project-list.tsx:9`、`:52`。未修改 HTML 内容网关或注入只读脚本。                                                                                   | `tests/browser/project-square.spec.ts:152` 多 HTML/中文/嵌套路径、1440/1065/375/CSS200%；`scripts/project-square-browser-support.mjs:154` 真正点击并读取嵌套 HTML；真实截图逐图检查。                                                                                                                                            |
| 075 | 通过本地实现。浏览器部门树、搜索、部门路径、混选、去重、回显、移除和分页均存在。`apps/web/src/components/square-directory-browser.tsx:51`、`:105`、`square-audience-picker.tsx:17`、`:69`、`use-directory-page.ts:34`。目录人员与平台注册分离。                                                                                          | `tests/browser/project-square.spec.ts:49`、`:231`、`:246`；真实浏览器先选择未注册的005再首次登录命中，见 `docs/project-square-browser.md:27`。钉钉真机仍待验。                                                                                                                                                                   |
| 076 | 通过本地实现。每次成员刷新以企业 userId 及当前部门祖先链判断，不保存展开人员快照；显式人员并集独立于部门。`packages/dingtalk/src/directory-client.ts:49`、`:68`、`:73`、`packages/db/src/square-mapping.ts:27`。                                                                                                                         | `packages/dingtalk/src/directory-client.test.ts:13` 验证多部门祖先且不依赖全目录；`:31`、`:48`、`:68` 拒绝外部联系人/身份不符/无效链。缓存到期替换来源的测试见 `packages/core/src/organization/directory-service.test.ts:42`。真实调岗/离职接口仍待验。                                                                          |
| 077 | 通过。指定目标1–100、去重、后端同租户快照查存在；全组织不得带目标；先验证 owner。`packages/core/src/square/service.ts:22`、`:144`、`:186`、`:215`。写入 Host/会话/Origin/CSRF 见 `apps/server/src/modules/square/routes.ts:42`。                                                                                                         | `packages/core/src/square/service.test.ts:68`、`:95`、`:114`；`apps/server/src/square.test.ts:17`、`:31`；真实双库伪造目标失败保旧与访客拒绝。                                                                                                                                                                                   |
| 078 | 通过。任一页/结构/上游失败拒绝整个快照，超时和限流异常脱敏；目录失败仅保留 owner/全组织分支，关闭绕过目录。`packages/dingtalk/src/directory-snapshot.ts:75`、`:122`、`directory-http.ts:25`、`packages/core/src/square/service.ts:27`、`:159`。                                                                                          | `packages/dingtalk/src/directory-snapshot.test.ts:58`、`directory-client.test.ts:84`、`:125`；`tests/browser/project-square.spec.ts:99` 错误重试与草稿保留；双库 smoke 缓存过期失败闭合。                                                                                                                                        |
| 079 | 通过本地实现。TTL最多300000毫秒且从读取开始计算，过期先删除、刷新失败不返旧值；共享授权无项目级缓存。`packages/core/src/organization/directory-service.ts:14`、`:49`、`:60`，`packages/db/src/square-repository.ts:33`。                                                                                                                 | `packages/core/src/organization/directory-service.test.ts:42` 精确到期边界与失败后重试，`:64` 快照失败、`:80` 慢请求超TTL拒绝；真实 smoke 缩小范围无需等待目录缓存、过期目录不返回指定范围。真实企业变化传播仍待验。                                                                                                             |
| 080 | 通过本地实现。仍用 openId 登录键，仅受信 users/me 的 unionId 可选补齐；企业映射再次核验 userId/unionId。`packages/dingtalk/src/client.ts:230`、`packages/db/src/auth-repository.ts:27`、`:37`、`packages/db/src/mysql/auth-repository.ts:24`、`:35`、`packages/dingtalk/src/directory-client.ts:54`。                                    | `scripts/database-contract-square.test.mjs:190` 旧 User/项目/Token/会话归属；`scripts/project-square-upgrade-smoke.mjs:224` 真旧schema数据全比较、`:266`旧会话/Token仍可用。真实应用 unionId 绑定仍待验。                                                                                                                        |
| 081 | 通过。两库新增 nullable unionId、三表，默认off、目标ID大小写敏感；provider差异限制在仓储。`packages/db/prisma/migrations/20261107000000_project_square/migration.sql:1`；MySQL 同名迁移`:1`、`:24`。                                                                                                                                     | 双库首次/重复部署与真正旧schema升级通过；真实数据库契约12项、API/MinIO/Worker138断言、浏览器四组754断言；发布Worker零正文读取。schema工具原始输出见下。                                                                                                                                                                          |
| 082 | 通过。目录分页只返回必要名称/路径/ID，错误固定文案及trace；加载/空/失败/重试状态与缓存清除存在。`apps/server/src/modules/directory/routes.ts:27`、`:55`、`:61`；`apps/web/src/components/square-load-state.tsx:12`、`square-directory-browser.tsx:164`。成功审计原子、失败审计无范围明细。`packages/db/src/square-writer.ts:71`、`:87`。 | `apps/server/src/directory.test.ts:13`、`:29`；`scripts/database-contract-square.test.mjs:81` 审计无企业人员原文、`:129` 审计失败回滚；真实浏览器控制台无捕获凭据、密码遮罩截图、375px布局。                                                                                                                                     |

完整实现：上述本地业务路径。部分完成：仅真实钉钉环境验收条件，代码不因此虚报企业验证。未实现的本地 Spec 条目：未发现。

引导真实性：项目内容、姓名搜索、含子部门、重试、范围说明、重新发布均对应实现。证据为 `square-directory-browser.tsx:27`、`:65`、`:152`、`project-square-manager.tsx:131`、`:153`、`square-project-list.tsx:94` 及上述浏览器流程。未发现指向不存在功能的提示。

## 迁移及 reviewed 指纹

首先独立审查两份新增 SQL 与两套 `square.prisma` / `publication.prisma`：仅新增列与表，不修改历史迁移、旧登录键、项目或 Token 数据；PG UUID / MySQL CHAR(36) 外键、级联删除、目标唯一索引、enabled=false 与可空 unionId 相符。证据：PG迁移`:1`、`:7`、`:17`、`:30`；MySQL迁移`:3`、`:12`、`:22`、`:35`、`:38`。

收到本轮隔离双库首次 migrate deploy 成功原始输出后，才向主 Agent 确认允许更新 reviewed 指纹。后续 `scripts/database-schema-reviewed-sql.mjs:8` 已更新；`scripts/database-schema-sql.mjs:95` 在规范化之前验证原始 SQL 指纹，`scripts/database-schema-square-ddl.mjs:3` 只精确识别已审 guarded ALTER 块，未知动态 SQL 仍失败。新增对抗测试独立复跑通过。

主 Agent 转交的首次部署原始输出（exit 0）：

```text
Database migrations deployed (postgresql)
Database migrations deployed (mysql)
```

主 Agent 转交的真实旧schema升级输出（exit 0）：

```text
postgresql square upgrade PASS: old schema verified, original ownership/data preserved, unionId null, square off, repeated deploy unchanged
mysql square upgrade PASS: old schema verified, original ownership/data preserved, unionId null, square off, repeated deploy unchanged
```

审查员独立执行 schema 检查原始输出：

```text
Database schema equivalence PASS: 19 models, 13 enums; fields, relations, indexes, CHECKs and physical whitelist verified.
```

## Stage 2：Code Quality

**代码结构通过。** 新增业务和验证文件均不超过300行；例如 core service 254行、共享管理258行、真实浏览器284行、升级脚本299行。目录读取、缓存、权限服务、事务写、DTO映射和UI选择器分别承担单一职责。共享双库映射集中在 `packages/db/src/square-mapping.ts:8`；两套 writer 仅客户端、事务封装和SQL引号存在provider差异，未发现业务语义分叉。

**安全扫描未发现本轮增量问题。** 对新增 core/directory/DB/API/UI 搜索 `eval(`、`innerHTML`、`dangerouslySetInnerHTML`、`any`、真实密钥前缀、前端敏感环境变量及本机绝对路径，没有命中危险实现。项目锁SQL为参数绑定模板，见 `packages/db/src/square-writer.ts:11`、MySQL对应`:12`。上游token及完整个人响应不进入错误，见 `packages/dingtalk/src/directory-http.ts:39`、`:113`；白名单见 `packages/db/src/square-mapping.ts:8`。这不是对未改动仓库或私有 ignored 配置的全盘安全背书。

**测试真实性通过。** 检查了真实双库夹具、真实上传/Worker、事务冲突/审计回滚、未知查询输入和失败后UI状态。原本仅新schema下的旧账号测试不足以证明升级，现已补真实旧schema列缺失检查及七类旧数据前后比较（`scripts/project-square-upgrade-smoke.mjs:185`、`:218`、`:224`）。UI mock被明确限制为交互证据，真实权限由未拦截API的双库测试承担（`scripts/project-square-browser.mjs:30`、`docs/project-square-browser.md:3`）。AC071缺少的访客变更实测已补齐，见 `scripts/project-square-mutation-checks.mjs:9`。CSS200%与真机边界未混淆。

**Spec 漂移未发现。** 新增 `/square` 与详情、本人square设置、directory路由、三张表均对应 DEV-PLAN 公开契约。没有新增成员邀请、协作角色、MCP广场管理工具或访客管理权限。证据：`apps/web/src/app/square/page.tsx:1`、`apps/web/src/app/square/[projectId]/page.tsx:1`、`apps/server/src/modules/square/routes.ts:18`、`:42`、`:70`、`:92`、`apps/server/src/modules/directory/routes.ts:19`。

**视觉对比通过。** 审查员实际打开并比较 `/tmp/html-share-square/live-postgresql-chromium-my-demos-1440.png` 与 `live-postgresql-chromium-square-1440.png`：顶栏56px、左边缘104px、标题/搜索/表头与分页对齐；继承同一色彩与表格控件。再打开 `live-mysql-webkit-settings-375.png`、`live-mysql-webkit-detail-200percent.png`，检查换行、选项、长路径及无访客管理按钮；未见页面横溢。共用数值来源 `apps/web/src/app/management.css:2`、`:16`、`:40`、`:45`、`:85`、`:255`。1440多条密度另核对mock截图 `html-share-square-list-1440-chromium.png`，首屏超过8个完整条目。

## 首轮发现与关闭证据

| 严重度 | 原问题                                                                     | 复核结果                                                                                                                                                                                 |
| ------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MEDIUM | 部门展开与移除按钮宽度约32px，未达Brief40px触控目标。                      | 已关闭。`square-directory-browser.tsx:86` 与 `square-audience-picker.tsx:125` 均为 min-w-10/min-h-10；真实四组浏览器 `scripts/project-square-browser-support.mjs:74` 检查实际宽高均≥40。 |
| MEDIUM | 目录加载只有文本，缺少Brief指定骨架。                                      | 已关闭。`square-directory-browser.tsx:184` 保留状态文字并添加骨架，motion-safe尊重减少动效。                                                                                             |
| MEDIUM | 重复参数 `?q=x&q=y` 进入 `.trim()` 抛TypeError，503不符合非法输入400契约。 | 已关闭。`packages/core/src/square/service.ts:101` 先检查string；`apps/server/src/square.test.ts:157` 实测重复q返回400且`:168`验证不访问仓储。审查员独立复跑5项通过。                     |

测试证据修正：旧详情用例把“重新加载”模糊匹配到两个按钮，现 `tests/browser/demo-detail.spec.ts:226` 使用exact，`:47`补square GET夹具，原断言未删除；完整116项复跑通过。第一次全量测试缺 MinIO 测试环境变量的1项失败已补正确环境重跑，最终909项通过。这两次早期失败不作为产品缺陷计数，也没有被计入最终通过结果。

## 编译与验证原始输出

Node 24。审查员独立运行六个关键测试文件的输出：

```text
 Test Files  6 passed (6)
      Tests  46 passed (46)
   Start at  00:52:17
   Duration  1.14s (transform 215ms, setup 0ms, import 494ms, tests 253ms, environment 0ms)
```

重复q修复后，审查员独立复跑Server测试：

```text
 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  01:01:14
   Duration  362ms (transform 114ms, setup 0ms, import 233ms, tests 68ms, environment 0ms)
```

读取 `/tmp/html-share-square/tests.log` 的最终原始输出：

```text
 Test Files  121 passed (121)
      Tests  909 passed (909)
   Start at  00:59:18
   Duration  56.02s (transform 1.21s, setup 0ms, import 5.86s, tests 43.33s, environment 5ms)
```

读取 `/tmp/html-share-square/browser-regression.log` 最终原始输出：

```text
  116 passed (28.7s)
```

重复q修复后，读取 `/tmp/html-share-square/typecheck.log` 原始末段（全workspace typecheck及Server/Worker重新编译）：

```text
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

真实双库契约12项、最新API smoke 138断言、生产Web四组合754断言的执行成功由主 Agent 转交；审查员另外读取了对应实现、浏览器验证文档与真实截图。完整Web build在主 Agent 转交的验证中先于真实浏览器执行完成；本报告未伪造未直接读取的完整build stdout。全量测试后唯一业务变更是q输入防御，其对应测试和编译已重新验证。`git diff --check` 在本次复核时退出0、无输出。

本报告只给出审查结论。后续fresh复审、源文档完成状态、提交与交付由主 Agent 负责。
