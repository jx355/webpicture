# 设计文档（DESIGN）

本文档记录从需求到落地的完整推导：需求梳理 → 方案选型 → 模块设计 → 关键方法逻辑细化 → 边界处理。新增功能或重构前，建议先读第 1、2 章对齐背景。

## 1. 需求梳理

原始需求（用户提出）：

> 支持谷歌和 Edge 等浏览器内页面保存功能；保存后不依赖外部网页可以正常访问页面原样子；不会出现乱码；参考百度网页快照；注意代码规范，要有文档以及代码注释便于后期维护。

拆解为可验证的验收标准：

| # | 需求 | 验收标准 | 对应实现 |
|---|---|---|---|
| R1 | 浏览器内保存页面 | Chrome / Edge 安装即用，三种触发方式（弹窗/快捷键/右键） | MV3 扩展 + popup/commands/contextMenus |
| R2 | 保存后不依赖外部网页 | 断网打开快照文件，布局/图片/样式与原页一致 | 单文件 HTML：全部资源 data URI 内联 |
| R3 | 不出现乱码 | 中文页面（含 GBK/GB2312）保存后文字正常 | charset 四级识别 + 统一 UTF-8 输出 |
| R4 | 参考百度网页快照 | 快照顶部有标识横幅（保存时间/原始地址/差异提示） | `injectBanner` |
| R5 | 快速部署 | 无需构建工具，加载即用 | 零依赖原生 JS，无打包步骤 |
| R6 | 代码规范可维护 | 模块边界清晰、注释完整、有测试与文档 | JSDoc 全覆盖 + 25 单测 + 35 e2e + 4 份文档 |

隐含需求（实现中补充确认）：

- **不破坏用户正在浏览的页面**（保存是"旁路复制"而非"原地修改"）→ 回滚机制；
- **保存失败可诊断** → 历史记录区分成功/失败并保留错误信息；
- **Chrome 与 Edge 体验一致** → 双链路 + 自动降级。

## 2. 方案选型与决策记录

### 2.1 为什么是浏览器扩展

需求是"在浏览器内保存页面并离线查看"，只有扩展能同时做到：读取完整 DOM、以扩展特权跨域抓资源、调用浏览器下载 API。纯网页应用受同源策略限制，拿不到跨域资源。

### 2.2 为什么 Manifest V3 + 零构建

- MV3 是 Chrome Web Store 的唯一受理格式，Edge 同步支持；
- 零构建（IIFE + `importScripts`）让"加载已解压的扩展程序"成为唯一部署动作，满足 R5；纯逻辑库同时可在 Node `vm` 里单测。

### 2.3 为什么有两条保存链路

| | 链路 A：原生 MHTML | 链路 B：单文件 HTML |
|---|---|---|
| 原理 | `chrome.pageCapture.saveAsMHTML` | 采集 → SW 抓取 → 内嵌 → 序列化 |
| 可用性 | **仅 Chrome**，且需授权 | 全浏览器 |
| 保真度 | 最高（跨域 iframe、JS 执行态、滚动位置） | 高（同源 iframe 递归内嵌；跨域 iframe 留原地址） |
| 体积 | 大（MHTML 含全部原始分片） | 中（base64 膨胀约 33%） |
| 可控性 | 黑盒，无法注入横幅/base | 白盒，横幅/base/charset 均可控 |

决策：`auto` 模式优先 A（Chrome 授权用户拿到最高保真），其余情况走 B；用户显式选 MHTML 而不可用时**报错而非静默降级**（显式选择必须被尊重）。

### 2.4 为什么资源抓取放在 Service Worker

内容脚本里 `fetch` 跨域资源会被页面 CORS 拦截；SW 持有 `<all_urls>` 特权可绕开。因此 SW 是**唯一网络出口**，内容脚本只负责 DOM。附带好处：抓取缓存、并发限流、体积护栏都集中在一处。

### 2.5 为什么需要 offscreen 文档（下载链路）

MV3 服务线程**没有 `URL.createObjectURL`**（Chrome 已从 worker 全局移除），而 `data:` URL 有约 2MB 的 URL 长度上限（Chromium `url::kMaxURLSize`），内嵌大量图片的快照轻松超限。解法是 Chrome 官方模式：offscreen 隐藏文档（`reasons: ['BLOBS']`）里建 blob URL 回传 SW，SW 调 `chrome.downloads.download`，下载进入终态后再让 offscreen 回收 URL，最后关闭文档。无 offscreen API 的浏览器降级 data URI 并给出明确错误。

