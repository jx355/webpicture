# 架构文档（ARCHITECTURE）

本文档说明"网页快照保存器"的整体架构、两条保存链路、模块职责与关键设计决策。阅读顺序建议：先看"总览图"建立全局印象，再按需要深入各模块。

## 1. 总览

```
┌─────────────────────────────────────────────────────────────────────┐
│ 用户触发：弹窗按钮 / Alt+S / 右键菜单                                  │
└──────────────┬──────────────────────────────────┬───────────────────┘
               │                                  │
               ▼                                  ▼
┌──────────────────────────┐        ┌──────────────────────────────┐
│ 链路 A：原生 MHTML         │        │ 链路 B：单文件 HTML（默认）    │
│ （仅 Chrome，需授权）       │        │ （全浏览器可用）               │
│                           │        │                              │
│ pageCapture.saveAsMHTML   │        │ ① 注入内容脚本（executeScript）│
│   → Blob                  │        │ ② CS_COLLECT：DOM 采集        │
│   → 下载                  │        │ ③ CS_FETCH_ASSETS：SW 抓资源  │
│                           │        │ ④ 内嵌改写 DOM                │
│ 保真度最高：               │        │ ⑤ 注入横幅/base/charset       │
│  - 保留跨域 iframe         │        │ ⑥ 序列化为完整 HTML           │
│  - 保留 JS 执行态          │        │ ⑦ 逆序回滚 DOM（零侵入）      │
└──────────────┬────────────┘        └──────────────┬───────────────┘
               │                                    │
               └──────────────┬─────────────────────┘
                              ▼
                  ┌───────────────────────┐
                  │ downloadBlob（SW）     │
                  │  ↓ offscreen 文档      │
                  │  URL.createObjectURL   │
                  │  ↓ 回传 blob: URL      │
                  │  chrome.downloads      │
                  │  ↓ 下载完成            │
                  │  回收 URL + 关闭文档   │
                  └───────────┬───────────┘
                              ▼
                  ┌───────────────────────┐
                  │ recordHistory（SW）    │
                  │ chrome.storage.local   │
                  └───────────────────────┘
```

格式决策（`saveFromTab`）：设置 `format=auto` 时，若 `chrome.pageCapture` 存在且已授权 → 链路 A，否则 → 链路 B；链路 A 的任何失败都会在历史里记录，不会静默降级（用户明确选了 MHTML 时才报错提示）。

## 2. 模块职责边界

| 模块 | 文件 | 职责 | 明确不做的事 |
|---|---|---|---|
| 纯逻辑库 | `src/lib/utils.js` | URL 解析、文件名清洗、**charset 解码**、base64/data URI、srcset 解析、并发控制 `mapLimit` | 不碰 `chrome.*`、不碰 DOM（保证可在 Node `vm` 中单测） |
| 纯逻辑库 | `src/lib/css-tools.js` | CSS `url()` 提取/改写、`@import` 递归展平（深度 3 + 共享 visited 防循环） | 同上 |
| 内容脚本 | `src/content/snapshot-content.js` | DOM 采集（collect）、内嵌改写（embed）、charset/base/横幅注入、序列化、**逆序回滚** | 不自己发网络请求（资源统一由 SW 抓，绕开 CORS） |
| Service Worker | `src/background/service-worker.js` | 保存编排、**唯一网络出口**、CSS 处理、下载、历史记录、消息路由 | 不做界面 |
| offscreen 文档 | `src/offscreen/offscreen.{html,js}` | 仅为 SW 提供 `URL.createObjectURL` / `revokeObjectURL` | **不调用 `chrome.downloads`**（offscreen 上下文只暴露 `chrome.runtime`，强行调用会在顶层抛错导致文档起不来） |
| 弹窗 | `src/popup/*` | 保存入口、格式选择、进度展示、最近 3 条记录 | 不含业务逻辑 |
| 快照库 | `src/options/*` | 设置表单、历史表格（搜索/重存/删除/导出） | 不含业务逻辑 |

## 3. 链路 B 详细流程（单文件 HTML）

链路 B 是默认路径，分七个步骤，横跨"内容脚本 ↔ SW"两个上下文：

### 3.1 注入（SW → 页面）

`chrome.scripting.executeScript` 按顺序注入三个文件到页面的隔离世界（isolated world）：

```
src/lib/utils.js → src/lib/css-tools.js → src/content/snapshot-content.js
```

后两个依赖第一个的全局 `WSUtils`，顺序不能换。内容脚本末尾有 `__wsContentBooted` 守卫，重复注入不会注册第二个消息监听（避免一次采集收到两份响应）。

