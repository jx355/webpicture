/**
 * @file src/lib/utils.js
 * @module WSUtils
 * @description 纯工具函数集合：URL 解析、文件名清洗、srcset 解析、编码解码、
 *              base64 转换、并发控制等。是整个扩展"防乱码"能力的核心。
 *
 * 设计约定（维护者必读）：
 *   1. 本文件【不依赖】任何浏览器/扩展 API（chrome.*、document 等），
 *      因此既能被 Service Worker / 内容脚本通过 importScripts 复用，
 *      也能在 Node 中通过 vm 沙箱直接加载做单元测试；
 *   2. 所有导出函数保持纯函数风格：入参 -> 出参，不读写全局状态；
 *   3. 通过顶部 IIFE 向全局挂载 WSUtils，供其它经典脚本按顺序引用；
 *   4. 新增工具函数时，请同步在 tests/lib-tests.js 中补充用例。
 */
(function (global) {
  'use strict';

  /* ================================================================== */
  /* URL 处理                                                            */
  /* ================================================================== */

  /**
   * 把（可能为相对路径的）URL 解析为绝对 URL。
   * @param {string} base 基准 URL（通常是页面最终 URL）
   * @param {string} url 待解析的 URL
   * @returns {string|null} 绝对 URL；解析失败返回 null
   */
  function resolveUrl(base, url) {
    if (!base || !url) return null;
    try {
      return new URL(String(url), base).href;
    } catch (e) {
      return null;
    }
  }

  /**
   * 判断 URL 是否无需（也无法）抓取：空值或 data:/blob:/javascript: 等伪协议。
   * @param {string} url
   * @returns {boolean}
   */
  function isSkippableUrl(url) {
    if (!url) return true;
    return /^(data|blob|about|javascript|mailto|tel):/i.test(String(url).trim());
  }

  /**
   * 从 URL 中提取主机名（用于文件名兜底）。
   * @param {string} url
   * @returns {string}
   */
  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch (e) {
      return '';
    }
  }

  /* ================================================================== */
  /* 文件名处理                                                          */
  /* ================================================================== */

  /**
   * 清洗为 Windows / macOS 均合法的文件名。
   * 步骤：替换非法字符 -> 压缩空白 -> 截断 -> 空值回退。
   * @param {string} name 原始名称（通常是页面标题）
   * @param {number} [maxLen=80] 最大长度（按字符数）
   * @returns {string}
   */
  function sanitizeFilename(name, maxLen) {
    var limit = maxLen || 80;
    var cleaned = String(name || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ') // Windows 非法字符与控制字符
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) cleaned = 'snapshot';
    if (cleaned.length > limit) cleaned = cleaned.slice(0, limit).trim();
    return cleaned;
  }

  /**
   * 生成快照文件名：<标题>_<YYYYMMDD-HHMMSS>.<ext>
   * @param {string} title 页面标题
   * @param {string} url 页面 URL（标题为空时用主机名兜底）
   * @param {string} ext 扩展名（不含点），如 'html' / 'mhtml'
   * @param {number} [ts] 时间戳（毫秒），默认当前时间
   * @returns {string}
   */
  function buildSnapshotFilename(title, url, ext, ts) {
    var base = sanitizeFilename(title || hostOf(url) || 'snapshot', 60);
    var d = new Date(ts || Date.now());
    var stamp = '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
      '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
    return base + '_' + stamp + '.' + ext;
  }

  /* ================================================================== */
  /* 编码与解码（防乱码核心）                                            */
  /* ================================================================== */

  /**
   * 从 Content-Type 头中提取 charset 参数。
   * @param {string} [contentType] 如 'text/html; charset=gb2312'
   * @returns {string|null}
   */
  function charsetFromContentType(contentType) {
    if (!contentType) return null;
    var m = /charset\s*=\s*["']?([\w\-]+)/i.exec(contentType);
    return m ? m[1].toLowerCase() : null;
  }

  /**
   * 嗅探字节流 BOM，返回对应编码名；无 BOM 返回 null。
   * @param {Uint8Array} bytes
   * @returns {string|null}
   */
  function sniffBomCharset(bytes) {
    if (!bytes || bytes.length < 2) return null;
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return 'utf-8';
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) return 'utf-16le';
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) return 'utf-16be';
    return null;
  }

  /**
   * 嗅探 CSS 文件头部的 @charset 声明（仅看前 128 字节）。
   * 国内部分老旧站点 serving GBK CSS 时不发 charset 头，只能靠它。
   * @param {Uint8Array} bytes
   * @returns {string|null}
   */
  function sniffCssCharset(bytes) {
    if (!bytes || bytes.length < 10) return null;
    var head = '';
    var len = Math.min(bytes.length, 128);
    for (var i = 0; i < len; i++) head += String.fromCharCode(bytes[i]);
    var m = /^@charset\s+["']([\w\-]+)["']/i.exec(head);
    return m ? m[1].toLowerCase() : null;
  }

  /**
   * 把响应字节解码为字符串，按优先级推断编码：
   *   1. Content-Type 头声明的 charset
   *   2. BOM（UTF-8 / UTF-16）
   *   3. CSS 文件头部的 @charset 声明
   *   4. 兜底 UTF-8（Web 规范默认值）
   *
   * 说明：中文站点常见的 GBK/GB2312/Big5 依赖第 1、3 级识别；
   * 全部落空时按 UTF-8 解码且不抛异常（TextDecoder fatal:false）。
   * 输出侧统一以 UTF-8 写出并声明 <meta charset="utf-8">，从根上保证不乱码。
   *
   * @param {Uint8Array} bytes 原始字节
   * @param {string} [contentType] HTTP Content-Type 头
   * @returns {string} 解码后的文本
   */
  function decodeText(bytes, contentType) {
    var charset = charsetFromContentType(contentType) ||
      sniffBomCharset(bytes) ||
      sniffCssCharset(bytes) ||
      'utf-8';
    try {
      return new TextDecoder(charset, { fatal: false }).decode(bytes);
    } catch (e) {
      // 编码名不被当前运行时支持（极端情况），回退 UTF-8
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }
  }

  /**
   * 字符串的 UTF-8 字节长度（用于体积统计）。
   * @param {string} str
   * @returns {number}
   */
  function byteLength(str) {
    try {
      return new TextEncoder().encode(str).length;
    } catch (e) {
      return String(str).length;
    }
  }

  /* ================================================================== */
  /* base64 / data URI                                                   */
  /* ================================================================== */

  /**
   * Uint8Array -> base64 字符串（分块避免 apply 参数溢出）。
   * @param {Uint8Array} bytes
   * @returns {string}
   */
  function bytesToBase64(bytes) {
    var binary = '';
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  /**
   * 字节流 -> data URI（自包含页面的资源载体）。
   * @param {Uint8Array} bytes
   * @param {string} mime MIME 类型，如 'image/png'
   * @returns {string}
   */
  function bufferToDataUri(bytes, mime) {
    return 'data:' + (mime || 'application/octet-stream') + ';base64,' + bytesToBase64(bytes);
  }

  /**
   * 根据 URL 路径猜测 MIME 类型（Content-Type 缺失时的兜底）。
   * @param {string} url
   * @returns {string|null}
   */
  function guessMimeFromUrl(url) {
    var m = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(String(url || ''));
    if (!m) return null;
    var ext = m[1].toLowerCase();
    var map = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
      css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
      woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
      html: 'text/html', htm: 'text/html', json: 'application/json',
      mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg'
    };
    return map[ext] || null;
  }

  /* ================================================================== */
  /* HTML / 文本工具                                                     */
  /* ================================================================== */

  /**
   * HTML 属性/文本转义（用于横幅拼接，防止标题中的引号破坏结构）。
   * @param {string} s
   * @returns {string}
   */
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * 时间戳格式化为 'YYYY-MM-DD HH:mm:ss'（本地时区）。
   * @param {number} ts
   * @returns {string}
   */
  function formatTimestamp(ts) {
    var d = new Date(ts || Date.now());
    return '' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  /**
   * 字节数格式化为可读字符串（B / KB / MB）。
   * @param {number} n
   * @returns {string}
   */
  function formatBytes(n) {
    var v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
    return (v / 1024 / 1024).toFixed(2) + ' MB';
  }

  /**
   * 生成 UUID（优先 crypto.randomUUID，降级随机串）。
   * @returns {string}
   */
  function uuid() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /* ================================================================== */
  /* srcset 解析                                                         */
  /* ================================================================== */

  /**
   * 解析 srcset 属性为候选列表。
   * 例：'a.png 1x, b.png 2x' -> [{url:'a.png',descriptor:'1x'}, {url:'b.png',descriptor:'2x'}]
   * @param {string} srcset
   * @returns {Array<{url: string, descriptor: string}>}
   */
  function parseSrcset(srcset) {
    var out = [];
    String(srcset || '').split(',').forEach(function (part) {
      var seg = part.trim();
      if (!seg) return;
      var m = seg.match(/^(\S+)(?:\s+(.*))?$/);
      if (m) out.push({ url: m[1], descriptor: (m[2] || '').trim() });
    });
    return out;
  }

  /* ================================================================== */
  /* 并发控制                                                            */
  /* ================================================================== */

  /**
   * 受限并发 map：最多 limit 个任务并行，结果保序；
   * 单个任务失败不阻塞其他任务（结果位为 null）。
   * @param {Array<*>} items 输入数组
   * @param {number} limit 并发上限（>=1）
   * @param {function(*, number): Promise<*>} worker 工作任务
   * @returns {Promise<Array<*>>} 与输入等长的结果数组
   */
  function mapLimit(items, limit, worker) {
    var list = items || [];
    var n = list.length;
    var results = new Array(n).fill(null);
    if (n === 0) return Promise.resolve(results);
    var max = Math.max(1, Math.min(limit || 1, n));
    var next = 0;
    function runOne() {
      if (next >= n) return Promise.resolve();
      var index = next++;
      return Promise.resolve()
        .then(function () { return worker(list[index], index); })
        .then(function (value) { results[index] = value; })
        .catch(function (err) {
          // 单条失败仅记录 null，由调用方决定如何降级
          results[index] = null;
          if (global.console && global.console.warn) {
            global.console.warn('[WSUtils.mapLimit] 任务失败:', err && err.message ? err.message : err);
          }
        })
        .then(runOne);
    }
    var runners = [];
    for (var i = 0; i < max; i++) runners.push(runOne());
    return Promise.all(runners).then(function () { return results; });
  }

  /* ================================================================== */
  /* 内部工具                                                            */
  /* ================================================================== */

  /** 数字补零到两位。 */
  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  /* ================================================================== */
  /* 导出                                                                */
  /* ================================================================== */

  global.WSUtils = {
    resolveUrl: resolveUrl,
    isSkippableUrl: isSkippableUrl,
    hostOf: hostOf,
    sanitizeFilename: sanitizeFilename,
    buildSnapshotFilename: buildSnapshotFilename,
    charsetFromContentType: charsetFromContentType,
    sniffBomCharset: sniffBomCharset,
    sniffCssCharset: sniffCssCharset,
    decodeText: decodeText,
    byteLength: byteLength,
    bytesToBase64: bytesToBase64,
    bufferToDataUri: bufferToDataUri,
    guessMimeFromUrl: guessMimeFromUrl,
    escapeHtml: escapeHtml,
    formatTimestamp: formatTimestamp,
    formatBytes: formatBytes,
    uuid: uuid,
    parseSrcset: parseSrcset,
    mapLimit: mapLimit
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
