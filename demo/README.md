# 演示页面（demo）

用于本地验证扩展的保存效果，覆盖全部关键资源类型与编码场景。

## 启动方式

```bash
# 在 demo/ 目录下任选一种方式起本地服务（端口 8899）
python -m http.server 8899
# 或
npx serve -l 8899 .
```

然后浏览器访问：

| 页面 | 地址 | 验证点 |
|---|---|---|
| UTF-8 综合演示页 | http://localhost:8899/utf8-page.html | 外链 CSS（含 @import）、行内 CSS url()、懒加载图片（data-src）、srcset、picture/source、同源 iframe、表单状态、脚本执行、锚点 |
| GBK 编码演示页 | http://localhost:8899/gbk-page.html | GBK 页面 + GBK 样式表（`@charset "GBK"`），验证保存后统一转 UTF-8 不乱码 |

## 验证清单

对每个页面执行"保存快照"后：

1. 下载目录出现 `webpage-snapshots/<标题>_<时间>.html`（Chrome 授权后为 `.mhtml`）；
2. **断开网络**，用 Chrome/Edge 打开该文件：
   - 页面布局、图片、样式与原页一致；
   - 中文全部正常，无乱码（GBK 页尤其注意）；
   - 页面顶部有"网页快照"标识横幅（保存时间 / 原始地址 / 差异提示），点 × 可关闭；
   - `#js-status` 显示"脚本已执行"，说明内联 JS 依然运行；
   - iframe 内容可见（同源 iframe 被递归序列化）；
3. 在 options 页"快照库"中能看到对应记录，可打开所在文件夹 / 重新保存 / 删除。

## 文件说明

| 文件 | 说明 |
|---|---|
| `utf8-page.html` | UTF-8 综合演示页 |
| `gbk-page.html` | GBK 编码演示页（由 `tools/make_demo_gbk.py` 生成，勿手改） |
| `iframe.html` | 同源 iframe 内容页 |
| `assets/style.css` | 外链样式表（含 `@import`） |
| `assets/imported.css` | 被 `@import` 引入的样式表 |
| `assets/style-gbk.css` | GBK 编码样式表（由脚本生成） |
| `assets/app.js` | 演示脚本 |
| `assets/photo.png` / `avatar.png` / `favicon.svg` | 演示图片（由 `tools/make_icons.py` 生成 / 手写 SVG） |