### 3.2 采集 collect（内容脚本）

`collectTree(doc, url, depth, ctx)` 递归遍历 DOM（同源 iframe 向下递归 1 层），把需要处理的元素分类登记：

| 类别 | 处理方式 |
|---|---|
| `images`（有 src 的 img） | SW 抓取 → data URI |
| `lazyImages`（无 src，只有 `data-src` 等懒加载属性） | 抓真实地址 → 补 `src`、**删掉已消费的懒加载属性** |
| `srcsetImages` | 取最大候选地址抓取 |
| `scripts`（外链） | SW 抓取 → 内联为 `textContent` |
| `styleLinks`（外链样式表） | SW 抓取并展平 `@import`、改写 `url()` → `<style>` |
| `inlineCss` / `inlineStyles` | 文本交给 SW 做同样的 CSS 处理 |
| `iframes`（同源） | 递归序列化为 `srcdoc` |
| `media` / `objects` / `svgImages` / `iconLinks` / `preloadLinks` | 同类处理 |

相对地址一律用 `WSUtils.resolveUrl(documentURL, attr)` 解析为绝对地址；`data:`、`blob:`、`javascript:` 等协议跳过。

### 3.3 抓取（内容脚本 → SW → 网络）

内容脚本把资源清单（`{url, kind}` 数组）通过 `CS_FETCH_ASSETS` 发给 SW。SW 是**唯一网络出口**，因为扩展上下文持有 `<all_urls>` 特权，`fetch` 不受页面 CORS 限制：

- `fetchWithFallback`：先 `credentials:'include'`（带 Cookie，应对需登录资源），失败再 `omit` 重试；
- 抓取缓存：`'url|kind' -> Promise`，同 URL 只抓一次；
- 体积护栏：单资源超 `maxAssetMB`（默认 12MB）跳过，总量超 `MAX_TOTAL_BYTES`（48MB）停止后续抓取，全部记入 `warnings`；
- 并发控制：`WSUtils.mapLimit(items, 6, worker)` 保序 + 限流 + 失败隔离（单个资源失败不影响其他）。

### 3.4 CSS 处理（SW）

`processCssText(cssText, baseUrl, ctx, depth, visited)`：

1. `flattenCssImports` 递归拉平 `@import`（深度上限 3，共享 visited 集合打破循环；抓取失败保留原 `@import` 语句降级）；
2. `rewriteCssUrls` 把 CSS 里的 `url()` 替换为 data URI（图片/字体），失败保留原地址。

### 3.5 内嵌 embed（内容脚本）

拿回 SW 的资源表后，`embedTree` 在 DOM 上做改写。**所有改写都经过 `mutateAttr` / `mutateText` / `replaceWithStyle` 记录到 undo 栈**，这是 3.7 步回滚的依据。

### 3.6 注入与序列化

- `injectCharset`：注入 `<meta charset="utf-8">`；**同时剥离原页面的 CSP meta 与刷新跳转 meta**（离线打开时避免被策略拦截或定时跳走）；
- `injectBase`：按设置注入 `<base href="原页面URL">`，让快照里的相对链接离线时仍指向原站；
- `injectBanner`：注入百度快照式横幅（保存时间 / 原始地址 / 差异提示，可关闭）；
- `serializeDoc`：`XMLSerializer` 序列化为完整 HTML 字符串。

### 3.7 回滚（关键设计）

`finally` 中按 undo 栈**逆序**恢复所有 DOM 改写（属性、文本节点、被替换的 `<link>` 元素）。用户正在浏览的页面完全不受影响——这是内容脚本方案对比"直接改用户页面"方案的核心优势。

## 4. 防乱码设计（用户核心诉求）

三道防线，全部在 `src/lib/utils.js` 的 `decodeText`：

```
优先级 1：HTTP Content-Type 头声明的 charset        （charsetFromContentType）
优先级 2：BOM（UTF-8 EF BB BF / UTF-16 FE FF、FF FE）（sniffBomCharset）
优先级 3：CSS 文件头部的 @charset "..."              （sniffCssCharset）
兜底   ：UTF-8（Web 规范默认），TextDecoder fatal:false 不抛异常
```

