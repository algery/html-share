# 项目广场封面验证

## 本地复验

使用现有环境变量文件和基础 Compose 文件，叠加 `compose.square-cover.yaml`。
渲染器与 Worker 之间只共享 Unix socket。首次部署后，Worker 会补齐已有共享
项目的封面。广场列表仍可在封面生成期间使用。

```bash
docker compose -f compose.mysql.yaml -f compose.square-cover.yaml up -d --build
docker compose -f compose.mysql.yaml -f compose.square-cover.yaml \
  exec -T square-cover-renderer node --input-type=module < scripts/square-cover-smoke.mjs
```

将 `compose.mysql.yaml` 换成 `compose.yaml` 可使用 PostgreSQL。目标环境
需要支持非特权用户命名空间。Chromium 启动时始终开启沙箱。

## 预览边界

截图使用当前版本有效首页和同一版本的文件。渲染器只接收静态文件，外部和
内部网络请求均被阻断。依赖被阻断的页面显示「预览暂不可用」。判断较保守，
部分只用于统计的外部请求也可能触发占位。点击「查看内容」仍可访问当前首页，
访问权限与 Demo 原有规则一致。

## 验收入口

- 浏览器布局和状态用例位于 `tests/browser/project-square-cover.spec.ts`。
- 双库任务及权限契约位于 `scripts/database-contract-square-cover.test.mjs`，
  通过 `PHASE25_POSTGRES_URL` 和 `PHASE25_MYSQL_URL` 指向临时测试数据库。
- 真实图片获取需要管理端会话。切换版本、首页或共享设置后，旧图片链接返回
  404。已授权的图片响应为 JPEG，带 `Cache-Control: private, no-store`。
- 本地使用 MySQL 和私有 MinIO。OSS 和 R2 的适配器随测试套件验证，
  云端实机依赖独立服务凭据。

## 2026-11-07 本地结果

既有共享项目「OpenAI 介绍网页」在真实 MySQL 和 MinIO 中生成了
960×600 的 42,415 字节 JPEG。在 1440px 和 375px 浏览器中确认图片
可见并打开对应首页。匿名读图返回 401。无引用图片已由 Worker 回收。
当前本地 Mac 使用 ARM64 Alpine 无头 Chromium 镜像。仓库默认构建定义
使用官方 Playwright 镜像，两者共用相同的隔离配置和启动自检。
