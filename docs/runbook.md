# HTML Share 生产运行手册

## 上线前置

- 准备两个独立 HTTPS 域名：`APP_HOST` 与 `DEMO_HOST`，并把两者 A/AAAA 记录指向部署主机。Caddy 只有在 DNS 生效且 80/443 可达时才可签发证书。
- 在钉钉开放平台同时登记两个 HTTPS 回调域名，轮换曾暴露的 Client Secret，并把新值只写入密钥系统。
- 配置经过复核的 `ADMIN_DINGTALK_USER_IDS`。禁止使用页面自助提权。
- PostgreSQL 与 OSS Bucket 必须是外部持久服务；Bucket 私有、仅授予最小读写权限，应用容器不保存业务数据。
- `server` 不发布宿主机端口；只能由 Compose 内部的 Caddy 访问。这样启用 Fastify `trustProxy` 后，`X-Forwarded-For` 仅来自受信任网关，登录、MCP 和内容读取的 IP 限流不会把整个网关当成一个用户。

## 部署

### 1Panel + OpenResty

1. 推荐在性能较好的开发机构建镜像。先在服务器运行 `uname -m`：`x86_64` 对应 `linux/amd64`，`aarch64` 对应 `linux/arm64`。本机将 `deploy/1panel-build.env.example` 复制为根目录 `1panel-build.local`，填写正式域名、公开钉钉 Client ID/Corp ID、与服务器一致的版本标签和平台，然后运行：

   ```sh
   ./scripts/build-1panel-images.sh
   ```

   脚本通过 Buildx 构建指定平台的三个镜像，核对镜像架构，执行隐私审计，再在 `release/` 生成一个不含生产 Secret 的交付目录；其中 `images.tar.gz` 已用 `docker save` 合并并去重共享层。

2. 把整个交付目录上传到服务器固定目录。核对 `SHA256SUMS` 后，在 1Panel「容器 → 镜像 → 导入」选择 `images.tar.gz`；若当前面板只接受 `.tar`，在服务器执行 `gzip -dk images.tar.gz` 后导入 `images.tar`，或直接执行 `docker load -i images.tar.gz`。
3. 将交付目录内的 `production.env.example` 复制为 `.env`，替换所有示例值后执行 `chmod 600 .env`。本机构建配置只含浏览器公开值；数据库密码、钉钉 Client Secret、OSS Secret 和两个随机密钥只能写入服务器 `.env`，真实文件不得提交、打包或发送到聊天中。`.env` 的 `HTML_SHARE_IMAGE_TAG` 和 `HTML_SHARE_PLATFORM` 必须与 `manifest.txt` 完全一致。
4. 1Panel 安装的 PostgreSQL 通过外部 Docker 网络与应用编排互通。正式环境固定使用 `HTML_SHARE_1PANEL_NETWORK=1panel-network`，`DATABASE_URL` 的主机固定为该网络内的数据库容器名 `1Panel-postgresql-vHO6`，端口使用容器端口 `5432`，不能填写 `localhost` 或 `127.0.0.1`。部署前执行 `docker network inspect 1panel-network`，并执行 `docker inspect 1Panel-postgresql-vHO6 --format '{{json .NetworkSettings.Networks}}'`，确认数据库容器已加入该网络。
5. 1Panel 进入「容器 → 编排 → 创建编排 → 路径选择」，选择交付目录内的 `compose.yaml`。这是无 `build:` 的纯运行编排；`migrate`、`server`、`worker` 会同时加入项目内部 `application` 网络和外部 `1panel-network`，`web` 只加入 `application`。外部网络不存在时 Compose 会直接报错，不会悄悄创建一个同名隔离网络。`migrate` 正常状态是执行一次后 `Exited (0)`。宿主机端口转发可能从 `1panel-network` 网关进入 Server；本机生产实例实测网关为 `172.18.0.1`。因此 `.env` 使用 `TRUSTED_PROXY_IPS=127.0.0.1,172.18.0.1,172.31.240.0/24`，同时信任该精确网关和专用应用子网，不能扩大为整个共享 `172.18.0.0/16` 网络。
6. `compose.yaml` 只把 `127.0.0.1:13000` 和 `127.0.0.1:13001` 发布给宿主机，不占用 OpenResty 的 80/443。若端口冲突，可同时修改 `.env` 的端口以及下述 OpenResty location 文件中的上游端口。
7. 在 1Panel「网站」中创建两个反向代理站点并启用 HTTPS：管理域先指向 `http://127.0.0.1:13000`，内容域指向 `http://127.0.0.1:13001`。随后进入各站点「配置 → 资源」，管理域用交付目录内的 `app.locations.conf` 替换生成的 `location /`，内容域用 `demo.locations.conf` 替换。`X-Forwarded-Proto` 必须写在实际包含 `proxy_pass` 的每一个 `location` 内；只写在 `server` 层不可靠，因为 location 定义任意 `proxy_set_header` 后便不会继承 server 层的同类指令。保存前检查语法，再重载 OpenResty。
8. 不要在 1Panel 额外开启全站 CORS 或反向代理缓存。应用自己控制带凭证 CORS 和缓存策略；面板重复注入会扩大授权面或缓存私有响应。若启用 WAF，必须回归验证钉钉回调、`/mcp` 和管理 API。
9. 部署后在服务器验证：

   ```sh
   curl -fsS http://127.0.0.1:13000/api/health
   curl -fsS -H 'Host: app.example.com' http://127.0.0.1:13001/health/live
   curl -fsS https://app.example.com/health/live
   curl -fsS -o /dev/null -w '%{http_code}\n' https://app.example.com/health/metrics
   curl -fsS -I https://demo.example.com/not-a-project/not-a-file
   ```

   前三个请求应成功，公开 metrics 必须返回 `404`，不存在的内容路径也应返回 `404`。在 1Panel 编排详情确认 `server`、`worker`、`web` 均为 healthy。

