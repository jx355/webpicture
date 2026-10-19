/**
 * @file src/content/snapshot-content.js
 * @description 内容脚本：在页面上下文中完成"采集"与"内嵌"两步，
 *              是单文件 HTML 方案的核心（Edge 等无 pageCapture 的浏览器走此链路）。
 *
 * 工作流程（单会话，见 runCollect）：
 *   1. collect：遍历 DOM，登记所有需要内嵌的元素与资源 URL（含同源 iframe 递归）；
 *   2. 把资源清单发给 Service Worker，由 SW 统一抓取（绕开页面 CORS 限制）；
 *   3. embed：拿回资源后改写 DOM（图片->dataUri、外链CSS-><style>、JS->内联、iframe->srcdoc）；
 *   4. 注入 <meta charset="utf-8"> / <base> / 百度快照式横幅；
 *   5. 序列化为完整 HTML 字符串；
 *   6. finally 中【逆序回滚】所有 DOM 改写，保证用户正在浏览的页面零侵入。
 *
 * 设计约定（维护者必读）：
 *   - collect 与 embed 之间隔着一次 SW 异步往返，因此采用"单会话"设计：
 *     一次注入后闭包持有全部 DOM 引用，避免二次注入时元素引用丢失；
 *   - 所有 DOM 操作函数显式接收 doc 参数，不直接使用全局 document，
 *     以便在 jsdom / 真实浏览器中做自动化测试；
 *   - 纯逻辑部分（collectTree/embedTree 等）导出到 global.WSSnapshot，
 *     浏览器引导代码（消息监听）放在文件末尾，二者分离；
 *   - 【内联转义铁律】任何外链 JS / CSS 文本写进 <script> / <style> 前，
 *     必须过 escapeScriptText / escapeCssText——裸 "</script" / "</style"
 *     会提前闭合元素，把剩余代码漏成正文可见文本（百度实测踩坑，详见函数注释）。
 */
