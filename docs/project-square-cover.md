# 项目广场封面

官方 Skill 在新建或覆盖发布时截取本地有效首页。浏览器设置和安装方式见 [发布 Skill](../skills/html-share/SKILL.md)。截图随发布直传私有对象存储。上传或校验失败时，Demo 仍可发布并上架。

截图使用启用沙箱的独立 Chromium，并在浏览器中限制网页的外部请求。旧服务器容器的系统级无网络配置随旧服务退役。

上架后，广场只显示与当前内容版本和首页匹配的封面。存量项目在版本和首页仍匹配时可继续展示旧图。缺图项目显示「预览暂不可用」。重新上架可使用仍匹配的当前封面。封面链接仍根据广场可见范围逐次鉴权。

## 旧截图服务退役

1. 仍在使用截图 Compose 叠加文件的环境，升级前用原 Compose 文件及原项目名停止 `square-cover-renderer`。保留私有存储和封面数据。
2. 随应用升级运行对应 PostgreSQL 或 MySQL 迁移，然后使用原基础 Compose 文件更新 Server 与 Worker，部署配置移除旧截图叠加文件和 `SQUARE_COVER_SOCKET`。
3. 向发布者提供新版 Skill。用它上传一个带有效首页的 Demo，确认上架后显示封面。再用旧 Skill 或一个无法截图的 Demo 验证缺图占位。核对撤回后图片地址拒绝读取。
4. 确认新版 Worker 在运行后，可移除旧的 `square-cover-renderer`、`square-cover-init` 容器和专用 socket 卷。新版 Worker 会回收已经失去引用的图片对象。
