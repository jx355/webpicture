# 测试文档（TESTING）

本项目采用"纯逻辑单测 + 真实浏览器端到端"双层验证，全部零第三方依赖（单测只用 Node 内置模块，e2e 只用 Playwright + 本机 Chromium）。

## 1. 测试全景

| 层级 | 命令 | 规模 | 验证什么 |
|---|---|---|---|
| 单元测试 | `node tests/unit-tests.js` | 25 项 | 纯逻辑：编码解码、URL/文件名、srcset、并发控制、CSS 处理、**内联转义回归** |
| 端到端 A | `node tests/browser-e2e.mjs`（Part A） | 15 项 | 真实 Chromium 引擎跑完整"采集→抓取→内嵌→序列化→回滚"管线（UTF-8 页 10 项 + GBK 页 5 项） |
| 端到端 B | 同上（Part B） | 20 项 | `--load-extension` 加载扩展，完整 SW 链路保存【演示页】与【真实网站 baidu.com】，校验历史记录、下载项、文件内容 |

## 2. 运行方式

### 单元测试（无需任何环境）

```bash
node tests/unit-tests.js
# 期望输出：单元测试：25 通过，0 失败
```

原理：`tests/helpers/load-lib.js` 用 Node 内置 `vm` 模块把浏览器脚本（IIFE 风格）加载进共享沙箱执行，从而在 Node 里直接测试 `WSUtils` / `WSCss` / `WSSnapshot` 的纯函数。`utils.js` / `css-tools.js` / `snapshot-content.js` 因此被刻意约束为"不引用 `chrome.*`、不直接使用全局 `document`"。

### 端到端测试（需要 Playwright + Chromium）

```bash
# Windows / Git Bash
PYTHON_BIN="C:/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe" \
  node tests/browser-e2e.mjs

# 或使用系统 python
PYTHON_BIN=python node tests/browser-e2e.mjs
```

可选环境变量：

| 变量 | 作用 | 默认 |
|---|---|---|
| `PYTHON_BIN` | 起 demo 静态服务用的 python | `python` |
| `E2E_REAL_SITE` | Part B 真实网站用例 | `https://www.baidu.com` |
| `PW_CORE_PATH` | playwright-core 模块路径 | 按常见位置自动查找 |
| `PW_BROWSERS_PATH` | Playwright 浏览器根目录 | `~/AppData/Local/ms-playwright` |

前置条件：本机已安装 Playwright 的**完整版 Chromium**（`chromium-xxxx/chrome-win64/chrome.exe`；headless shell 不支持 `--load-extension`，e2e 会优先挑完整版）。

## 3. 各层覆盖明细

### 3.1 单元测试（25 项）

- **防乱码核心路径**：`decodeText` 的 Content-Type charset / BOM / CSS `@charset` 嗅探 / UTF-8 兜底，夹具为真实 GBK / BOM 字节流（`tests/fixtures/`）；
- **URL 与文件名**：相对/绝对/越级解析、非法输入、文件名特殊字符清洗、快照文件名生成；
- **srcset**：候选拆分与描述符；
- **并发控制**：`mapLimit` 保序 / 限流 / 失败隔离；
- **CSS**：`url()` 提取去重、`@import` 两种写法、展平、循环引用打破、抓取失败降级、深度上限；
- **内联转义回归**（2026-10 新增）：`escapeScriptText` / `escapeCssText` 对裸 `</script` / `</style` 的转义、大小写保留、可重入性、百度 `document.write` 实测模式。

### 3.2 端到端 Part A（15 项，核心管线）

在真实 Chromium 里打开 demo 页，把扩展的 lib 与内容脚本注入页面，完整跑一遍保存管线（同源页面用页面内 fetch 模拟 SW 抓取），断言：

- UTF-8 页：图片 data URI 内嵌、无残留相对资源引用、UTF-8 声明、快照横幅、iframe 递归内嵌（srcdoc）、`@import` 展平可见、懒加载图片补 src、脚本执行态保留、无乱码、**原页面已回滚**；
- GBK 页：CSS 中文正确解码、正文中文无乱码、标点完整、UTF-8 声明、无乱码。