10. 更新时先完整备份数据库和对象存储，再构建并上传新镜像包，把 `HTML_SHARE_IMAGE_TAG` 改成新版本号并在 1Panel 重建编排。回滚时切回上一个已导入的镜像标签；数据库 migration 只有确认向后兼容时才能回滚应用。

### 独立 Caddy

1. 将 `deploy/production.env.example` 复制到部署主机的受控路径，例如 `/etc/html-share/production.env`，由密钥系统注入空白敏感项；该文件绝不提交。
2. 在仓库根目录执行：

   ```sh
   docker compose --env-file /etc/html-share/production.env -f compose.production.yaml build
   docker compose --env-file /etc/html-share/production.env -f compose.production.yaml up -d
   docker compose --env-file /etc/html-share/production.env -f compose.production.yaml ps
   ```

3. `migrate` 必须显示 `exited (0)`，其余服务必须 `healthy`。再验证：

   ```sh
   curl -fsS https://$APP_HOST/health/live
   docker compose --env-file /etc/html-share/production.env -f compose.production.yaml exec server node -e "fetch('http://127.0.0.1:3001/health/metrics').then(r=>r.text()).then(console.log)"
   curl -fsS -I https://$DEMO_HOST/not-a-project/not-a-file
   ```

4. 用新浏览器会话完成一次管理端登录、MCP 发布、内容访问、覆盖与删除。日志只记录 `trace_id` 和结构化结果，不记录 Token、授权码、Cookie 或文件正文。

## V1.4 密码访问：协调升级与权限保留回退

此版本新增项目访问模式、密码版本、项目密码凭证及短期密码结果密文。升级前备份数据库、私有 Bucket 和受控密钥；记录已验证的密码兼容 Server/Worker/Web 镜像标签。该备份中的访问模式、密码哈希、版本与凭证必须成套保留，不能只恢复文件或将密码字段清空。

1. 先暂停客户端发起新发布，让已有上传完成并等待 `PROCESSING` 任务结束；确认没有正在上传或待发布任务后，在管理域临时拒绝 `/mcp`（包括所有子路径），再暂停 Worker、部署迁移与新版服务。该维护窗口中的客户端重试也应被拒绝，不能只停 Worker 后继续接收新任务。无法有序排空或需要立即止损时，停止 Server，使代理返回 502/503；保留任务和权限字段，恢复兼容服务后继续处理或按既有到期规则清理，保持私有 Bucket 无直接公开入口。
2. 用受控运行环境向 **Server** 注入 `PASSWORD_RESULT_ENCRYPTION_KEY`：必须是 **32 字节安全随机数的规范 Base64**，不是32字符字符串。用密钥管理器生成和保存，通过 `.env`（权限600）或运行时 Secret 注入；禁止作为 `NEXT_PUBLIC_*`、镜像构建参数、命令行明文或安装包内容。现有 Compose 已要求该值；保持所有 Server 实例一致。Worker 不需要解密权限，它只执行元数据切换和过期材料清理。`AUTH_STATE_SECRET`、`MCP_TOKEN_HASH_SECRET` 继续使用独立密钥。
3. 执行受版本控制的 migration `20260909000000_password_access`；只允许追加兼容字段，不执行 `db push` 或回滚 SQL。迁移后旧项目必须保持 `organization`、空密码哈希与密码版本0，旧任务继续按原权限工作。混合 Server/Worker 版本期间保持发布暂停，全部应用与两个 Skill 分发包升级完成后才恢复发布。
4. 恢复 Worker 并验证健康、无失败清理积压；先验证旧组织项目与旧客户端默认发布，再用隔离演示项目验证明确开启、覆盖继承、重置和关闭。密码结果密文仅在24小时幂等窗口向任务所有者返回；超时、失败、关闭、重置或删除后不得再从历史任务得到旧密码。项目读取每次查当前模式、版本与状态，不能依靠代理缓存授权。
5. 复核内容域代理：`GET /auth/password` 和 `POST /auth/password/verify` 都须到 Server；保持真实 `Host`、`X-Forwarded-Proto`、`Origin` 与 Cookie，本站 HTTPS Origin 应成功，`null` 和外站 Origin 应403。内容域 `/api/*`、`/mcp`、用户信息和管理 metrics 均须404。不能为兼容密码页放开全站CORS、允许 `Origin: null`、删除 Cookie Secure/HttpOnly 或启用公共代理缓存。

