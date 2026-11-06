---
name: html-share
description: 将明确指定的本地静态 HTML Demo 发布到 demo share，或覆盖已有 Demo。用户说“分享这个 Demo”“发布 HTML”“更新这个 Demo 链接”时使用；先进行本地只读风险检查，有风险必须获得用户确认。
---

# demo share 发布

只发布用户明确指定的 publish_dir。确认目标 HTML、展示名称和操作：

- 新建：action=create；展示名默认目录名，其次目标 HTML 文件名。
- 覆盖：用户必须明确说“覆盖/更新”，并提供 https://demo.<domain>/<project_id>/...、项目前缀或 5 位项目标识；只接受小写字母数字 5 位 project_id。
- 不明确目录、目标 HTML 或覆盖意图时先提问；绝不猜测，不扫描工作区根目录。

## 安全门槛

运行本包内的 scripts/preflight.mjs，只读取目录。读取完整 JSON，不要把文件正文放入对话。

    node "$SKILL_DIR/scripts/preflight.mjs" --publish-dir "<目录>" --target-html "<目录内的入口.html>"

- status=blocked：列出 blocks 的编号、路径与建议，停止；不得调用 MCP 或上传，即使用户要求强制继续。
- status=confirmation_required：列出全部 risks 的编号、路径、后果与建议。仅在用户明确确认“继续发布本次全部风险”后继续，并保存本次输出的 riskAckDigest。不要接受模糊的“好/继续”。
- status=ready：无需额外确认。

风险编号和用户文案见 references/risk-catalog.md。任何重新预检得到不同的 manifestDigest 或 riskAckDigest 都表示确认失效，必须重新询问。

## 发布流程

标准路径使用一个 upload.mjs 进程完成 check_connection、逐文件清单 prepare_demo_upload、原文件精确预签名 PUT、complete_demo_upload 和最终状态查询。脚本不创建 ZIP、不复制正文到临时目录，并在每次 PUT 前复核文件快照；将 Token 仅作为本机环境变量 HTML_SHARE_MCP_TOKEN 提供，不要粘贴到对话、命令参数或项目文件。

    HTML_SHARE_MCP_TOKEN="<本机已保存的 Token>" node "<本 Skill scripts/upload.mjs 的绝对路径>" --action create --publish-dir "<目录>" --target-html "<入口.html>" --display-name "<展示名>" --mcp-url "<app_url>/mcp" --demo-url "<demo_url>"

有软风险时，加上本次预检返回的 --risk-ack-digest；覆盖时使用 --action replace --project-id "<5 位标识或原链接>"。脚本使用同一个 client_request_id 重试短时签名地址，不会创建第二个项目；只在服务端终态为 completed 时输出准确链接。

若宿主直接调用 MCP，也只能把 preflight.mjs 返回的 `files` 清单传给 prepare_demo_upload；文件正文绝不能作为 MCP 参数或聊天内容。将响应中的每个 `relative_path` 与本地预检快照精确匹配，再按 `upload_url` 和 `upload_headers` 逐个 PUT。签名地址失效或直传失败时，用同一个 client_request_id 重新调用 prepare_demo_upload；不要创建第二个项目。覆盖失败时保留旧链接并说明失败状态。旧的 `archive_size`、`file_count`、`total_size` ZIP 协议已停用。

## 链接访问方式

仅按发布者明确意图设置访问方式，项目内所有文件共用一套模式和密码：

- 新建未提密码：省略 `--access-mode`，默认组织访问；不得自行开启密码。
- 明确说“开启密码访问”：加 `--access-mode password`，密码由服务端生成。
- 覆盖未提模式：省略模式和重置参数，继承原模式、原密码。已是密码模式再次开启也沿用。
- 明确说“关闭密码访问”：覆盖时加 `--access-mode organization`。
- 明确说“重新生成密码”：覆盖时加 `--regenerate-password`；只适用于密码模式，也可同时明确开启密码。不要因密码取回失败自动重置。

示例：在标准发布命令后加 `--access-mode password`；更新并明确重新生成时使用 `--action replace --project-id "<原项目>" --access-mode password --regenerate-password`。

## 分享结果与重试

脚本只在终态 `completed` 后返回分享结果。逐项读取 `shareUrl`、`accessMode`、`passwordStatus`：

- `organization`：只展示准确链接和“组织访问”，无密码字段。
- `password` + `generated`：分别展示准确链接和响应的 `accessPassword`。必须逐字使用服务端密码，不能编造、推测或放入 URL。
- `password` + `retained`：展示准确链接和“沿用原密码”，不把空值或其他历史任务的密码当作新密码。
- `unavailable`：明确说明密码结果已超过24小时取回窗口、密码已变更或项目失效；项目仍存在且开启密码访问时，可由发布者明确要求重新生成；项目已删除则需重新创建。

密码模式的最终分享结果还须说明：“持有密码者无需钉钉组织身份即可查看该项目内容，请仅向预期查看者分享密码。”生成和沿用密码时都要展示这句说明。

失败、prepared、processing、超时或字段不完整均不宣称分享成功。旧服务不支持密码选项时明确提示升级，不移除参数降级为普通发布。

已知任务后的错误会提供 `project_id`、`upload_id` 和 `client_request_id`，保留这些标识。可只查询同一任务，不重新上传或重置：

    node "$SKILL_DIR/scripts/upload.mjs" --upload-id "<upload_id>" --project-id "<5位项目标识>" --target-html "<原目标HTML>" --mcp-url "<app_url>/mcp" --demo-url "<demo_url>"

查询仍需本机环境变量 `HTML_SHARE_MCP_TOKEN`。发布者在任务创建24小时内可取回本任务生成且仍有效的密码；取回不延长窗口。密码只作为最终分享结果输出，不保存到工作目录、调试日志、安装包或浏览器持久存储。

若 prepare 响应丢失、尚未知项目和上传任务，错误只提供真实 `client_request_id`；使用原目录、原始选项和该幂等标识重试发布命令，不生成新标识，也不改变密码选项。

## 宿主安装

当前官方目录约定：

- Codex：将本包的 html-share/ 目录安装到 ~/.codex/skills/html-share/ 后重新打开 Codex。
- Claude Code：将同一目录安装到项目 .claude/skills/html-share/ 或用户 ~/.claude/skills/html-share/。

两端 MCP 都使用 Streamable HTTP 地址 <app_url>/mcp 和自定义 Header Authorization: Bearer <Token>。Token 只放在宿主配置，不写入 SKILL、脚本、日志或项目文件。
