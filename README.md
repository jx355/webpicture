# 网页快照保存器（Webpage Snapshot Saver）

一个零构建、开箱即用的 Chrome / Edge 浏览器扩展（Manifest V3）：一键把当前网页保存为**自包含快照文件**，离线打开时页面原样可见、中文不乱码、不依赖原网站。

对标产品：百度网页快照。

## 功能特性

- **双保存链路，自动择优**
  - Chrome：原生 MHTML（`chrome.pageCapture`，保真度最高，保留跨域 iframe 与 JS 执行态）；
  - Edge 等无 pageCapture 的浏览器：单文件 HTML（所有资源以 data URI 内联，全浏览器通用）；
  - 设置里选"自动"时优先 MHTML，未授权或不可用则自动降级单文件 HTML。
- **离线可用**：图片、样式、脚本、字体、同源 iframe 全部内嵌，断网打开原样呈现。
- **不乱码**：按 `Content-Type charset → BOM → CSS @charset 嗅探 → UTF-8` 优先级解码源资源，输出统一声明 UTF-8（GBK / GB2312 页面实测无乱码）。
- **百度快照式横幅**：快照顶部标注保存时间、原始地址与原页面差异提示，可关闭。
- **三种触发方式**：工具栏弹窗、快捷键 `Alt+S`、右键菜单"保存当前网页为快照"。
- **快照库**：options 页管理历史记录，支持搜索、打开所在文件夹、重新保存、删除、导出索引 JSON。
- **对原页面零侵入**：采集在闭包中进行，保存结束后逆序回滚全部 DOM 改写，用户正在浏览的页面毫发无损。

## 30 秒快速部署

无需任何构建工具，整个项目就是扩展本身：

```bash
# 1. 克隆或下载本项目到本地（任选目录）
git clone https://github.com/jx355/webpicture.git webpage-snapshot
cd webpage-snapshot
```

**Chrome / Edge 安装：**

1. 地址栏输入 `chrome://extensions`（Edge 用 `edge://extensions`）；
2. 打开右上角的 **"开发者模式"** 开关；
3. 点击 **"加载已解压的扩展程序"**，选择本项目根目录（含 `manifest.json` 的那一层）；
4. 完成。工具栏出现相机图标，`Alt+S` 即可保存当前网页。

> 首次使用如想用原生 MHTML：点弹窗里的"授权"按钮授予"页面捕获"权限；不授权也完全可用（自动走单文件 HTML）。

## 使用说明

| 操作 | 效果 |
|---|---|
| 点工具栏图标 → "保存当前网页" | 保存当前标签页 |
| 快捷键 `Alt+S` | 保存当前标签页 |
| 右键菜单 → "保存当前网页为快照" | 保存当前页/框架 |
| 右键扩展图标 → "扩展程序选项" | 打开快照库与设置 |

保存完成后：

- 文件落在浏览器下载目录的 `webpage-snapshots/` 子目录，命名规则 `页面标题_YYYYMMDD-HHMMSS.html`（MHTML 则为 `.mhtml`）；
- 弹窗显示保存结果（文件名、体积、未能内嵌的资源数）；
- 快照库（options 页）出现一条记录，可重新保存 / 打开所在文件夹 / 删除。

## 防乱码是怎么做到的

1. **解码**：每个资源按 `Content-Type 声明 → BOM → CSS `@charset` 嗅探 → UTF-8 兜底` 的顺序解码（`src/lib/utils.js` 的 `decodeText`），GBK 页面也能正确还原；
2. **编码**：输出文件统一 `<meta charset="utf-8">`，内嵌的 CSS / JS 文本一律按 UTF-8 重新序列化；
3. **注入**：保存时剥离原页面的 CSP meta 与刷新跳转 meta，避免离线打开时被策略拦截或定时跳走。

## 项目结构

```
webpicture/
├── manifest.json                  # MV3 清单（权限、命令、入口）
├── assets/icons/                  # 扩展图标（16/48/128，由 tools/make_icons.py 生成）
├── src/
│   ├── lib/
│   │   ├── utils.js               # 纯逻辑库：URL 解析、文件名清洗、 charset 解码、data URI、并发控制
│   │   └── css-tools.js           # 纯逻辑库：CSS url() 提取/改写、@import 递归展平（防循环）
│   ├── content/
│   │   └── snapshot-content.js    # 内容脚本：DOM 采集 → 内嵌 → 序列化 → 回滚
│   ├── background/
│   │   └── service-worker.js      # SW：保存编排、资源抓取（唯一网络出口）、下载、历史
│   ├── offscreen/
│   │   ├── offscreen.html         # offscreen 文档（MV3 的 DOM 替身）
│   │   └── offscreen.js           # 只负责创建/回收 blob URL（SW 无 URL.createObjectURL）
│   ├── popup/                     # 工具栏弹窗（保存入口 + 最近记录）
│   └── options/                   # options 页（快照库 + 设置）
├── demo/                          # 本地演示页（UTF-8 综合页 + GBK 页 + 同源 iframe）
├── tests/                         # 单元测试（Node vm）+ 真实浏览器 e2e（Playwright）
├── tools/                         # 图标/演示资源生成脚本（纯 Python 标准库）
└── docs/                          # 架构 / 设计 / 测试文档
```

## 本地验证

```bash
# 1. 起演示站点（端口 8899）
python -m http.server 8899 --directory demo

# 2. 浏览器打开 http://localhost:8899/utf8-page.html 与 gbk-page.html，
#    对两个页面分别执行保存，断网打开下载的文件核对效果（清单见 demo/README.md）

# 3. 跑测试（可选）
node tests/unit-tests.js                                          # 单元测试（25 项）
PYTHON_BIN=python node tests/browser-e2e.mjs                      # 真实浏览器端到端（35 项，含百度真实站点）
```

测试覆盖说明与已知环境限制见 [docs/TESTING.md](docs/TESTING.md)。

## 已知限制

- **跨域 iframe** 无法内嵌（浏览器安全边界），快照中保留其原始地址，离线时该区域空白；需要完整保留请用 Chrome 的 MHTML 链路。
- **超大页面**（资源总体积超过 48MB）会跳过后续资源并在警告中列出，已内嵌部分不受影响。
- **需登录的页面**：SW 抓取资源时携带 Cookie（`credentials: 'include'`），同源资源一般可抓；但跨域且严格校验 Referer 的站点可能失败。
- **SPA 重度前端页**：保存的是当前 DOM 快照（非运行时状态重放），交互功能离线后不可用，呈现不受影响。
- `Alt+S` 与浏览器或网站自身快捷键冲突时，可在 `chrome://extensions/shortcuts` 自定义。

## 技术栈

- 原生 JavaScript（IIFE + `importScripts`，零依赖、零构建）
- Manifest V3，`minimum_chrome_version: 114`
- 测试：Node 内置 `vm`（单测）+ Playwright + 真实 Chromium（e2e）

## 许可

本项目采用 [GNU Affero 通用公共许可证第 3 版（AGPL-3.0）](LICENSE) 授权。

要点：

- 你可以自由使用、修改和分发本软件，但**衍生作品必须以相同许可证开源**；
- AGPL 是强 Copyleft：即使你只是**通过网络提供修改版服务**（未分发二进制），也必须向用户公开对应源码；
- 完整条款以仓库根目录的 [LICENSE](LICENSE) 文件为准。
