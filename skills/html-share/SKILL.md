---
name: html-share
description: 将明确指定的本地静态 HTML Demo 发布到 HTML Share，或覆盖已有 Demo。用户说“分享这个 Demo”“发布 HTML”“更新这个 Demo 链接”时使用；先进行本地只读风险检查，有风险必须获得用户确认。
---

# HTML Share 发布

只发布用户明确指定的 publish_dir。确认目标 HTML、展示名称和操作：

- 新建：action=create；展示名默认目录名，其次目标 HTML 文件名。
- 覆盖：用户必须明确说“覆盖/更新”，并提供 https://demo.<domain>/<project_id>/...、项目前缀或 5 位项目标识；只接受小写字母数字 5 位 project_id。
- 不明确目录、目标 HTML 或覆盖意图时先提问；绝不猜测，不扫描工作区根目录。

## 安全门槛

运行本包内的 scripts/preflight.mjs，只读取目录。读取完整 JSON，不要把文件正文放入对话。

    node "$SKILL_DIR/scripts/preflight.mjs" --publish-dir "<目录>" --target-html "<目录内的入口.html>"

- status=blocked：列出 blocks 的编号、路径与建议，停止；不得调用 MCP、打包或上传，即使用户要求强制继续。
- status=confirmation_required：列出全部 risks 的编号、路径、后果与建议。仅在用户明确确认“继续发布本次全部风险”后继续，并保存本次输出的 riskAckDigest。不要接受模糊的“好/继续”。
- status=ready：无需额外确认。

风险编号和用户文案见 references/risk-catalog.md。任何重新预检得到不同的 manifestDigest 或 riskAckDigest 都表示确认失效，必须重新询问。

## 发布流程

标准路径使用一个 upload.mjs 进程完成 check_connection、prepare_demo_upload、临时 ZIP、预签名 PUT、complete_demo_upload 和最终状态查询；该进程在成功、失败或中断时均清理受标记保护的系统临时 ZIP。将 Token 仅作为本机环境变量 HTML_SHARE_MCP_TOKEN 提供，不要粘贴到对话、命令参数或项目文件。

    HTML_SHARE_MCP_TOKEN="<本机已保存的 Token>" node "<本 Skill scripts/upload.mjs 的绝对路径>" --action create --publish-dir "<目录>" --target-html "<入口.html>" --display-name "<展示名>" --mcp-url "<app_url>/mcp" --demo-url "<demo_url>"

有软风险时，加上本次预检返回的 --risk-ack-digest；覆盖时使用 --action replace --project-id "<5 位标识或原链接>"。脚本使用同一个 client_request_id 重试短时签名地址，不会创建第二个项目；只在服务端终态为 completed 时输出准确链接。

若宿主已直接连接 MCP，才能使用分步路径：先调用 check_connection 与 prepare_demo_upload，再用 package.mjs 的 archivePath 和 cleanupToken 调用 upload.mjs。文件字节绝不能作为 MCP 参数或聊天内容。

    node "<本 Skill scripts/package.mjs 的绝对路径>" --publish-dir "<目录>" --target-html "<入口.html>" --risk-ack-digest "<仅有风险时填写>"
    node "<本 Skill scripts/upload.mjs 的绝对路径>" --archive-path "<archivePath>" --cleanup-token "<cleanupToken>" --upload-url "<MCP 返回值>" --upload-headers-json '<MCP 返回 headers 的 JSON>'

分步模式若尚未执行直传便中断，重新执行 package.mjs，不得复用旧 ZIP。签名地址失效或 ZIP 直传失败时，用同一个 client_request_id 再调用 prepare_demo_upload 取得新地址；不要创建第二个项目。覆盖失败时保留旧链接并说明失败状态。

## 宿主安装

当前官方目录约定：

- Codex：将本包的 html-share/ 目录安装到 ~/.codex/skills/html-share/ 后重新打开 Codex。
- Claude Code：将同一目录安装到项目 .claude/skills/html-share/ 或用户 ~/.claude/skills/html-share/。

两端 MCP 都使用 Streamable HTTP 地址 <app_url>/mcp 和自定义 Header Authorization: Bearer <Token>。Token 只放在宿主配置，不写入 SKILL、脚本、日志或项目文件。