清理验收使用计数而不是查询敏感字段原文：检查 `upload_tasks` 中超过24小时仍有 `encrypted_password_result` 或 `pending_password_hash` 的数量，以及 `password_access_grants` 中已过期/撤销行的积压。清理每批最多100行，使用 `SKIP LOCKED`；暂被发布事务锁住的行应在后续批次清理。当前项目有效 `password_hash` 不受24小时结果清理影响。Worker 的密码清理失败须告警；不能以定时清理替代请求时的到期、版本和项目状态校验。

加密密钥轮换应先停发布、排空任务并等最后一次发布的24小时结果窗口结束，再确认过期材料清理完成后协调切换所有 Server。当前实现没有多密钥解密环，直接换钥会使窗口内旧密文不能取回；不得因此自动生成新项目密码。遗失密钥时保持已有内容读取权限，向发布者说明旧结果不可恢复，由发布者明确选择重新生成密码。

**回退约束：启用过密码模式后，禁止回退至不识别访问模式的旧应用。** 不允许把 `access_mode` 改回默认、清空哈希/版本、删除密码凭证或丢弃新表来迁就旧版本。可以在暂停发布并核实 migration兼容的前提下，切回已验证的同样支持密码模式的镜像组合；没有这种版本时停止应用并保持代理失败关闭，待修复后恢复兼容版本。恢复后必须验证旧有效凭证仍按项目授权、匿名请求仍进密码页、已关闭/重置/删除的旧凭证仍被拒绝。

本地协调验收命令（Node.js24、已构建 Server/Worker、Docker Desktop；必须独占55432/59000/55100/55443）：

```sh
PHASE10_DATABASE_URL=postgres://password_test:local-password-test-only@127.0.0.1:55432/html_share_password \
PHASE10_MINIO_ENDPOINT=http://127.0.0.1:59000 \
node scripts/password-proxy-smoke.mjs --exclusive-window
```

脚本要求本地已有固定版本 `caddy:2.11.4-alpine` 和 `ghcr.io/neomantra/openresty:1.31.1.1-1-alpine`，不隐式拉取镜像或接入生产。它真实读取 `deploy/Caddyfile` 和 `deploy/1panel/demo.locations.conf`，仅替换隔离上游与站点Host；OpenResty外层提供临时TLS站点和不记录请求体/头/query的访问日志。Caddy使用本地自动证书；客户端仅信任本次临时证书。输出包含镜像版本/ID、原始及有效配置SHA-256、断言数和零正文回源指标，不含密码/凭证。结束时清理本次容器、临时证书目录、fixture租户和Bucket，保留终端采集的脱敏证据。

脚本的回退演练是**停止应用入口 → 代理502/503且没有文件正文 → 数据库访问字段原样保留 → 恢复同一密码兼容应用 → 重验匿名拒绝与旧凭证有效**。它不证明任意历史镜像兼容，也不替代真实备份恢复。迁移前后旧数据及清理边界另由 `node scripts/password-access-migration-smoke.mjs` 在独立临时数据库验证。正式回退时仍需在隔离恢复库先演练实际目标镜像，并检查旧组织访问与已失效密码访问。

