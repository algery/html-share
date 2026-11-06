# 项目广场真实浏览器验证

2026-11-07 在隔离 PostgreSQL、MySQL、MinIO、实际 API 和生产构建 Web 上执行。四组组合全部通过，共 **754 个显式断言**，另含 Playwright 的元素、焦点与可见性断言。浏览器未拦截或伪造任何 API 响应；钉钉身份和目录使用合成 provider，不代表真实企业通讯录权限已验收。

| 数据库     | Chromium | WebKit |
| ---------- | -------- | ------ |
| PostgreSQL | 通过     | 通过   |
| MySQL      | 通过     | 通过   |

## 重复执行

入口为 `scripts/project-square-browser.mjs`，辅助断言位于 `scripts/project-square-browser-support.mjs`。要求 Node 24、已安装 Playwright 两种浏览器、编译后的 Server/Worker/packages、已迁移的隔离双库和本地 MinIO。数据库及 MinIO 凭据仅从私有环境文件读取，不输出值。

先让生产 Web 在 `http://127.0.0.1:55500` 启动，构建时 API 地址为 `http://127.0.0.1:55100`、内容地址为 `http://localhost:55100`。该脚本不构建 Web，也不停止外部启动的进程。API 55100 须空闲；运行时不得让其他测试同时创建待处理上传任务，以免真实 Worker 领取其他测试的任务。

本轮实际执行命令：

```sh
PATH=/tmp/html-share-square-tools/bin:$PATH node --env-file=/tmp/html-share-square/matrix.env scripts/project-square-browser.mjs
```

终态输出：`project-square-browser-ok`、`assertions: 754`，四个 provider/browser 项均 `passed`，进程退出码 `0`。截图默认写入系统临时目录的 `html-share-square`；可设置 `PHASE30_BROWSER_OUTPUT` 指定证据目录。此次 52 张截图已复制至 `/tmp/html-share-square/live-{provider}-{browser}-{name}.png`。

## 覆盖内容

- 真实 MCP 准备上传、MinIO PUT、Worker 发布三文件项目；共享默认关闭，未明确选范围时无法发布，草稿和取消确认不会提前上架。
- 实际目录 HTTP 查询：展开组织和子部门、选中父部门、删除额外子部门，按姓名搜索两位同名人员并凭部门路径区分。保存父部门 `10` 与企业人员 `005`，刷新后正确回显稳定 ID。
- `005` 被选择时尚无平台账号；首次登录后命中显式人员范围。`002` 以父部门的子部门、多部门成员身份命中；`003` 的列表、搜索计数和直接只读详情都不可见。
- 独立只读接口逐层检查响应字段白名单、`private, no-store`、当前三文件准确链接、密码不泄露。全部查看者浏览期间 **零次 `/api/projects` 本人管理接口请求**，页面没有管理按钮。
- 实际点击 Unicode 嵌套 HTML 打开新页面，经过双域会话接力展示真实对象内容。范围外成员持准确链接仍可访问，撤回共享后同一内容授权仍生效。
- 保存缩小范围后，已有查看者刷新立即清空内容，显式人员仍可见；撤回后保留上次范围，再次发布必须确认；切换全组织并确认后原范围外成员能发现。
- 1440、1065、375 px，以及 750 px 下 CSS `zoom: 2` 的 200% 阅读检查：设置、列表和只读详情无页面横向溢出；可见表格不溢出自身容器；按钮文字不挤出；目录展开/移除目标至少 40 × 40 px。200% 为 CSS 放大覆盖，不将其表述为真实浏览器工具栏缩放或钉钉真机测试。
- 键盘确认弹窗的初始焦点、Shift+Tab 圈定、Escape 取消和返回触发按钮；广场搜索空状态、清空搜索、切换每页条数以及详情文件路径搜索。
- 无未捕获页面错误，浏览器 console 不包含捕获的会话、MCP Token、加密密钥或项目密码；截图遮盖本人管理页可见密码。真实发布 Worker 保持对象正文读取为零。

## 截图抽查

已对照本人列表和广场列表，确认继承相同顶栏、workspace、表格、间距与分页视觉。另逐图查看 WebKit 的 375 px 共享设置和 200% 详情：文字/链接按容器换行，标签、按钮完整可见，管理页密码遮盖有效。

- `live-postgresql-chromium-my-demos-1440.png`
- `live-postgresql-chromium-square-1440.png`
- `live-mysql-webkit-settings-375.png`
- `live-mysql-webkit-detail-200percent.png`

每组创建独立随机 tenant 和私有 bucket；`finally` 关闭自己的浏览器、MCP 客户端、API、数据库连接并清除自己的数据与对象，四组均完成清理。截图作为验收证据保留，未保存 cookie、密码、浏览器 storageState、trace 或 API 原始响应。

目录故障/缓存过期、409 并发、覆盖/删除、跨租户与密码凭证越权由独立 HTTP/数据库/组件验证承担；本脚本不声称覆盖那些未执行的场景。真实钉钉通讯录授权、读取范围及钉钉客户端仍待外部验收。