### 2.6 为什么采集-内嵌是"单会话"

collect 与 embed 之间隔着一次 SW 异步往返（可能要几秒）。若分两次注入，第二次拿不到第一次的 DOM 引用。因此一次注入后闭包持有全部元素引用，配套 undo 栈实现回滚。

## 3. 模块设计

```
manifest.json          入口与权限声明
src/lib/utils.js       纯逻辑：URL/文件名/charset 解码/base64/srcset/mapLimit
src/lib/css-tools.js   纯逻辑：CSS url() 与 @import 展平
src/content/           内容脚本：collect →（SW 抓取）→ embed → 注入 → 序列化 → 回滚
src/background/        SW：编排、唯一网络出口、CSS 处理、下载、历史、消息路由
src/offscreen/         SW 的 DOM 替身：仅创建/回收 blob URL
src/popup/             保存入口 UI
src/options/           快照库 + 设置
```

依赖方向：`content → background`（消息）、`background → offscreen`（消息）、`popup/options → background`（消息）+ `popup/options → chrome.storage`（直连，少一跳）。lib 被 SW 与内容脚本通过 `importScripts` / 注入共享，**不依赖 chrome API**。

## 4. 关键方法逻辑细化

### 4.1 `WSUtils.decodeText(bytes, contentType)` —— 防乱码核心

```
charset = Content-Type 声明 → BOM 嗅探 → CSS @charset 嗅探 → 'utf-8'
TextDecoder(charset, {fatal:false}).decode(bytes)
   └─ 编码名不被支持 → 回退 UTF-8（不抛异常）
```

GBK/GB2312/Big5 站点依赖前两级；全部落空按 UTF-8 兜底。输出侧统一 UTF-8 + `<meta charset="utf-8">`，消除"解码对、写出错"的第二类乱码。

### 4.2 `WSCss.flattenCssImports(css, baseUrl, fetchCssText, maxDepth, visited)`

```
展平当前 CSS 的 @import：
  对每个 @import url：
    1. 解析为绝对地址；visited 有则跳过（破循环）；
    2. depth < maxDepth(3) 时递归抓取并内联其内容；
    3. 抓取失败 → 保留原 @import 语句（降级，不丢样式）；
visited 为共享 Set，跨递归层级传递。
```

### 4.3 `WSSnapshot.collectTree(doc, url, depth, ctx)`

```
遍历 doc 全部元素，按标签分类登记：
  img            → images（有 src）/ lazyImages（无 src，取 data-* 真实地址）
  img/source     → srcsetImages（取最大候选）
  script[src]    → scripts
  link[stylesheet] → styleLinks；link[icon]/[preload] → 对应清单
  style 块       → inlineCss（文本交 SW 处理）
  style 属性     → inlineStyles（含 url( 才登记）
  iframe（同源） → iframes，depth < 1 时递归 collectTree 子文档
  audio/video/embed/object/svg image → media/objects/svgImages
所有地址经 resolveUrl 绝对化；data:/blob:/javascript: 跳过；全局 seen 去重。
```

### 4.4 `WSSnapshot.embedTree(ctx, node)` —— 内嵌改写

```
assets = ctx.assets（绝对URL → {kind, dataUri?, text?}）
  images/lazy/srcset/media/... → mutateAttr(src/href/poster, dataUri)
  lazyImages                    → 补 src 后删除已消费的 data-* 属性
  scripts                       → mutateText(escapeScriptText(text)) + 删 src
  styleLinks                    → replaceWithStyle(escapeCssText(text))
  inlineCss                     → mutateText(escapeCssText(processed))
  inlineStyles                  → mutateAttr(style, processed)（属性由序列化器转义，无需处理）
  iframes                       → 先递归 embedTree 子文档，再 serializeDoc → srcdoc
```

**内联转义铁律**：`escapeScriptText` / `escapeCssText` 把裸 `</script` / `</style` 替换为 `<\/script` / `<\/style`（保留原始大小写、可重入）。不转义的后果是序列化产物中元素被提前闭合，剩余代码漏成正文可见文本——百度首页实测踩坑（其 JS 在 27KB 处有 3 处裸 `</script>`）。

### 4.5 `WSSnapshot.injectCharset / injectBase / injectBanner`