### 3.3 端到端 Part B（20 项，扩展集成）

以 `--load-extension` 启动真实 Chromium 加载扩展，从 options 页发送 `POPUP_SAVE`（与点击弹窗保存按钮完全相同的消息），分别保存演示页与 baidu.com，断言：

- 历史记录：`status=success`、未授权 pageCapture 时降级 `format=html`、文件名带子目录与标题、字节数 > 0；
- 下载项：由本扩展发起（`byExtensionId`）、`state=complete`、字节数与历史记录一致、文件可读取；
- 文件内容：自包含（data URI）、中文无乱码、UTF-8 声明；真实网站额外断言有效 HTML 与**可见文本无乱码**。

## 4. 测试环境已知限制（重要，避免误判）

以下三条是**测试框架层的限制，不是扩展缺陷**，均已在测试代码注释中注明原因：

1. **headless Chromium 不分发扩展快捷键命令**：`chrome.commands.onCommand`（Alt+S）在 headless 下不触发（已实测）。Part B 因此改用 `POPUP_SAVE` 消息触发——这与点击弹窗"保存当前网页"按钮时 `popup.js` 发出的消息完全一致（同 type、同字段），走的仍是同一条 SW 链路。快捷键功能本身在真实浏览器中可用。
2. **Playwright 的 CDP 下载拦截会把落盘文件改名为 GUID**：无论 `Browser.setDownloadBehavior` 用 `allow` 还是 `allowAndName`，扩展下载的文件都会以 GUID 名落盘，`filename` 选项的真实效果无法在磁盘名上观测（对照组实验：普通 http URL + filename 选项同样被改名，证明与扩展无关）。因此 Part B 不断言磁盘文件名，改用 `chrome.downloads.search` 校验下载项状态/字节数/发起方，文件名规则则断言历史记录里的 `filename` 字段。
3. **源站自身的非法字节**：百度首页某个外链 JS（`all_async_search_b732276.js`）以 `charset=utf-8` 提供，却在字符串字面量里含裸 `0xFE/0xFF` 字节，浏览器解码同样产生 5 个 U+FFFD。快照忠实还原不属于"我们引入的乱码"，因此真实网站的乱码断言以"**可见文本**（剔除 script/style）"为验收标准；演示页（内容完全自控）仍坚持全文零 U+FFFD。

## 5. 回归案例库（真实站点踩过的坑）

| 现象 | 根因 | 修复 | 回归测试 |
|---|---|---|---|
| 保存报 `tabsSend is not defined` | SW 里调用了未定义的 helper | 新增 Promise 化 `tabsSend`（含 lastError 中文化） | e2e Part B 历史记录断言 |
| 保存报 `URL.createObjectURL is not a function` | MV3 SW 没有该 API | offscreen 文档代建 blob URL + SW 下载 + 完成后回收 | e2e Part B 下载项断言 |
| 百度快照里出现一大段裸 JS 代码 | 外链 JS 含裸 `</script>`，序列化提前闭合 script 元素，后半段漏成正文 | `escapeScriptText` / `escapeCssText` 内联转义 | 单测 4 项 + e2e 可见文本无乱码断言 |
| 懒加载图片残留 `assets/` 相对地址 | 懒加载属性未消费即保留 | 补 src 后删除已消费的懒加载属性 | e2e Part A "无残留相对资源引用" |
| GBK 页面 CSS 中文乱码 | 缺 charset 声明时按 UTF-8 硬解 | `@charset` 嗅探 + BOM + Content-Type 优先级链 | 单测 fixtures + e2e GBK 页 5 项 |

## 6. 新增测试的建议

- **纯逻辑**（不碰 DOM / chrome）：直接加 `test(...)` 到 `tests/unit-tests.js`，函数先从对应模块导出到 `global.WSUtils` / `WSCss` / `WSSnapshot`；
- **管线行为**：优先加 demo 页面用例（`demo/` 下新增页面 + Part A 断言），demo 页同时是手动验证的载体；
- **扩展集成**：在 Part B 增加断言，观测点优先选扩展内可编程查询的（历史记录、`chrome.downloads.search`），避免依赖磁盘文件名。
