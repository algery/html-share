# Demo Share 品牌资产

2026-11-07 使用内置 `image_gen` 生图工具生成；原稿为 `demo-share-logo-source.png`，保留透明通道。以下发布尺寸仅做等比缩小，未改变图形或色彩：

- `apps/web/public/brand/demo-share-logo.png`：128×128，导航和登录页以28px显示。
- `apps/web/public/brand/demo-share-icon.png`：32×32，浏览器标签图标。
- `apps/web/public/brand/demo-share-apple-icon.png`：180×180，设备书签图标。
- `apps/web/public/brand/demo-share-wordmark.png`：480×160，导航和登录页以 120×40px 显示。由 [选定的透明艺术字](demo-share-wordmark-title-case.png) 等比缩小，[生成提示词](demo-share-wordmark-title-case.prompt.txt) 随原稿保存。

网站名称使用 `Demo Share`。艺术字的替代文本为 `Demo Share`，相邻方形图标的替代文本为空。技术连接与安装标识沿用 `html-share`。

原稿为生图工具的实际输出，颜色有轻微生成差异；提示词中的 `#263F72` 是视觉参考，应用控件主色仍保留该值。

## 生成提示词

Use case: logo-brand.
Asset type: production application logo mark for "demo share", a lightweight internal platform for sharing interactive web demos.
Primary request: create one refined, memorable geometric app logo, icon only with no words or letters. A clean rounded-square deep indigo tile contains a single bold white monoline symbol combining a small browser/page outline with an arrow departing toward the upper right, expressing a demo becoming a shareable link. The arrow and page should feel like one coherent symbol. Flat vector-like construction, calm professional product design, balanced optical weight and generous negative space, crisp edges.
Color palette: solid deep indigo #263F72 tile and solid white symbol only. No gradients, glow, texture, 3D, cast shadow, fine details, text, watermark, mockup or border. Square composition, mark centered and nearly filling the canvas (about 92% of width and height), transparent background outside the rounded tile. The symbol must remain recognizable at 28x28 and as a small browser favicon. Deliver a single isolated square logo, not a presentation sheet.

## 接入依据

使用 Next.js 的本地 Image 组件与 Metadata icons 配置：[Image 文档](https://nextjs.org/docs/app/api-reference/components/image)、[图标文档](https://nextjs.org/docs/app/api-reference/file-conventions/metadata/app-icons)。资产已预先缩小，组件使用 unoptimized 直接读取本地小图。
