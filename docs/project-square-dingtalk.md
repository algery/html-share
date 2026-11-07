# 项目广场：钉钉目录与身份契约

核对日期：2026-11-07。此记录对应 REQ-014、AC-075–080 和 Phase 27。
本地模拟器与 HTTP 契约测试不代替真实企业应用通讯录授权、授权范围和真机联调验收。

## 登录标识兼容

- 原个人信息接口 `GET /v1.0/contact/users/me` 的 `openId` 仍保存到 `User.dingtalkUserId`，原内部用户 ID、项目和 Token 归属不变。
- 响应有非空 `unionId` 时额外保存 `User.dingtalkUnionId`。旧响应没有该字段时仍允许登录，不根据姓名或 ID 字面相等补映射。
- 旧会话无 unionId 时，指定范围资格不能确认；创建者与全组织分支由上层按原身份执行。
- 来源：[获取用户个人信息](https://open.dingtalk.com/document/orgapp-server/dingtalk-retrieve-user-information)。

## 企业通讯录调用

通讯录调用独立使用 `DINGTALK_CONTACT_API_BASE_URL`，默认 `https://oapi.dingtalk.com`。
采用通讯录官方文档明确引用的 `GET /gettoken?appkey=...&appsecret=...`，读取 `errcode=0`、`access_token`、`expires_in`；不假设新版应用 token 与旧通讯录 token 可互换。
请求 token 的 URL 含密钥，因此不记录完整请求 URL、响应原文或异常原文。

| 接口                                          | 请求/响应中使用的字段                                                                                                  | 用途                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `GET /auth/scopes`                            | 顶层 `auth_org_scopes.authed_dept`、`authed_user`                                                                      | 从实际授权部门出发，并单独读取显式授权人员                          |
| `POST /topapi/v2/department/get`              | `dept_id`、`language=zh_CN` → `result.dept_id/name/parent_id`                                                          | 校验授权起点与部门元数据                                            |
| `POST /topapi/v2/department/listsub`          | `dept_id`、`language=zh_CN` → `result[]`                                                                               | 递归直接子部门；不当作完整子树                                      |
| `POST /topapi/user/listsimple`                | `dept_id,cursor,size=100,contain_access_limit=false,language=zh_CN` → `result.list[].userid/name,has_more,next_cursor` | 部门人员分页、跨部门按企业 userId 去重                              |
| `POST /topapi/user/getbyunionid`              | `unionid` → `result.userid/contact_type`                                                                               | 当前 unionId 映射企业用户，只接受 `contact_type=0` 内部成员         |
| `POST /topapi/v2/user/get`                    | `userid,language=zh_CN` → `result.userid/unionid/name/dept_id_list`                                                    | 再核对 userId/unionId，获取当前多部门归属；显式授权人员读取最小投影 |
| `POST /topapi/v2/department/listparentbydept` | `dept_id` → `result.parent_id_list`                                                                                    | 当前部门至根部门的祖先链，包含当前部门；独立于全量选择器快照        |

官方来源：

- [获取企业内部应用 access_token](https://open.dingtalk.com/document/orgapp-server/obtain-orgapp-token)
- [获取通讯录权限范围](https://open.dingtalk.com/document/app/obtain-corpsecret-authorization-scope)
- [根据 unionId 获取用户 userId](https://open.dingtalk.com/document/orgapp-server/query-a-user-by-the-union-id)
- [查询用户详情](https://open.dingtalk.com/document/orgapp-server/query-user-details)
- [获取部门列表](https://open.dingtalk.com/document/orgapp-server/obtain-the-department-list-v2)
- [获取部门详情](https://open.dingtalk.com/document/orgapp-server/query-department-details0-v2)
- [获取部门用户基础信息](https://open.dingtalk.com/document/orgapp-server/queries-the-simple-information-of-a-department-user)
- [获取指定部门的所有父部门](https://open.dingtalk.com/document/orgapp-server/query-the-list-of-all-parent-departments-of-a-department)

`active` 是账号激活状态，不是在职状态，不能据此将未激活员工当离职人员。外部联系人、无法映射、详情标识不一致和部门链不完整均拒绝成员确认。父部门接口的官方说明为不受通讯录授权范围限制，但仍需接口权限，因此成员鉴权不要求先成功读取整个组织目录。

## 目录范围与失败行为

- 仅有子部门/人员授权时返回 `limited=true`，不假设根部门 1 可读。目录根节点是可读部门的最上层，未知祖先不伪造为可选部门。
- 显式授权人员的归属部门可能不可读；保留其企业 ID 和名称，对不可读归属显示 `未授权部门（ID）`。不为补路径扩读未授权部门，不把这些部门放入可选列表。
- 可读部门生成名称路径；跨部门人员合并全部已知路径。同名人员和部门保持独立稳定 ID。
- 每次 HTTP 调用最多 10 秒；整个快照构建最多 60 秒。快照最多 10000 个部门和 50000 个人员。超额、分页循环、结构循环、响应不完整、任一页失败均拒绝此次刷新，不将部分结果伪装为成功。
- 旧接口 HTTP 200 不代表成功；必须 `errcode === 0`。60011 权限不足、50002/50004 对象不在范围、40014/42001 token 无效/过期等均返回安全 `DirectoryUnavailableError`。无效或过期应用 token 同时失效，下次重试重新获取。
- 对外错误只含固定 `DIRECTORY_UNAVAILABLE` 与受控原因，不含上游响应、人员资料、unionId、token 或 clientSecret。应用配置开关关闭时使用独立 disabled provider；关闭共享和准确链接仍由既有流程处理。

## 缓存与公开契约

`createDirectoryService(provider, {corpId?, now?, ttlMs?})` 实现两个独立缓存：目录快照和成员映射。key 包含 tenant/corp/unionId，单次刷新合并；单缓存最多 1000 个条目。TTL 最大 300000 毫秒，从读取开始计算，不能在慢请求完成时重新延长五分钟。到期刷新失败不返回旧结果，失败不缓存为成功，返回值复制防止调用者篡改缓存。

- `getSnapshot({tenantId})` → `{departments,users,limited}`。
- `resolveMember({tenantId,unionId})` → `{userId,departmentIds}`；部门 ID 包含当前归属及祖先。失效/无法确认成员抛安全错误。
- 浏览器列表与目录分页由服务端路由在最小投影后处理，provider 不直接向浏览器返回原始通讯录响应。

## 合成目录

原 `simulator-user-001/002` openId 保留；新增 `simulator-union-001..005`。
企业 userId 使用刻意不同的 `simulator-enterprise-user-001..005`，避免错误地依赖两种 ID 相等。
部门：1 根、10 产品部、11 产品部下设计组、20 研发部、21 研发部下设计组。
001 属 10；002 属 11 和 20；003 属 20（不命中 10）；004 属 11（可在首次平台登录前选择）；005 属 21 且与 002 同名。
既有登录 code 不变，额外支持 `simulator-member-003/004/005`。

## 自动验证与外部待验

本地测试覆盖旧登录兼容、租户/身份隔离、singleflight、五分钟边界、失败后重试、目录与鉴权独立、分页/部门循环、部分页失败、累积数量上限、标识不一致、外部联系人、父部门链、10 秒/60 秒超时及错误脱敏。
真实企业验收仍需：应用权限获批、实际部分授权返回结构、unionId 绑定、调岗/离职后接口变化与真机选择器流程。
