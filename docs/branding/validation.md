# demo share 品牌更新验收

日期：2026-11-07。范围为展示名称与生成 Logo，不涉及业务规则、库迁移或线上部署。

## 四步验证

- Code Review：首轮静态审查未发现功能、兼容和安全问题；Logo色值约定已澄清为以生图原稿为准，应用主色不变；fresh最终独立复审 **Stage 1 PASS / Stage 2 PASS**，无未关闭 HIGH/MEDIUM；复审亲自核验ZIP逐文件一致性、浏览器原始日志与三张实际截图。
- 测试完整性：Node24 `node node_modules/vitest/vitest.mjs run` 返回 **94 files passed / 739 tests passed / 170 skipped**；跳过的27个文件为原配置需独立数据库/对象存储的集成测试，本次未启动这些环境，不声称通过。原沙箱内8项端口监听失败在获准沙箱外运行后全部通过。
- 编译：`pnpm --config.manage-package-manager-versions=false --config.verify-deps-before-run=false build` 成功，Web `Compiled successfully`；同样配置的 `typecheck` 所有9个包通过；`exec eslint . --max-warnings 0` 退出0。根工作区改名触发本地pnpm已安装元数据检查，验收使用上述临时选项避免重装共享依赖，不改项目依赖配置。
- 功能：隔离前端端口53127，全部业务API为合成拦截、不写现有数据库。Chromium/WebKit的既有7个管理端测试文件共 **122 passed (15.4s)**，覆盖列表、详情、首页、分享、密码管理、安装指引与广场。

## 品牌真实页面检查

临时浏览器检查 `/login` 与 `/demos`，1440/375px × Chromium/WebKit 共 **8/8通过**。检查页面标题、真实可读名称、Logo加载、28px尺寸、无旧品牌、图标200与PNG类型、主页链接和导航选中。全部页面 `scrollWidth === viewport`，品牌未截断，见 `brand-check.json`。

实际截图：`preview-desktop.png`、`preview-mobile.png`、`preview-login-mobile.png`。主Agent已逐张查看，Logo在28px下可辨认，文字和页签无重叠。

## 分发与兼容

`node skills/build-distributions.mjs` 成功，两个ZIP逐文件与源Skill对比一致；定向 Skill测试11/11通过。Dockerfile继续完整复制public，新图片与ZIP随Web镜像交付。连接名、安装路径、环境变量、Cookie、数据库和服务部署标识保持兼容。

本轮没有更新现有3000端口服务、推送或部署。新界面在独立本地预览中验证。
