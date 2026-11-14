# 飞书登录与账户关联

GitHub 公共版可同时使用钉钉和飞书登录。飞书默认关闭，钉钉继续提供既有免登、组织目录与管理员配置。此功能不包含生产部署。

## 配置

在飞书开放平台创建本组织自建应用，开启网页应用能力，发布并限定可使用成员。后端设置：

```dotenv
FEISHU_ENABLED=true
FEISHU_APP_ID=cli_your_app_id
FEISHU_APP_SECRET=replace-with-feishu-app-secret
FEISHU_TENANT_KEY=your_allowed_tenant_key
```

以上字段不使用 NEXT_PUBLIC 前缀。沿用当前 `DINGTALK_APP_ID` 对应的平台组织：启用飞书表示管理员明确认定此飞书租户和钉钉应用属于同一组织。回调严格核验 `tenant_key`，不能开放任意租户。勿修改已有 DINGTALK_APP_ID 来启用飞书，否则会选择另一个平台组织。

按实际 `APP_AUTH_URL` / `DEMO_AUTH_URL` 的 origin 分别登记两个回调地址：

- `https://app.example.com/auth/feishu/callback`
- `https://demo.example.com/auth/feishu/callback`

授权回调和换码使用完全相同的 redirect_uri；HTTPS 为正式环境要求。启用后重新启动 Server 即可，Web 通过 `/auth/config` 读取入口，无需将飞书密钥打进 Web。所有四套 Compose 模板均传递上述配置。

申请 `contact:user.phone:readonly` 和 `contact:user.email:readonly` 权限，按飞书审批与用户授权取得 mobile/email。缺失联系方式仍可创建独立平台账户，但不能推断为同一用户。不请求离线访问、不保存上游 access_token；仅使用 `email`，不回退 `enterprise_email`。

使用官方 authorize、Token v3 和 user_info 接口，启用 PKCE S256。state 绑定浏览器、来源和管理/内容 audience；先原子消费再换码。Cookie 为 HttpOnly、SameSite=Lax、Host-only，正式环境 Secure。平台会话仍为 8 小时，双域之间复用既有一次性会话接力。

## 账户关联规则

部署方已选择：信任本组织管理员维护的手机号/邮箱，唯一匹配即自动关联。飞书官方明确这些字段可由管理员导入，**不保证用户已验证持有**。因此管理员必须维护正确资料、及时处理离职和号码回收；不适合不信任管理员维护数据的跨组织身份源。

1. 已绑定的钉钉或飞书稳定身份优先，联系方式变化不会把它改绑到另一个人。
2. 首次出现的另一来源身份，按同组织手机号或邮箱匹配。手机号去空格、括号和连字符，国内手机统一 +86；邮箱 trim + 小写，不改点号和加号后缀。空、掩码或非法值不参与。
3. 一个或两个字段都唯一命中同一有效账户时，关联到原 User.id，共用 Demo、Token、配额和停用状态。
4. 分别命中不同账户、多重命中、目标已绑定另一个同来源身份或停用时拒绝关联。没有匹配时创建独立账户。
5. 每种来源只保存最近一次资料快照，缺失字段清空该来源旧值；超过 30 天不用于首次匹配，需重新登录原来源刷新。

**老钉钉用户务必先重新登录一次钉钉，再使用飞书。** 旧数据只有钉钉 ID，没有手机号/邮箱，迁移不会猜测或伪造联系方式。钉钉应用需能通过用户信息接口返回 mobile/email；如缺少相应权限，先配置并重新授权。若先登录飞书已产生另一个账户，之后不会自动合并已有资产；请使用原登录方式，由管理员核实数据处理方案。

纯飞书账户没有钉钉 ID，不会自动成为钉钉管理员，也不能查看指定钉钉部门/人员的广场项目。关联到原账户后继承该账户现有身份关系；组织准确链接、全组织广场和项目密码访问保持原规则。

## 升级和验证

先备份并按所用数据库执行 `pnpm db:migrate:deploy`，再更新 Server/Worker/Web。新增飞书身份和联系方式表，旧 User/Tenant 主键、Demo 和 Token 不改变；钉钉身份字段改为可空。回滚到不支持空钉钉身份的旧代码前，必须评估新增飞书账户；不可直接回滚旧程序并假设兼容。

正式启用需完成：真实飞书应用发布和权限、两域回调、组织外账户拒绝、手机号/邮箱匹配、授权取消与真机浏览器。自动化使用合成授权服务验证协议和业务，不代替这部分真实联调。

官方参考：[授权码与 PKCE](https://open.feishu.cn/document/common-capabilities/sso/api/obtain-oauth-code.md)、[Token v3 迁移说明](https://open.feishu.cn/document/authentication-management/access-token/get-user-access-token.md)、[用户信息及联系方式说明](https://open.feishu.cn/document/server-docs/authentication-management/login-state-management/get.md)。
