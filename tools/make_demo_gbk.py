#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
工具：生成 GBK 编码的演示页面（用于验证"保存后不乱码"）。

用法：
    python tools/make_demo_gbk.py

产出：
    demo/gbk-page.html          GBK 编码的 HTML 页面（meta charset=GBK）
    demo/assets/style-gbk.css   GBK 编码且带 @charset "GBK" 声明的样式表

为什么需要它：
    国内仍有部分老旧站点以 GBK/GB2312 编码输出页面与 CSS。
    本工具生成这类"最麻烦"的样本，配合扩展的 decodeText 三级嗅探
    （Content-Type -> BOM -> @charset -> UTF-8），验证保存后的快照
    统一以 UTF-8 输出且中文完全正常。
"""
import io
import os

# GBK 页面模板（源码为 UTF-8，写出时整体转码为 GBK 字节）
GBK_PAGE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="GBK">
  <title>GBK 编码演示页 - 网页快照乱码测试</title>
  <link rel="stylesheet" href="assets/style-gbk.css">
  <style>
    .gbk-hero {
      height: 160px;
      background-image: url('assets/photo.png');
      background-size: cover;
      border-radius: 10px;
      margin: 12px 0;
    }
  </style>
</head>
<body>
  <h1>GBK 编码页面（乱码测试）</h1>
  <p>本页面以 GBK 编码输出，包含易乱码的中文内容：网页快照、防乱码、自包含、离线访问、百度快照式体验。</p>
  <p>标点与特殊符号测试：《书名号》、【括号】、"引号"、——破折号、……省略号。</p>
  <div class="gbk-hero"></div>
  <p class="gbk-note">这段文字由 GBK 编码的 style-gbk.css 设置样式，验证 CSS 侧解码。</p>
  <img src="assets/avatar.png" alt="徽标" width="64" height="64">
  <p id="js-status">脚本尚未执行</p>
  <script src="assets/app.js"></script>
</body>
</html>
"""

# GBK 样式表（带 @charset 声明，服务端不发 charset 头时靠它识别）
GBK_CSS = """@charset "GBK";
/* 中文注释：GBK 编码的样式表，服务端未声明 charset 时靠 @charset 识别 */
body {
  font: 14px/1.7 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  color: #222;
  background: #fafafa;
  padding: 20px;
}
h1 { font-size: 20px; }
.gbk-note {
  padding: 10px 14px;
  border-radius: 8px;
  background: #fff7e6;
  border: 1px solid #f5d9a0;
  color: #8a5a00;
}
.gbk-note::before { content: "GBK 样式表生效："; font-weight: 500; }
"""


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    page_path = os.path.join(root, 'demo', 'gbk-page.html')
    with io.open(page_path, 'w', encoding='gbk', newline='\n') as f:
        f.write(GBK_PAGE)
    print('生成 GBK 页面: %s' % page_path)

    css_path = os.path.join(root, 'demo', 'assets', 'style-gbk.css')
    with io.open(css_path, 'w', encoding='gbk', newline='\n') as f:
        f.write(GBK_CSS)
    print('生成 GBK 样式表: %s' % css_path)


if __name__ == '__main__':
    main()