(function (global) {
  'use strict';

  /* ================================================================== */
  /* 常量                                                                 */
  /* ================================================================== */

  /** 懒加载图片常见的地址属性（按优先级排列，后续站点出现新写法时在此扩展） */
  var LAZY_SRC_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-echo'];

  /** 同源 iframe 递归内嵌深度上限（1 = 只嵌一层，与浏览器另存为行为接近） */
  var MAX_IFRAME_DEPTH = 1;

  /* ================================================================== */
  /* 采集（collect）                                                      */
  /* ================================================================== */

  /**
   * 递归采集一棵文档树（主文档或同源 iframe 文档）。
   *
   * @param {Document} doc 目标文档
   * @param {string} url 该文档的绝对 URL（解析相对地址的基准）
   * @param {number} depth 当前深度（主文档为 0）
   * @param {Object} ctx 采集上下文：{ seen, resources, nextInlineId }
   * @returns {CollectNode} 采集结果树节点
   *
   * @typedef {Object} CollectNode
   * @property {Document} doc
   * @property {string} url
   * @property {HTMLElement[]} images        普通 img（有 src）
   * @property {HTMLElement[]} lazyImages    懒加载 img（无 src，只有 data-* 属性）
   * @property {HTMLElement[]} srcsetImages  带 srcset 的 img/source
   * @property {HTMLElement[]} scripts       外链 script
   * @property {HTMLElement[]} styleLinks    link[rel=stylesheet]
   * @property {HTMLElement[]} iconLinks     link[rel=icon]
   * @property {HTMLElement[]} preloadLinks  link[rel=preload/prefetch]（as 为 font/image/script/style）
   * @property {HTMLElement[]} media         audio/video/source/track
   * @property {HTMLElement[]} objects       embed/object
   * @property {HTMLElement[]} svgImages     SVG <image>
   * @property {Array<{el: HTMLElement, id: number, text: string}>} inlineCss    <style> 块
   * @property {Array<{el: HTMLElement, id: number, text: string}>} inlineStyles style 属性
   * @property {Array<{el: HTMLElement, url: string, child: CollectNode}>} iframes 同源 iframe
   */
  function collectTree(doc, url, depth, ctx) {
    var node = {
      doc: doc,
      url: url,
      images: [],
      lazyImages: [],
      srcsetImages: [],
      scripts: [],
      styleLinks: [],
      iconLinks: [],
      preloadLinks: [],
      media: [],
      objects: [],
      svgImages: [],
      inlineCss: [],
      inlineStyles: [],
      iframes: []
    };

    /** 登记一个资源 URL（解析为绝对地址后去重） */
    function addResource(rawUrl, kind) {
      if (!rawUrl) return;
      var abs = WSUtils.resolveUrl(url, String(rawUrl).trim());
      if (!abs || WSUtils.isSkippableUrl(abs)) return;
      if (ctx.seen[abs]) return;
      ctx.seen[abs] = true;
      ctx.resources.push({ url: abs, kind: kind || 'asset' });
    }

    /** 登记一段行内 CSS 文本（交给 SW 展平 @import 并把 url() 换成 dataUri） */
    function addInlineCss(el, text) {
      node.inlineCss.push({ el: el, id: ctx.nextInlineId++, text: text });
    }

    /** 登记一个 style 属性（同上） */
    function addInlineStyle(el, text) {
      node.inlineStyles.push({ el: el, id: ctx.nextInlineId++, text: text });
    }

    var all = doc.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var tag = el.tagName ? el.tagName.toLowerCase() : '';

      switch (tag) {
        case 'img':
          node.images.push(el);
          if (el.getAttribute('src')) {
            addResource(el.getAttribute('src'), 'image');
          } else {
            // 懒加载图片：仅当没有 src 时才登记，避免误抓占位大图
            for (var j = 0; j < LAZY_SRC_ATTRS.length; j++) {
              var lazyVal = el.getAttribute(LAZY_SRC_ATTRS[j]);
              if (lazyVal) {
                addResource(lazyVal, 'image');
                node.lazyImages.push(el);
                break;
              }
            }
          }
          if (el.getAttribute('srcset')) {
            node.srcsetImages.push(el);
            var first = WSUtils.parseSrcset(el.getAttribute('srcset'))[0];
            if (first) addResource(first.url, 'image');
          }
          break;

        case 'source':
          node.srcsetImages.push(el);
          var parentTag = el.parentNode && el.parentNode.tagName ? el.parentNode.tagName.toLowerCase() : '';
          if (el.getAttribute('src')) {
            addResource(el.getAttribute('src'), /video|audio/.test(parentTag) ? 'media' : 'image');
          }
          if (el.getAttribute('srcset')) {
            var first2 = WSUtils.parseSrcset(el.getAttribute('srcset'))[0];
            if (first2) addResource(first2.url, 'image');
          }
          break;

        case 'script':
          if (el.getAttribute('src')) {
            addResource(el.getAttribute('src'), 'js');
            node.scripts.push(el);
          }
          break;

        case 'link': {
          var rel = (el.getAttribute('rel') || '').toLowerCase();
          var href = el.getAttribute('href');
          if (!href) break;
          if (rel.indexOf('stylesheet') >= 0) {
            addResource(href, 'css');
            node.styleLinks.push(el);
          } else if (rel.indexOf('icon') >= 0) {
            addResource(href, 'image');
            node.iconLinks.push(el);
          } else if (rel.indexOf('preload') >= 0 || rel.indexOf('prefetch') >= 0) {
            // 只内联与渲染直接相关的 preload（font/image/script/style）
            var as = (el.getAttribute('as') || '').toLowerCase();
            if (as === 'font' || as === 'image' || as === 'script' || as === 'style') {
              addResource(href, as === 'style' ? 'css' : as === 'script' ? 'js' : 'asset');
              node.preloadLinks.push(el);
            }
          }
          break;
        }

        case 'iframe': {
          var src = el.getAttribute('src');
          if (!src || WSUtils.isSkippableUrl(src)) break;
          try {
            var idoc = el.contentDocument;
            if (idoc && depth < MAX_IFRAME_DEPTH) {
              var childUrl = WSUtils.resolveUrl(url, src) || url;
              var child = collectTree(idoc, childUrl, depth + 1, ctx);
              node.iframes.push({ el: el, url: childUrl, child: child });
            }
          } catch (e) {
            // 跨源 iframe：contentDocument 不可访问（同源策略），跳过
          }
          break;
        }

        case 'audio':
        case 'video':
          node.media.push(el);
          if (el.getAttribute('src')) addResource(el.getAttribute('src'), 'media');
          if (el.getAttribute('poster')) addResource(el.getAttribute('poster'), 'image');
          break;

        case 'track':
          node.media.push(el);
          if (el.getAttribute('src')) addResource(el.getAttribute('src'), 'media');
          break;

        case 'embed':
        case 'object':
          node.objects.push(el);
          if (el.getAttribute('src')) addResource(el.getAttribute('src'), 'asset');
          if (el.getAttribute('data')) addResource(el.getAttribute('data'), 'asset');
          break;

        case 'image': // SVG <image href="...">
          node.svgImages.push(el);
          var svgHref = el.getAttribute('href') || el.getAttribute('xlink:href');
          if (svgHref) addResource(svgHref, 'image');
          break;
      }

      // style 属性中的 url()（文本交给 SW 处理）
      var styleAttr = el.getAttribute && el.getAttribute('style');
      if (styleAttr && /url\(/i.test(styleAttr)) {
        addInlineStyle(el, styleAttr);
      }
    }

    // <style> 块（其中的 url() 与 @import 由 SW 解析处理）
    var styleEls = doc.querySelectorAll('style');
    for (var k = 0; k < styleEls.length; k++) {
      var text = styleEls[k].textContent || '';
      if (text.trim()) addInlineCss(styleEls[k], text);
    }

    return node;
  }

  /**
   * 采集整个页面：主文档 + 全部同源 iframe，汇总资源清单与行内 CSS 清单。
   * @param {Document} doc 主文档
   * @param {string} url 页面绝对 URL
   * @returns {{tree: CollectNode, resources: Array, inlineCss: Array, inlineStyles: Array}}
   */
  function collectPage(doc, url) {
    var ctx = { seen: Object.create(null), resources: [], nextInlineId: 0 };
    var tree = collectTree(doc, url, 0, ctx);
    var inlineCss = [];
    var inlineStyles = [];
    (function walk(node) {
      node.inlineCss.forEach(function (item) { inlineCss.push(item); });
      node.inlineStyles.forEach(function (item) { inlineStyles.push(item); });
      node.iframes.forEach(function (f) { walk(f.child); });
    })(tree);
    return {
      tree: tree,
      resources: ctx.resources,
      inlineCss: inlineCss,
      inlineStyles: inlineStyles
    };
  }

  /* ================================================================== */
  /* 内嵌（embed）                                                        */
  /* ================================================================== */

  /**
   * 记录一次属性改写（含撤销操作）。所有 DOM 改写必须走 mutate* 系列，
   * 保证序列化完成后可以完整回滚。
   */
  function mutateAttr(ctx, el, name, value) {
    var had = el.hasAttribute(name);
    var old = el.getAttribute(name);
    ctx.undo.push(function () {
      if (had) el.setAttribute(name, old);
      else el.removeAttribute(name);
    });
    if (value == null) el.removeAttribute(name);
    else el.setAttribute(name, value);
  }

  /** 记录一次文本改写（含撤销操作）。 */
  function mutateText(ctx, el, text) {
    var old = el.textContent;
    ctx.undo.push(function () { el.textContent = old; });
    el.textContent = text;
  }

  /**
   * 转义待内联进 <script> 元素的 JS 文本：把 "</script" 替换为 "<\/script"。
   *
   * 为什么必须转义（真实踩坑）：
   *   HTML 规范规定 script 元素的内容在第一个 "</script" 处结束。外链 JS 里含裸
   *   "</script>" 字符串极其常见（document.write 动态写脚本标签的模式），
   *   实测百度首页某个 JS 在 27KB 处就有 3 处。不转义时，序列化产物中 script
   *   元素会被提前闭合，后半段 JS 漏成页面正文可见文本——用户保存百度
   *   会看到一大段裸代码渲染在页面上。
   *
   * 为什么这样转义是安全的：
   *   "<\/script" 在 JS 字符串字面量、正则字面量、注释中均与 "</script" 语义
   *   等价（\/ 是合法转义），这是所有服务端模板内联脚本时使用的标准做法；
   *   且替换可重入（已转义文本不会再次匹配）。
   *
   * @param {string} text 原始 JS 文本
   * @returns {string} 转义后的文本
   */
  function escapeScriptText(text) {
    // 函数式替换：保留原始大小写（JS 字符串值大小写敏感，</SCRIPT 与 </script 不同值）
    return String(text).replace(/<\/script/gi, function (m) { return '<\\/' + m.slice(2); });
  }

  /**
   * 转义待内联进 <style> 元素的 CSS 文本：把 "</style" 替换为 "<\/style"。
   * 同理：CSS 文本里的 "</style" 会提前闭合 style 元素；"<\/style" 在 CSS
   * 字符串中与 "</style" 等价（\/ 是合法转义），出现在注释中则无害。
   * @param {string} text 原始 CSS 文本
   * @returns {string} 转义后的文本
   */
  function escapeCssText(text) {
    // 函数式替换：保留原始大小写（CSS 字符串值同样大小写敏感）
    return String(text).replace(/<\/style/gi, function (m) { return '<\\/' + m.slice(2); });
  }

  /**
   * 把 <link rel=stylesheet> 替换为等价的 <style> 元素（保留 media 属性）。
   */
  function replaceWithStyle(ctx, linkEl, cssText) {
    var doc = linkEl.ownerDocument;
    var parent = linkEl.parentNode;
    if (!parent) return;
    var style = doc.createElement('style');
    var media = linkEl.getAttribute('media');
    if (media) style.setAttribute('media', media);
    // CSS 文本同样可能含裸 "</style"（如 content 字符串），不转义会提前闭合元素
    style.textContent = escapeCssText(cssText);
    var next = linkEl.nextSibling;
    ctx.undo.push(function () {
      if (parent) parent.insertBefore(linkEl, next); // 还原到原位置
      if (style.parentNode) style.parentNode.removeChild(style);
    });
    parent.insertBefore(style, linkEl);
    parent.removeChild(linkEl);
  }

  /**
   * 递归内嵌一棵文档树。
   * @param {Object} ctx embed 上下文：{ assets, cssTextById, undo, warnings }
   *   - assets: SW 返回的资源表 { 绝对URL: {kind, dataUri?, text?} }
   *   - cssTextById: 行内 CSS 处理结果 { id: 处理后的CSS文本 }
   * @param {CollectNode} node 采集结果节点
   */
  function embedTree(ctx, node) {
    var assets = ctx.assets;

    /** 取某个（可能是相对的）URL 对应的 dataUri，没有则返回 null */
    function dataUriFor(rawUrl) {
      var abs = WSUtils.resolveUrl(node.url, rawUrl);
      var a = abs && assets[abs];
      return a && a.dataUri ? a.dataUri : null;
    }

    /* ---------- 图片 ---------- */
    node.images.forEach(function (el) {
      var src = el.getAttribute('src');
      if (!src) return;
      var uri = dataUriFor(src);
      if (uri) {
        mutateAttr(ctx, el, 'src', uri);
        mutateAttr(ctx, el, 'srcset', null); // srcset 优先级高于 src，移除避免干扰
      }
    });

    node.lazyImages.forEach(function (el) {
      for (var j = 0; j < LAZY_SRC_ATTRS.length; j++) {
        var attr = LAZY_SRC_ATTRS[j];
        var v = el.getAttribute(attr);
        if (!v) continue;
        var uri2 = dataUriFor(v);
        if (uri2) {
          mutateAttr(ctx, el, 'src', uri2);
          mutateAttr(ctx, el, 'srcset', null);
          // 移除已消费的懒加载属性：避免残留相对引用被站点懒加载库重新利用
          mutateAttr(ctx, el, attr, null);
          break;
        }
      }
    });

    node.srcsetImages.forEach(function (el) {
      // srcset 只内嵌首个候选：用它的 dataUri 覆盖 src 并移除 srcset
      var first = WSUtils.parseSrcset(el.getAttribute('srcset') || '')[0];
      if (!first) return;
      var uri3 = dataUriFor(first.url);
      if (uri3) {
        mutateAttr(ctx, el, 'src', uri3);
        mutateAttr(ctx, el, 'srcset', null);
      }
    });

    /* ---------- 脚本：外链 -> 内联 ---------- */
    node.scripts.forEach(function (el) {
      var abs = WSUtils.resolveUrl(node.url, el.getAttribute('src'));
      var text = abs && assets[abs] && assets[abs].text;
      if (text != null) {
        // 必须转义 "</script"：否则序列化时 script 元素被提前闭合，JS 漏成正文
        mutateText(ctx, el, escapeScriptText(text));
        mutateAttr(ctx, el, 'src', null);
      }
    });

    /* ---------- 样式表：外链 -> <style> ---------- */
    node.styleLinks.forEach(function (el) {
      var abs = WSUtils.resolveUrl(node.url, el.getAttribute('href'));
      var text = abs && assets[abs] && assets[abs].text;
      if (text != null) replaceWithStyle(ctx, el, text);
    });

    /* ---------- 其它元素：地址 -> dataUri ---------- */
    function inlineAttr(el, attr) {
      var v = el.getAttribute(attr);
      if (!v) return;
      var uri = dataUriFor(v);
      if (uri) mutateAttr(ctx, el, attr, uri);
    }

    node.iconLinks.forEach(function (el) { inlineAttr(el, 'href'); });
    node.preloadLinks.forEach(function (el) { inlineAttr(el, 'href'); });
    node.media.forEach(function (el) {
      inlineAttr(el, 'src');
      inlineAttr(el, 'poster');
    });
    node.objects.forEach(function (el) {
      inlineAttr(el, 'src');
      inlineAttr(el, 'data');
    });
    node.svgImages.forEach(function (el) {
      inlineAttr(el, 'href');
      inlineAttr(el, 'xlink:href');
    });

    /* ---------- 行内 CSS（SW 已处理好，按 id 取回） ---------- */
    node.inlineCss.forEach(function (item) {
      var processed = ctx.cssTextById[item.id];
      if (processed != null) mutateText(ctx, item.el, escapeCssText(processed));
    });
    node.inlineStyles.forEach(function (item) {
      var processed = ctx.cssTextById[item.id];
      if (processed != null) mutateAttr(ctx, item.el, 'style', processed);
    });

    /* ---------- iframe：递归内嵌 -> srcdoc ---------- */
    node.iframes.forEach(function (f) {
      embedTree(ctx, f.child); // 先递归处理子文档
      var subHtml = serializeDoc(f.child.doc);
      mutateAttr(ctx, f.el, 'srcdoc', subHtml);
      mutateAttr(ctx, f.el, 'src', null);
    });
  }

  /* ================================================================== */
  /* 文档级注入（charset / base / 横幅）                                   */
  /* ================================================================== */

/**
 * 注入 <meta charset="utf-8">，并剥离快照中不需要的元信息：
 *   1. 移除页面原有的 charset 声明，统一改为 UTF-8（防乱码的最终保证）；
 *   2. 移除 Content-Security-Policy 元信息——真实网站常带 CSP，
 *      它会阻止快照文件中的内联样式/脚本（包括我们内联的站点 JS 与横幅脚本），
 *      导致离线打开时页面"变样"，是真实站点保存失败最常见的原因之一；
 *   3. 移除 refresh 跳转——避免打开快照时被重定向到其它页面。
 *
 * 注意：以上移除只作用于【保存后的快照文件】，用户正在浏览的实时页面不受影响
 *        （所有改写都会在序列化后回滚）。
 */
function injectCharset(doc, ctx) {
  var head = doc.head || doc.documentElement;
  if (!head) return;

  // 1) 原有 charset / content-type 声明
  var olds = doc.querySelectorAll('meta[charset], meta[http-equiv="content-type" i]');
  for (var i = 0; i < olds.length; i++) {
    removeWithUndo(ctx, olds[i]);
  }

  // 2) CSP 与 refresh：快照中必须剥离（原因见函数注释）
  var dangerous = doc.querySelectorAll(
    'meta[http-equiv="content-security-policy" i], ' +
    'meta[http-equiv="content-security-policy-report-only" i], ' +
    'meta[http-equiv="refresh" i]'
  );
  for (var j = 0; j < dangerous.length; j++) {
    removeWithUndo(ctx, dangerous[j]);
  }

  // 3) 插入统一的 UTF-8 声明
  var meta = doc.createElement('meta');
  meta.setAttribute('charset', 'utf-8');
  head.insertBefore(meta, head.firstChild);
  ctx.undo.push(function () {
    if (meta.parentNode) meta.parentNode.removeChild(meta);
  });
}

  /**
   * 注入 <base href="页面URL">：让快照中的相对链接 / 锚点仍指向原网站。
   * 先移除页面自带的 <base>（避免它的 href 覆盖我们的）。
   */
  function injectBase(doc, pageUrl, ctx) {
    var head = doc.head || doc.documentElement;
    if (!head) return;
    var olds = doc.querySelectorAll('base');
    for (var i = 0; i < olds.length; i++) {
      removeWithUndo(ctx, olds[i]);
    }
    var base = doc.createElement('base');
    base.setAttribute('href', pageUrl);
    head.insertBefore(base, head.firstChild);
    ctx.undo.push(function () {
      if (base.parentNode) base.parentNode.removeChild(base);
    });
  }

  /**
   * 注入"百度快照"式标识横幅：保存时间 + 原始地址 + 差异提示 + 关闭按钮。
   * @param {Document} doc
   * @param {{url: string, savedAt: number}} info
   * @param {Object} ctx
   */
  function injectBanner(doc, info, ctx) {
    var body = doc.body;
    if (!body) return;
    var time = WSUtils.formatTimestamp(info.savedAt);

    var div = doc.createElement('div');
    div.id = 'ws-snapshot-banner';
    // 注意：innerHTML 中的 <script> 不会执行，因此关闭按钮的脚本单独创建后 append
    div.innerHTML =
      '<style>#ws-snapshot-banner{box-sizing:border-box;padding:8px 16px;background:#eef3ff;' +
      'border-bottom:1px solid #c7d7f5;font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;' +
      'color:#333;position:relative}#ws-snapshot-banner .ws-tag{display:inline-block;margin-right:8px;' +
      'padding:1px 8px;border-radius:3px;background:#315efb;color:#fff;font-size:12px}' +
      '#ws-snapshot-banner a{color:#315efb}#ws-snapshot-banner .ws-tip{color:#888;margin-left:8px}' +
      '#ws-banner-close{position:absolute;right:10px;top:50%;transform:translateY(-50%);' +
      'border:none;background:none;font-size:16px;color:#888;cursor:pointer;padding:0 4px}</style>' +
      '<span class="ws-tag">网页快照</span>本页面保存于 <b>' + WSUtils.escapeHtml(time) + '</b>，原始地址：' +
      '<a href="' + WSUtils.escapeHtml(info.url) + '" target="_blank" rel="noreferrer">' +
      WSUtils.escapeHtml(info.url) + '</a>' +
      '<span class="ws-tip">快照内容可能与实时页面存在差异</span>' +
      '<button id="ws-banner-close" title="关闭此提示">&times;</button>';

    var script = doc.createElement('script');
    script.textContent =
      'document.getElementById("ws-banner-close").onclick=function(){' +
      'var b=document.getElementById("ws-snapshot-banner");if(b&&b.parentNode)b.parentNode.removeChild(b)};';
    div.appendChild(script);

    body.insertBefore(div, body.firstChild);
    ctx.undo.push(function () {
      if (div.parentNode) div.parentNode.removeChild(div);
    });
  }

  /** 移除元素并记录撤销操作（尽量还原到原位置）。 */
  function removeWithUndo(ctx, el) {
    var parent = el.parentNode;
    if (!parent) return;
    var next = el.nextSibling;
    ctx.undo.push(function () {
      if (parent) parent.insertBefore(el, next);
    });
    parent.removeChild(el);
  }

  /* ================================================================== */
  /* 序列化与回滚                                                        */
  /* ================================================================== */

  /**
   * 序列化整个文档为完整 HTML 字符串（含 DOCTYPE）。
   * @param {Document} doc
   * @returns {string}
   */
  function serializeDoc(doc) {
    var doctype = '<!DOCTYPE html>';
    var dt = doc.doctype;
    if (dt) {
      doctype = '<!DOCTYPE ' + dt.name +
        (dt.publicId ? ' PUBLIC "' + dt.publicId + '"' : '') +
        (dt.systemId ? ' "' + dt.systemId + '"' : '') + '>';
    }
    return doctype + '\n' + doc.documentElement.outerHTML;
  }

  /**
   * 逆序执行所有撤销操作，恢复页面原状。单个失败不影响其它回滚。
   * @param {Object} ctx
   */
  function rollback(ctx) {
    for (var i = ctx.undo.length - 1; i >= 0; i--) {
      try {
        ctx.undo[i]();
      } catch (e) {
        if (global.console && global.console.warn) {
          global.console.warn('[snapshot] 回滚单项失败:', e);
        }
      }
    }
    ctx.undo.length = 0;
  }

  /* ================================================================== */
  /* 编排：一次完整的保存流程                                             */
  /* ================================================================== */

  /**
   * 处理 CS_COLLECT 消息：采集 -> 请求资源 -> 内嵌 -> 序列化 -> 回滚。
   * @param {{options: Object}} msg
   * @returns {Promise<{html: string, stats: Object, warnings: string[]}>}
   */
  function runCollect(msg) {
    var pageUrl = global.location ? global.location.href : '';
    var options = (msg && msg.options) || {};
    var page = collectPage(global.document, pageUrl);

    // 打包发给 SW 的行内 CSS 清单（只发文本，DOM 引用留在闭包里）
    var inlineCss = page.inlineCss.map(function (item) {
      return { id: item.id, text: item.text };
    });
    var inlineStyles = page.inlineStyles.map(function (item) {
      return { id: item.id, text: item.text };
    });

    return sendToBackground({
      type: 'CS_FETCH_ASSETS',
      payload: {
        pageUrl: pageUrl,
        resources: page.resources,
        inlineCss: inlineCss,
        inlineStyles: inlineStyles
      }
    }).then(function (resp) {
      if (!resp || resp.error) {
        throw new Error((resp && resp.error) || '资源抓取失败');
      }

      var ctx = {
        assets: resp.assets || {},
        cssTextById: {},
        undo: [],
        warnings: resp.warnings || []
      };
      // SW 按请求顺序返回处理结果，按下标回填到 id
      (resp.inlineCss || []).forEach(function (text, i) {
        if (inlineCss[i]) ctx.cssTextById[inlineCss[i].id] = text;
      });
      (resp.inlineStyles || []).forEach(function (text, i) {
        if (inlineStyles[i]) ctx.cssTextById[inlineStyles[i].id] = text;
      });

      try {
        embedTree(ctx, page.tree);
        injectCharset(global.document, ctx);
        if (options.injectBase !== false) {
          injectBase(global.document, pageUrl, ctx);
        }
        if (options.banner !== false) {
          injectBanner(global.document, { url: pageUrl, savedAt: Date.now() }, ctx);
        }
        var html = serializeDoc(global.document);
        return {
          html: html,
          stats: countResources(page.resources),
          warnings: ctx.warnings
        };
      } finally {
        rollback(ctx); // 无论成功失败都恢复页面
      }
    });
  }

  /** 统计资源清单（用于 popup 展示）。 */
  function countResources(resources) {
    var stats = { total: resources.length, image: 0, css: 0, js: 0, media: 0, asset: 0 };
    resources.forEach(function (r) {
      if (stats[r.kind] != null) stats[r.kind]++;
    });
    return stats;
  }

  /* ================================================================== */
  /* 消息通道                                                            */
  /* ================================================================== */

  /**
   * 向 Service Worker 发消息并等待响应（兼容 Promise / 回调两种 API 形态）。
   * @param {Object} msg
   * @returns {Promise<*>}
   */
  function sendToBackground(msg) {
    return new Promise(function (resolve, reject) {
      var maybe;
      try {
        maybe = chrome.runtime.sendMessage(msg);
      } catch (e) {
        reject(e);
        return;
      }
      if (maybe && typeof maybe.then === 'function') {
        maybe.then(resolve, reject);
        return;
      }
      chrome.runtime.sendMessage(msg, function (resp) {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(resp);
      });
    });
  }

  /**
   * 消息监听入口（浏览器引导代码）。
   * @returns {boolean} 返回 true 表示异步响应
   */
  function handleMessage(msg, sender, sendResponse) {
    if (!msg || msg.type !== 'CS_COLLECT') return false;
    runCollect(msg).then(sendResponse, function (err) {
      sendResponse({ error: (err && err.message) || String(err) });
    });
    return true;
  }

  /* ================================================================== */
  /* 导出 + 启动                                                          */
  /* ================================================================== */

  // 纯逻辑导出（供自动化测试直接调用，参数全部显式注入）
  global.WSSnapshot = {
    collectTree: collectTree,
    collectPage: collectPage,
    embedTree: embedTree,
    injectCharset: injectCharset,
    injectBase: injectBase,
    injectBanner: injectBanner,
    serializeDoc: serializeDoc,
    rollback: rollback,
    mutateAttr: mutateAttr,
    mutateText: mutateText,
    replaceWithStyle: replaceWithStyle,
    escapeScriptText: escapeScriptText,
    escapeCssText: escapeCssText,
    LAZY_SRC_ATTRS: LAZY_SRC_ATTRS,
    MAX_IFRAME_DEPTH: MAX_IFRAME_DEPTH
  };

  // 浏览器引导：注册消息监听（带防重复注入守卫）
  if (typeof chrome !== 'undefined' && chrome.runtime && !global.__wsContentBooted) {
    global.__wsContentBooted = true;
    chrome.runtime.onMessage.addListener(handleMessage);
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
