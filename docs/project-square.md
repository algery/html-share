# 组织项目广场

本地实现对应 Product-Spec V1.10.1 的 REQ-013/014、AC-067–082。既有项目默认关闭共享，没有新增项目成员名单。

## 使用方式

1. 在“我的 Demo”进入本人项目详情的“广场共享”，选择“全组织”或“指定部门 / 人员”。部门包含子部门，部门与人员取并集，最多100项。
2. 点击“发布到广场”并确认，才会保存和上架。已共享项目可保存新范围；关闭共享保留上次范围，重新发布需再次确认。
3. 同组织成员从“项目广场”发现自己有资格查看的项目。广场使用独立只读详情，仅展示当前成功发布的文件和内容链接。

**广场范围只限制发现。** 同组织成员取得准确内容链接后仍沿用原组织授权；开启密码访问的项目仍可使用有效密码。共享不改变密码、首页、配额或对象存储，不生成项目副本。访客不能设置首页、修改共享/密码、覆盖或删除项目；HTML文件自身的交互不受禁用。

## 配置和迁移

沿用当前 PostgreSQL/MySQL、对象存储与登录配置，不升级依赖。新增配置已覆盖两份本地env、production/1Panel示例及四份Compose：

```dotenv
DINGTALK_DIRECTORY_ENABLED=false
DINGTALK_CONTACT_API_BASE_URL=https://oapi.dingtalk.com
```

simulator模式提供独立合成目录，无需真实凭据。live模式由管理员为同一企业内部应用授予通讯录权限后启用开关，复用现有 DINGTALK_CLIENT_ID/CLIENT_SECRET/CORP_ID。真实值仅放私有配置或部署环境。关闭目录仅影响指定范围，不能阻止全组织共享、撤回或原有内容链接。

部署新代码前，按现有数据库部署流程在目标provider执行 `scripts/database-migrate.mjs`（Prisma migrate deploy），随后重启Server/Worker；不要reset数据库。两套新增迁移均为 `20261107000000_project_square`，只新增可空unionId列与共享设置、目标、审计表。没有设置行视为未共享。旧用户openId登录键、项目和Token归属不变。此次只迁移隔离验收环境，未迁移或替换已有业务服务。

官方通讯录接口、权限、旧版企业token选择和限制详见 [钉钉接口核对](project-square-dingtalk.md)。原登录保存openId；可信登录响应提供unionId后，在目标企业映射内部userId并核对身份。姓名只用于展示与搜索，不能用于身份绑定。旧账号缺unionId仍可正常登录，需重新登录补齐后才能确认指定范围资格。

## 一致性与故障

- 广场每次读取最新共享设置和当前revision，先授权，再搜索、计数和分页。修改范围/撤回不等待目录缓存到期。
- 目录与企业身份最多缓存300秒，从读取开始计时。缓存过期后刷新失败，不返回无法确认的指定范围项目；仍可返回创建者及全组织分支，并提示目录不可用。
- 部门祖先链与当前成员资格单独查询；不会使用发布时展开的人员快照。显式人员调岗仍按其企业ID匹配。无法验证当前企业成员身份时拒绝指定范围访问；`active`仅指钉钉激活，不充当HR在职字段。
- 选择器只返回必要姓名/部门路径，按页读取。应用仅获部分通讯录授权会明确提示；部分加载失败不伪装成空目录，也不扩大共享范围。
- 保存时校验本人/租户/有效项目、范围目标和settingsVersion；项目上传处理中或版本冲突返回409，旧设置保留。关闭共享不查询目录。成功变更和失败结果有脱敏审计。
- 管理会话、Host、Origin/CSRF与用户限流覆盖新接口；MCP Token和密码凭证不能进入广场或目录。响应均为private/no-store，不写浏览器持久存储。

## 验证入口

所有测试必须使用独立数据库和私有临时凭据，不可指向业务库。Node使用24。

- `pnpm test`、`pnpm typecheck`、`pnpm build`、`pnpm lint`、`pnpm db:schema:check`。
- `node scripts/database-contract-check.mjs`：同时提供隔离 `PHASE25_POSTGRES_URL` / `PHASE25_MYSQL_URL`，缺任一provider不通过。
- `node scripts/project-square-upgrade-smoke.mjs`：真实旧schema升级与重复迁移，保留用户/项目/Token/session归属。
- `node scripts/project-square-smoke.mjs`：真实双库、MinIO、MCP/Worker、广场及准确链接/密码权限闭环。
- `node scripts/project-square-browser.mjs`：生产Web、双库与Chromium/WebKit，无请求拦截。隔离约束及复验方法见 [浏览器记录](project-square-browser.md)。

本轮证据见 [交付验证](project-square-validation.md) 和 [独立审查](project-square-review.md)。真实钉钉通讯录授权范围、权限不足、真实调岗/离职变化及钉钉客户端仍需部署环境联调；合成目录、浏览器模拟和CSS zoom不能替代这些外部验收。