若官方OpenResty镜像下载不可用，可以运行 `node scripts/password-proxy-nginx-image.mjs`，从本地 `node:24-alpine` 在专属容器安装官方Alpine `nginx` 软件包。脚本保存实际基础镜像ID、包版本与结果镜像ID，并清理构建容器；随后在同一独占环境追加 `--proxy=nginx` 运行验收。此模式仍加载原1Panel location片段，但结果明确标记 `nginx-compatibility-only`，只证明Nginx配置与应用协议兼容，不能替代OpenResty运行时或1Panel面板验收。测试后执行 `docker image rm html-share-password-proxy-nginx:phase13` 清理本次临时镜像，不删除原有基础镜像。独立Caddy可用 `--proxy=caddy` 重验。软件包来源见[Alpine官方Nginx说明](https://wiki.alpinelinux.org/wiki/Nginx)，代理指令见[Nginx官方文档](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)。

2026-09-10本地实测状态：Caddy 2.11.4 使用原 `deploy/Caddyfile`，58项断言通过；Nginx 1.30.4（Alpine包1.30.4-r1）使用原 `deploy/1panel/demo.locations.conf`，58项兼容验证断言通过。两者均验证了HTTPS密码GET/POST、Origin、Cookie、准确回跳、文件读取、内容域管理接口拒绝及停止服务后权限保留。OpenResty官方镜像下载遇到TLS/EOF失败，**OpenResty运行时未验收，1Panel面板及生产环境未验收**。不能把Nginx兼容验证记成后两者通过。

即使本地OpenResty容器验证通过，也只证明随仓库提供的1Panel location片段可用；正式1Panel面板生成的server块、TLS证书、WAF、端口/网络、钉钉白名单和真实用户操作须另存人工记录，不能标成生产验收通过。镜像来源与固定tag规则见[OpenResty官方Docker仓库](https://github.com/openresty/docker-openresty)，当前版本见[官方下载页](https://openresty.org/en/download.html)；Caddy本地证书行为见[Automatic HTTPS](https://caddyserver.com/docs/automatic-https)。

## V1.5 项目密码常显：密钥、升级与回退

V1.5 在 V1.4 哈希之外为项目增加长期认证密文，使创建者能在本人详情持续查看当前密码。`PASSWORD_MANAGEMENT_ENCRYPTION_KEY` 只供 Server 使用，必须是 32 字节安全随机数的规范 Base64，并与 `PASSWORD_RESULT_ENCRYPTION_KEY` 不同。所有 Server 实例必须使用同一值；不能把它注入 Worker、Web、`NEXT_PUBLIC_*`、镜像构建参数或日志。用密钥系统直接生成并保存；如只能在部署机生成，应把输出直接写入权限为 600 的受控 Secret 文件，不在 shell 历史或聊天中回显。

升级按以下顺序执行：

1. 备份 PostgreSQL、私有 Bucket、`PASSWORD_RESULT_ENCRYPTION_KEY` 和新的 `PASSWORD_MANAGEMENT_ENCRYPTION_KEY`，把备份版本与应用镜像标签记录在同一恢复清单。只恢复数据库而丢失管理密钥会使密码详情不可读。
2. 暂停 `/mcp` 新写入，排空 `PREPARED`/`PROCESSING` 任务并停止 Worker。先确认 V1.4 migration `20260909000000_password_access` 已应用，再执行 `20260910000000_project_password_management`；只用 `prisma migrate deploy`，不使用 `db push` 或 `reset`。
3. 向全部新版 Server 注入相同的两个独立密钥，先启动一个实例验证健康和本人详情，再整体替换 Server/Web/Worker。升级窗口不混用不认识 `encrypted_password` 的旧 Server 写入。
4. 抽样验证组织项目仍为组织访问；V1.4 历史密码项目仍接受原密码，详情明确显示“历史密码不可显示”；只有生成新密码前不得自动改模式、哈希或版本。创建者明确重新生成后，详情进入常显，新密码生效且旧密码和旧 grant 失效。
5. 验证 Skill 未传密码选项的新建仍为组织访问；管理端开启、重新生成、关闭均不改变 revision、文件和准确链接；列表、内容域、MCP、管理员入口与日志不返回项目密码或密文。

项目管理密文使用项目 UUID、owner UUID 和密码版本作为认证上下文，不能跨项目复制。内容访问继续只验证 scrypt 哈希，因此管理密钥错误或密文损坏时，已有密码内容访问仍按当前哈希工作；本人详情返回受控 503，且不修改模式、哈希或版本。先恢复正确密钥；无法恢复时，由创建者明确选择重新生成，不能由系统静默替换。

当前实现只有单管理密钥，没有多密钥解密环或自动重加密任务。轮换前必须暂停密码管理和发布写入，备份数据库与旧密钥，在隔离恢复库实现并验证逐项目认证重加密，确认全部密文可由新密钥读取后，才同时切换所有 Server 并移除旧密钥。直接替换环境变量会使现有项目密码详情失败，不能作为轮换方案。

应用回退只允许切回同时理解 V1.4 访问字段和 V1.5 可空项目密文的已验证镜像。migration 为 expand-first，不要求回滚列；禁止为兼容旧镜像清空 `encrypted_password`、`password_hash`、版本或 grant。没有兼容镜像时保持写入口关闭并修复新版。恢复后必须复验组织项目、历史密码、可恢复密码、旧 grant 失效和删除后的 404。

本地隔离复验使用 Node.js 24、PostgreSQL 55432 和 MinIO 59000：

```sh
pnpm smoke:password-management:migration
pnpm smoke:password-management
pnpm smoke:password-security
```

第一个命令验证 V1.4 数据升级与 migration 重复执行；第二个用真实 PostgreSQL、MinIO、Server、Worker、production Web、Chromium 和 WebKit 执行完整管理生命周期；第三个验证运行日志不含明文、项目密文或两个运行密钥。这些本地证据不替代真实钉钉、OSS、1Panel/OpenResty、正式域名或目标浏览器实机验收。

## 监控与告警

- `/health/live` 用于存活检查；`/health/metrics` 仅通过内部监控网络采集。关注请求总数、失败数、最大/累计耗时，Worker 的 `/health/metrics` 关注清理队列 `pending`、`retrying`、`running`，并持续确认 `objectStorage.getObjectCalls=0`、`objectStorage.bodyBytesRead=0`。同时对 `worker.orphan_sweep.status.retry` 连续出现或超过一小时没有 `completed` 设置告警。
- 对授权、MCP、上传、发布切换、内容读取和清理失败率，以及清理积压持续增长设置告警。告警 payload 只能包含 `trace_id`、动作、结果和计数，不包含请求正文。
- 排障用 `x-trace-id` 串联网关、服务和审计记录；用户提供的 trace id 只接受 1–64 位安全字符，否则服务生成新值。

## 本地钉钉四端联调

默认模拟器开发环境直接运行 `pnpm dev`。该命令会先启动 PostgreSQL/MinIO、对已有本地数据库执行已提交的 `migrate deploy`，再构建并启动 Server/Worker/Web；升级代码后不会让新应用在旧表结构上运行。迁移失败时应用容器不会继续重建，禁止用 `db push` 或 reset 绕过失败。

钉钉模拟器仍是默认开发方式；需要验证真实 `dd.requestAuthCode`、授权码换 Token 和用户身份查询时，使用钉钉官方的[微应用四端调试工具（网页版）](https://open.dingtalk.com/document/resourcedownload/micro-application-four-terminal-debugging-tool-web-edition)运行下列 live 配置。`requestAuthCode` 的参数和端能力以[钉钉 JSAPI Explorer](https://open.dingtalk.com/tools/explorer/jsapi?id=11723)为准。

联调前必须在钉钉开发者后台进入当前应用的“权限管理 → 个人权限”，申请并开通“通讯录个人信息读权限（`Contact.User.Read`）”。外部浏览器授权会请求 `openid Contact.User.Read`；未开通该权限时，授权码仍可能成功换取用户 Token，但 `/v1.0/contact/users/me` 会返回 403。仅登录不需要申请个人手机号权限；只有业务确实读取手机号时才申请 `Contact.User.mobile`。

1. 复制本地配置。`.env.dingtalk.local` 已被 `.gitignore` 的 `.env.*` 规则排除，禁止提交：

   ```sh
   cp .env.example .env.dingtalk.local
   ```

2. 只在 `.env.dingtalk.local` 中修改下列项。Client Secret 必须使用轮换后的新值；不要把真实值粘贴到命令、日志、截图或聊天中：

   ```dotenv
   DINGTALK_AUTH_MODE=live
   DINGTALK_CLIENT_ID=<your-client-id>
   DINGTALK_CLIENT_SECRET=
   DINGTALK_CORP_ID=<your-corp-id>
   NEXT_PUBLIC_DINGTALK_CLIENT_ID=<your-client-id>
   NEXT_PUBLIC_DINGTALK_CORP_ID=<your-corp-id>
   ```

   桌面网页版调试工具与服务在同一台 Mac 上运行时，保留示例中的 `app.localhost` / `demo.localhost` 地址即可。真机不能把 `localhost` 当作开发机；真机联调必须换成设备可达的 HTTPS 域名或受控隧道，同时同步更新 `NEXT_PUBLIC_APP_URL`、`NEXT_PUBLIC_API_URL`、`NEXT_PUBLIC_DEMO_URL`、`APP_HOST`、`DEMO_HOST`、`APP_AUTH_URL`、`DEMO_AUTH_URL`、`APP_WEB_URL`、`DEMO_WEB_URL` 和钉钉应用回调白名单。

3. 升级已有本地环境时，先检查 `.env.dingtalk.local` 是否同时包含 `PASSWORD_RESULT_ENCRYPTION_KEY` 和独立的 `PASSWORD_MANAGEMENT_ENCRYPTION_KEY`。旧配置不会随 `.env.example` 自动更新；缺失、格式错误或两者相同都会导致 Server 报 `EnvironmentValidationError` 并退出。按本文密码访问与 V1.5 升级章节生成并保存密钥，已有密钥必须保留，不能每次启动重新生成。不要重新复制示例覆盖已有钉钉配置。

   启动基础设施后，备份本地数据库，使用同一 live 配置执行已提交的迁移，再启动应用（Node.js 24）：

   ```sh
   pnpm infra:up
   node --env-file=.env.dingtalk.local ./node_modules/prisma/build/index.js migrate deploy
   pnpm db:generate
   pnpm dev:dingtalk
   ```

4. 在四端调试工具中选择与 `DINGTALK_CORP_ID` 一致的组织，管理端入口填写 `http://app.localhost:3000/login`。验证 Demo 内容时填写一个已发布的完整地址，例如 `http://demo.localhost:3001/<project-key>/<file.html>`。浏览器开发者工具 Console 过滤 `[html-share:dingtalk-auth]`，终端过滤 `"action":"dingtalk_authorization"`。

   浏览器日志依次显示 `start_request`、`auth_code_request`、`complete_request`；服务端日志显示 `internal_start_created`、`callback_received`、`token_exchange`、`identity_lookup`、`identity_resolved`、`session_created`。每条服务端日志都有 `trace_id`。失败项只带阶段、结果、HTTP 状态、本系统错误类别和失败类型；上游响应中的原始 `code` 字段也不会进入日志，避免它夹带授权码或其他凭据。

5. 生产容器查看同类日志：

   ```sh
   sudo docker logs -f html-share-server-1 2>&1 | grep --line-buffered '"action":"dingtalk_authorization"'
   ```

   `token_exchange` 失败表示授权码换用户 Token 阶段失败；`identity_lookup` 失败表示 Token 已换取、但查询当前用户失败；二者都成功而 `session_validation` 失败，才是本系统 state/会话校验问题。钉钉当前用户接口不返回“当前选中组织名称”，因此日志不能凭空打印组织名称；它会打印足够的上游阶段和错误码，用来判断是否是应用、组织、权限或授权码问题。

## 备份、恢复与回滚

1. 每日备份 PostgreSQL 并启用对象存储版本/跨区备份策略；恢复演练必须在隔离环境、隔离 Bucket 进行。
2. 恢复演练：从备份还原隔离数据库与对象，再运行 `pnpm db:migrate:deploy`，核对项目元数据、一个已授权内容读取、删除后 404 与清理队列。不要在生产执行 schema push 或破坏性迁移。
3. 原子覆盖的数据库回归必须在隔离 PostgreSQL 中显式提供 `PHASE9_DATABASE_URL` 后运行 `pnpm test:phase9:atomic`。该用例会在 revision 切换处触发唯一约束失败，并验证此前文件写入、revision 更新、旧 revision 指针、任务与配额状态全部回滚；普通 CI 未提供此变量时会跳过，不可把跳过视为通过。
4. 镜像回滚只允许回到已验证镜像标签；先暂停 `worker`，确认目标版本 migration 兼容后替换 `server`、`web`、`worker`，恢复 worker 并检查健康与积压。数据库 migration 不自动回滚。

## 凭证轮换和应急删除

- 钉钉 Secret、数据库密码、OSS 访问密钥、`AUTH_STATE_SECRET`、`MCP_TOKEN_HASH_SECRET` 和两个密码加密密钥通过密钥系统管理；项目密码管理密钥按 V1.5 章节先重加密再轮换，会话签名密钥轮换会使旧会话失效，提前通知用户。
- 管理员应急删除必须在管理端按准确项目标识查询、填写合规原因，再确认删除。操作人、项目、原因、IP、trace_id 与结果进入审计。禁止按名称模糊搜索或批量删除。

## 发布验收矩阵

| 场景              | 自动化证据                                    | 仍需人工证据                                              |
| ----------------- | --------------------------------------------- | --------------------------------------------------------- |
| Chromium / WebKit | Playwright 或同等自动化登录、发布、访问、删除 | Chrome、Edge、Safari 最近两个版本截图与版本号             |
| 钉钉              | 模拟器授权与准确回跳测试                      | 当前 iOS/Android 内置浏览器，各一台真机的授权和原路径回跳 |
| 容量              | 单次 100 并发读取、单次 10 并发完整上传       | 企业网络下 60 秒发布链路记录                              |
| 安全              | 单元/集成安全测试、依赖/Secret/镜像扫描       | 正式域名、回调白名单、轮换 Secret 和管理员名单已配置证明  |

没有上述生产域名、钉钉配置和真机时，发布只可判定为“部署就绪”，不得宣称真实钉钉生产验收通过。

## 浏览器与真机验收记录

开始前必须确认正式 `APP_HOST`、`DEMO_HOST` 均为 HTTPS；两个回调域已加入钉钉应用白名单；轮换后的 Client Secret、管理员名单仅由密钥系统注入。不要把 Cookie、Token、授权码、设备标识或截图中的个人信息写入此仓库。

对 Chrome、Edge、Safari 的最近两个大版本，以及当前钉钉 iOS/Android 内置浏览器，各开一个全新会话执行下列步骤并保存脱敏截图或录像到受控验收库：

1. 从准确 Demo 文件 URL 打开内容域，完成对应的钉钉授权；记录浏览器名称、完整版本、操作系统/设备型号、日期和测试人。
2. 确认回跳仍是最初的精确文件路径，页面正文与发布版本一致；未授权会话不能读取该文件。
3. 在管理域完成一次登录、MCP 发布、已有项目覆盖与删除；覆盖过程中旧版本持续可读，完成后才切换到新正文，删除后准确路径为 404。
4. 记录每项的通过/失败、`x-trace-id`（若需排障）和缺陷链接；只保存版本号与脱敏证据，不记录凭证或正文。

本地基线由 Playwright 覆盖。以隔离的、虚构凭据的 production Compose 启动 Caddy HTTPS 与钉钉模拟器后，执行下列命令；它会在 Chromium 和 WebKit 中分别验证管理域登录、会话读取、一次性 Token 的创建与吊销，以及内容域回跳到精确路径后的 404。测试使用 `ignoreHTTPSErrors` 仅接受该临时 Caddy 证书，不能用于正式验收或绕过正式证书问题。

```sh
HTML_SHARE_APP_URL=https://app.localhost \
HTML_SHARE_APP_WEB_URL=https://app.localhost \
HTML_SHARE_DEMO_URL=https://demo.localhost \
pnpm test:browser:local
```

2026-09-04 的隔离 HTTPS 实跑为 Chromium、WebKit 共 2/2 通过。它验证浏览器安全 Cookie、管理端会话读取与精确路径回跳；该场景中管理前端和 API 同源。管理端跨域会话读取仅由可信/攻击 Origin 的服务器回归测试覆盖，仍不替代下表的真实钉钉、Chrome/Edge/Safari 多版本或真机结果。

| 环境         | 浏览器/设备和版本 | 登录与精确回跳 | 发布/覆盖/删除 | 证据位置   | 结果/测试人/日期 |
| ------------ | ----------------- | -------------- | -------------- | ---------- | ---------------- |
| Chrome       | 待填写            | 待执行         | 待执行         | 受控验收库 | 待填写           |
| Edge         | 待填写            | 待执行         | 待执行         | 受控验收库 | 待填写           |
| Safari       | 待填写            | 待执行         | 待执行         | 受控验收库 | 待填写           |
| 钉钉 iOS     | 待填写            | 待执行         | 待执行         | 受控验收库 | 待填写           |
| 钉钉 Android | 待填写            | 待执行         | 待执行         | 受控验收库 | 待填写           |

当前唯一外部前置是正式域名和钉钉白名单、已轮换的密钥与管理员名单、可用的上述浏览器/真机，以及获授权的外部镜像 CVE 扫描。所有项具备后，按本节重新执行并把结果填入受控验收库；未填记录不得将真实浏览器兼容性标为通过。

## 容量脚本用法

读取压测用同一有效内容会话发起 100 个一次性并发请求，低于 600/min 会话与 1200/min IP 限制：

```sh
BASE_URL=https://demo.example.com DEMO_HOST=demo.example.com DEMO_COOKIE='html_share_demo_session=...' DEMO_PATH=/abc12/index.html k6 run tests/load/demo-read.js
```

上传压测用一个有效 MCP Token 同时执行 10 个独立的 `prepare_demo_upload files[] → 每文件精确预签名 PUT → complete_demo_upload → 有界状态轮询 → 已授权读取` 流程。每个任务至多再做 3 次状态查询，因此最多 50 次 MCP 调用/分钟，低于默认的 60/min；准备请求刚好 10/min。脚本会在完成通知前断言新项目仍返回 404，在最终 `completed` 后断言目标 HTML 返回 200，并以 `upload_processing_e2e_ms` 的 P95 < 5 秒验收从完成通知到原子发布可读的端到端耗时。`MCP_PREPARE_PAYLOAD_TEMPLATE` 必须是完整、可单独通过校验的 JSON-RPC 请求，包含稳定排序的 `files[]`、匹配的 `manifest_digest` 和 `__CLIENT_REQUEST_ID__` 占位符。`UPLOAD_SOURCE_MAP_PATH` 指向仅在本机读取的 JSON 对象，键是清单 `relative_path`，值是对应原文件绝对路径；映射必须与清单一一对应。文件正文只由 k6 直接 PUT 到各自签名 URL，不进入 MCP 或应用节点。

生产 Compose 默认把 `UPLOAD_FINALIZATION_CONCURRENCY` 设为 10、`UPLOAD_HEAD_OBJECT_TIMEOUT_MS` 设为 10000，并为 Worker 配置 2 CPU、2 GiB 内存。Worker 同时 claim 十个任务后只执行逐对象 HeadObject 元数据核验和数据库原子激活；每个 HEAD 都有应用层 deadline，MinIO 同时接收取消信号，OSS SDK 同时接收请求超时。发布链路不下载、缓存、解包或二次上传正文，也不依赖 `/tmp` 暂存发布文件。不要在未同步降低并发度、资源配额或压测目标的情况下改变这个组合。

签名 URL 在过期前已被对象存储接受的慢速 PUT，可能在 URL 到期后才完成。失败上传的精确对象键会在 URL 到期加 1 分钟后先清理一次；其任务、UploadFile 与 PENDING 项目保留到 24 小时幂等窗口结束，再删除元数据。Worker 还通过唯一一条 `object_sweep_states` 游标，每小时分页列举 `projects/`，只把不存在于 `FileObject` 或 `UploadFile` 的键判定为孤儿并删除。它不建立每任务永久 tombstone，不下载正文，也不会让失败任务数量线性增加常驻调度作业。对象键使用不可复用的 project/revision UUID，5 位公开 projectKey 只用于访问 URL；即使短码复用，极晚到的旧 PUT 也无法覆盖新项目对象。

```sh
MCP_ENDPOINT=https://app.example.com/mcp APP_HOST=app.example.com MCP_TOKEN='...' DEMO_BASE_URL=https://demo.example.com DEMO_HOST=demo.example.com DEMO_COOKIE='html_share_demo_session=...' UPLOAD_SOURCE_MAP_PATH=/secure/fixture/sources.json MCP_PREPARE_PAYLOAD_TEMPLATE='{"id":"prepare","jsonrpc":"2.0","method":"tools/call","params":{"name":"prepare_demo_upload","arguments":{"action":"create","client_request_id":"__CLIENT_REQUEST_ID__","display_name":"Load fixture","files":[{"content_md5":"ndTkYSaMgDT1yFZOFVxnpg==","mime_type":"text/html; charset=utf-8","relative_path":"index.html","sha256":"2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881","size":1}],"manifest_digest":"a176d969bfa6781098b37917cb37747d6e0b5b3f6468b8f6ee5fc723ba85f928","target_html":"index.html"}}}' k6 run tests/load/upload.js
```

上例中的 `sources.json` 形如 `{"index.html":"/secure/fixture/index.html"}`；示例摘要对应正文恰好为单字节 `x` 的文件，只用于说明字段，实跑前必须按实际原文件重新计算每项 SHA-256、Content-MD5、大小及规范化清单摘要。

本地演练可运行下列脚本。它只向本机 HTML Share 开发栈创建一次性 MCP Token 和临时逐文件 fixture，不会把 Token、Cookie 或文件正文交给第三方容器；脚本在退出前撤销 Token、删除 fixture，并输出不含凭证的十个上传成功数、发布前 404、发布后 200 与 P95。该脚本仍会在本地数据库留下十个已发布的容量样本，演练完成后可按普通项目删除流程清理。

```sh
pnpm load:phase9:upload:local
```

## PostgreSQL / MySQL 配置基础能力

双客户端、独立迁移、TLS 与连接工具见 [数据库配置基础能力](database-phase24.md)。Phase 25 已接入两库业务仓储与启动前就绪检查，运行步骤、事务规则和强制双库契约入口见 [双数据库业务指南](database-phase25.md)，本地证据见 [验收记录](database-phase25-validation.md)。默认 Compose 仍使用 PostgreSQL；双库部署拓扑、固定镜像与一致性门禁在 Phase 26 交付。修改 env 不会搬迁存量数据。