- **解码侧**：中文站点常见的 GBK/GB2312/Big5 依赖优先级 1、3 识别；
- **输出侧**：所有文本统一按 UTF-8 序列化，文件统一声明 `<meta charset="utf-8">`，从根上消除"解码对、写出错"的第二类乱码；
- **已知边界**：若源站资源自身含非法字节（如百度某个 JS 以 `charset=utf-8` 提供却含裸 `0xFE/0xFF`），浏览器解码同样产生 U+FFFD，快照忠实还原——这不是本扩展引入的乱码，e2e 的乱码断言因此以"**可见文本**（剔除 script/style）"为验收标准，详见 [TESTING.md](TESTING.md)。

## 5. 下载链路：为什么需要 offscreen 文档

MV3 的 Service Worker **没有 `URL.createObjectURL`**（Chrome 已从 worker 全局移除），而：

- `data:` URL 方案有约 2MB 的 URL 长度上限（Chromium `url::kMaxURLSize`），内嵌大量图片的快照轻松超限；
- offscreen 文档是一个隐藏的扩展页面，拥有完整 DOM 上下文，`reasons: ['BLOBS']` 正是为"创建 blob URL"设计。

因此下载拆成两半，各自待在能干活上下文里：

```
SW: downloadBlob(blob, filename, askLocation)
 ├─ blobToText(blob)                          // Blob.text()，老内核退回 FileReader
 ├─ ensureOffscreenDocument()                 // 按需创建 + READY/PING 握手（见下）
 ├─ OFFSCREEN_MAKE_BLOB_URL {text, mime}      // SW -> offscreen
 │    └─ offscreen: URL.createObjectURL       // 只有这里能建
 ├─ chrome.downloads.download({url, filename, saveAs, conflictAction:'uniquify'})
 ├─ 等 onChanged -> complete/interrupted       // 提前回收 URL 会读到半截文件（已知坑）
 ├─ OFFSCREEN_REVOKE {url}                    // 必须由创建方回收
 └─ closeOffscreenDocument()                  // 释放资源
```

**offscreen 生命周期管理**（`ensureOffscreenDocument`）处理三种情况：

1. 本 SW 生命周期内已知就绪 → 直接返回；
2. SW 重启后文档仍在 → `OFFSCREEN_PING` 握手，通则复用，不通则强制关闭重建；
3. 文档不存在 → `createDocument` 后等待 `OFFSCREEN_READY` 广播（`createDocument` 返回时页面脚本未必执行完，必须等广播）。

另有两个工程细节：

- **下载串行锁**（`downloadChain`）：并发保存时，避免前一次下载的收尾逻辑（关闭 offscreen）打断后一次；
- **降级路径**：无 `chrome.offscreen` 的浏览器（如旧版 Firefox）自动降级 `data:` URL 下载，超大文件会失败并给出明确错误，不会静默丢数据。

## 6. 消息协议全景

```
弹窗/网页      --POPUP_SAVE {tabId, options}-->     SW
SW            --CS_COLLECT {options}-->            内容脚本
内容脚本      --CS_FETCH_ASSETS {payload}-->       SW
SW            --SAVE_PROGRESS/SAVE_DONE/SAVE_ERROR--> 弹窗/options（广播）
options 等    --GET_HISTORY/DELETE/CLEAR/EXPORT/OPEN_DOWNLOAD/RESAVE_URL--> SW
SW            --OFFSCREEN_PING/MAKE_BLOB_URL/REVOKE-->  offscreen 文档
offscreen 文档 --OFFSCREEN_READY-->                 全部上下文
```

维护提示：任何新增消息类型都要同步三处——SW 路由、对应上下文监听、本清单。

## 7. 数据与设置

- `chrome.storage.local.settings`：`{format, banner, injectBase, askLocation, subdir, maxAssetMB, recordHistory}`（默认值见 SW 的 `DEFAULT_SETTINGS`）；
- `chrome.storage.local.history`：快照库数据源，最新在前，上限 300 条，**成功与失败都记录**（失败记录带 `error` 字段，便于排查）；
- 下载文件名：`<子目录>/<清洗后的标题>_<YYYYMMDD-HHMMSS>.<ext>`，`conflictAction:'uniquify'` 重名自动追加序号，不覆盖旧快照。

## 8. 测试友好的设计决策

- **纯逻辑与副作用分离**：`utils.js` / `css-tools.js` 不引用 `chrome.*` 与 DOM，可在 Node `vm` 沙箱里直接单测（21 项）；
- **DOM 操作显式传 `doc` 参数**：不直接用全局 `document`，内容脚本核心逻辑可在 jsdom / 真实浏览器中复用；
- **采集-内嵌单会话**：一次注入后闭包持有全部 DOM 引用，跨 SW 异步往返不丢元素；
- **回滚可观测**：`rollback()` 导出供测试断言"原页面零侵入"。