- `injectCharset`：注入 `<meta charset="utf-8">`；**剥离原页面 CSP meta 与 refresh meta**（离线打开避免被拦截/定时跳走）；
- `injectBase`：注入 `<base href="原URL">`，相对链接离线时仍指向原站；
- `injectBanner`：body 首部插入横幅 div（样式 + 关闭按钮脚本），百度快照式样。

### 4.6 `WSSnapshot.serializeDoc(doc)` 与 `rollback(ctx)`

- 序列化用 `XMLSerializer`（保留原始大小写与属性顺序，贴近浏览器"另存为"观感）；
- 回滚按 undo 栈**逆序**执行：属性还原/删除、文本还原、`<link>` 插回原位、横幅移除。保证用户页面零侵入。

### 4.7 SW：`saveFromTab(tab, options)` —— 主编排

```
校验 tab.url（拒绝浏览器内部页）→ 合并设置 → 格式决策（auto→mhtml/html）
→ setBusy(true) → saveAsMhtml / saveAsSingleHtml
→ recordHistory(success) → notify(SAVE_DONE)
catch：recordHistory(failed, error) → notify(SAVE_ERROR)
finally：setBusy(false)
```

### 4.8 SW：`handleFetchAssets(payload)` —— 资源抓取

```
按清单并发抓取（mapLimit 6）：
  fetchWithFallback：credentials:'include' 失败 → 'omit' 重试
  缓存：'url|kind' → Promise，同 URL 只抓一次
  护栏：单资源 > maxAssetMB 跳过；总量 > 48MB 停止后续
  图片类 → dataUri；css → processCssText 展平+改写；js → 文本
行内 CSS / style 属性 → 批量 processCssText，按请求顺序返回
全部失败不致命：记 warnings，原地址保留
```

### 4.9 SW：`downloadBlob(blob, filename, askLocation)` —— 下载

```
blobToText → ensureOffscreenDocument（探测/PING握手/创建/等READY）
→ OFFSCREEN_MAKE_BLOB_URL 拿 blob: URL（失败降级 data URI）
→ chrome.downloads.download({url, filename, saveAs, conflictAction:'uniquify'})
→ 等 onChanged 到 complete/interrupted（兜底 5 分钟超时）
→ OFFSCREEN_REVOKE 回收 URL → closeOffscreenDocument
串行锁 downloadChain 防止并发保存互相打断
```

### 4.10 offscreen：`OFFSCREEN_MAKE_BLOB_URL / REVOKE / PING / READY`

```
只做三件事：URL.createObjectURL、URL.revokeObjectURL、PING 响应。
纪律：chrome.* 一律在消息回调内引用（顶层引用会抛错导致文档起不来——
offscreen 上下文只暴露 chrome.runtime，这是实测踩过的坑）。
```

## 5. 边界与异常处理矩阵

| 场景 | 行为 |
|---|---|
| 浏览器内部页（chrome:// 等） | 拒绝保存，提示不支持 |
| 内容脚本注入失败 | 提示"无法在此页面注入脚本" |
| 与页面通信失败 | 提示"请刷新页面后重试" |
| 单资源抓取失败 | 跳过 + warning，保留原地址 |
| 资源超大（>12MB 单件 / >48MB 总量） | 跳过 + warning |
| pageCapture 未授权 | auto 模式降级单文件 HTML；显式 mhtml 时报错引导授权 |
| offscreen 链路异常 | 降级 data URI；超大文件失败给明确错误 |
| 下载被取消 / 失败 | 记录 failed 历史 + 错误信息 |
| CSS `@import` 循环 | 共享 visited 打破，深度上限 3 |
| 外链 JS 含裸 `</script>` | `escapeScriptText` 转义，防元素被提前闭合 |
| GBK 资源无 charset 声明 | BOM / `@charset` 嗅探，仍失败按 UTF-8 兜底不抛异常 |
| 源站资源自身含非法字节 | 忠实还原（与浏览器解码一致），不"洗数据" |

## 6. 维护者守则

1. 改任何内联写入 DOM 的代码，先问：**文本里有没有可能提前闭合元素的序列**？有就必须过转义 helper；
2. 新增消息类型，同步三处：SW 路由、对端监听、ARCHITECTURE.md 的消息协议清单；
3. lib 目录保持"零 chrome 引用"，否则单测基建失效；
4. 真实站点回归只认 e2e 的观测点（历史记录 / `chrome.downloads.search`），磁盘文件名在测试环境不可信（见 TESTING.md 第 4 节）。
