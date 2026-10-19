/**
 * @file src/lib/css-tools.js
 * @module WSCss
 * @description CSS 文本处理工具：url() 引用提取与重写、@import 展平。
 *              单文件 HTML 方案中，外链 CSS 需要被"展平 + 内联"才能脱离网络。
 *
 * 设计约定（维护者必读）：
 *   1. 纯函数 + 依赖注入：抓取动作通过参数 fetchCssText 注入，
 *      本文件自身不发任何网络请求，可在 Node 中完整单测；
 *   2. 依赖 WSUtils.resolveUrl（由调用方保证已加载）；
 *   3. 正则说明：
 *      - url() 匹配同时支持带引号与不带引号两种写法；
 *      - @import 匹配同时支持 url(...) 与 "..." 两种写法；
 *      已知限制：URL 中如果含有未转义的右括号或引号会匹配失败（极其罕见）。
 */
(function (global) {
  'use strict';

  /** 匹配 url('...') / url("...") / url(...) */
  var CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

  /** 匹配 @import url(...) 与 @import "..." / @import '...' */
  var CSS_IMPORT_RE = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)/gi;

  /**
   * 提取 CSS 中所有 url() 引用（原始形式，未解析为绝对 URL）。
   * @param {string} css CSS 文本
   * @returns {string[]} 去重后的引用列表（不含 data: 等伪协议）
   */
  function extractCssUrls(css) {
    var out = [];
    var seen = Object.create(null);
    if (!css) return out;
    var m;
    CSS_URL_RE.lastIndex = 0;
    while ((m = CSS_URL_RE.exec(css)) !== null) {
      var ref = (m[2] || '').trim();
      if (!ref || /^(data|blob|about|javascript|mailto|tel):/i.test(ref)) continue;
      if (seen[ref]) continue;
      seen[ref] = true;
      out.push(ref);
    }
    return out;
  }

  /**
   * 提取 CSS 中所有 @import 目标（原始形式）。
   * @param {string} css CSS 文本
   * @returns {string[]} 去重后的引用列表
   */
  function extractCssImports(css) {
    var out = [];
    var seen = Object.create(null);
    if (!css) return out;
    var m;
    CSS_IMPORT_RE.lastIndex = 0;
    while ((m = CSS_IMPORT_RE.exec(css)) !== null) {
      var ref = (m[2] || m[4] || '').trim();
      if (!ref || /^(data|blob|about):/i.test(ref)) continue;
      if (seen[ref]) continue;
      seen[ref] = true;
      out.push(ref);
    }
    return out;
  }

  /**
   * 重写 CSS 中的 url() 引用。
   * @param {string} css 原始 CSS 文本
   * @param {function(string): (string|null)} mapper
   *        入参为原始引用，返回替换字符串（通常是 data URI）；
   *        返回 null 表示保留原样（抓取失败的降级路径）。
   * @returns {string} 重写后的 CSS 文本
   */
  function rewriteCssUrls(css, mapper) {
    if (!css) return css;
    return css.replace(CSS_URL_RE, function (whole, quote, ref) {
      var trimmed = (ref || '').trim();
      if (!trimmed || /^(data|blob|about|javascript|mailto|tel):/i.test(trimmed)) return whole;
      var replacement;
      try {
        replacement = mapper(trimmed);
      } catch (e) {
        replacement = null;
      }
      if (replacement == null) return whole; // 降级：保留原 URL
      return 'url("' + replacement + '")';
    });
  }

  /**
   * 展平 @import：把每条 @import 语句替换为抓取到的 CSS 文本（递归）。
   *
   * 处理规则：
   *   - 抓取成功 -> 用 CSS 文本替换整条 @import 语句（含其 media 条件，media 会丢失，
   *     因为内联后无法再按媒体查询条件加载，属于已知限制）；
   *   - 抓取失败 -> 保留原 @import（联网打开时仍可生效，属降级路径）；
   *   - 循环引用 / 重复引用 -> 替换为空串，打破环。
   *
 * @param {string} css 原始 CSS 文本
 * @param {string} baseUrl 该 CSS 的绝对 URL（用于解析相对 @import）
 * @param {function(string, number, Set<string>): Promise<string|null>} fetchCssText
 *        入参为 @import 的绝对 URL、剩余深度、共享的已访问集合；
 *        由调用方负责递归展平（Service Worker 侧会再次调用本函数），失败返回 null
 * @param {number} [maxDepth=3] 递归深度上限
 * @param {Set<string>} [visited] 已访问集合（跨层级共享，防循环引用）
 * @returns {Promise<string>} 展平后的 CSS 文本
 */
  function flattenCssImports(css, baseUrl, fetchCssText, maxDepth, visited) {
    var depth = maxDepth == null ? 3 : maxDepth;
    var seen = visited || new Set();
    if (!css || depth <= 0) return Promise.resolve(css);

    // 先收集所有 @import（避免边匹配边替换导致的索引错乱）
    var matches = [];
    var m;
    CSS_IMPORT_RE.lastIndex = 0;
    while ((m = CSS_IMPORT_RE.exec(css)) !== null) {
      var raw = (m[2] || m[4] || '').trim();
      if (raw) matches.push({ full: m[0], url: raw });
    }
    if (matches.length === 0) return Promise.resolve(css);

    // @import 数量通常很少，串行处理更可控
    var result = css;
    var chain = Promise.resolve();
    matches.forEach(function (item) {
      chain = chain.then(function () {
        var abs = global.WSUtils ? global.WSUtils.resolveUrl(baseUrl, item.url) : null;
        if (!abs) return;
        if (seen.has(abs)) {
          result = result.split(item.full).join(''); // 循环/重复引用：打破环
          return;
        }
        seen.add(abs);
        return Promise.resolve()
          .then(function () { return fetchCssText(abs, depth - 1, seen); })
          .then(function (text) {
            if (text == null) return; // 抓取失败：保留原 @import（降级）
            result = result.split(item.full).join(text);
          })
          .catch(function () { /* 单条失败不阻塞其余 */ });
      });
    });
    return chain.then(function () { return result; });
  }

  /* ================================================================== */
  /* 导出                                                                */
  /* ================================================================== */

  global.WSCss = {
    extractCssUrls: extractCssUrls,
    extractCssImports: extractCssImports,
    rewriteCssUrls: rewriteCssUrls,
    flattenCssImports: flattenCssImports
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
