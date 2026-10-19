/**
 * @file src/background/service-worker.js
 * @description MV3 后台服务线程：统一编排"保存网页快照"全流程。
 *
 * 两条保存链路：
 *   链路 A（Chrome 原生 MHTML）：chrome.pageCapture.saveAsMHTML -> Blob -> 下载。
 *     保真度最高（保留跨域 iframe、JS 执行态），但 pageCapture 仅 Chrome 提供，
 *     且为可选权限（用时才申请，拒绝则自动降级到链路 B）；
 *   链路 B（单文件 HTML，Edge 等通用）：注入内容脚本采集 -> SW 抓取资源 ->
 *     内容脚本内嵌序列化 -> 下载。全浏览器可用。
 *
 * 职责边界：
 *   - 本文件是【唯一的网络出口】：所有资源抓取都在这里完成，
 *     因为扩展上下文有 <all_urls> 特权，可绕开页面 CORS 限制；
 *   - popup / options 只负责界面，设置与历史直接读写 chrome.storage；
 *   - CSS 的 @import 展平与 url() 内联在 processCssText 中完成；
 *   - 下载走 offscreen 文档代建 blob URL（SW 无 URL.createObjectURL，见"下载"节）。
 *
 * 消息协议（维护者必读）：
 *   POPUP_SAVE        {tabId, options}      popup -> SW    触发保存
 *   CS_COLLECT        {options}             SW -> 内容脚本  开始采集（内容脚本内部会再请求资源）
 *   CS_FETCH_ASSETS   {payload}             内容脚本 -> SW  请求抓取资源
 *   SAVE_PROGRESS     {message}             SW -> 页面     进度广播
 *   SAVE_DONE         {result}              SW -> 页面     完成广播
 *   SAVE_ERROR        {error}               SW -> 页面     失败广播
 *   GET_HISTORY / DELETE_HISTORY / CLEAR_HISTORY / EXPORT_HISTORY / OPEN_DOWNLOAD / RESAVE_URL
 *                                          页面 -> SW      快照库操作
 *   OFFSCREEN_READY         -               offscreen -> 全部  文档就绪广播（握手用）
 *   OFFSCREEN_PING          -               SW -> 全部         探测文档存活（响应 {pong:true}）
 *   OFFSCREEN_MAKE_BLOB_URL {text, mime}     SW -> offscreen    创建 blob: URL（响应 {url}）
 *   OFFSCREEN_REVOKE        {url}           SW -> offscreen    回收 blob: URL
 */
/* global WSUtils, WSCss */
importScripts('../lib/utils.js', '../lib/css-tools.js');

/* ================================================================== */
/* 常量与默认配置                                                        */
/* ================================================================== */

/** 默认设置（options 页可改，持久化在 chrome.storage.local.settings） */
var DEFAULT_SETTINGS = {
  format: 'auto',              // auto | mhtml | html
  banner: true,                // 是否注入百度快照式横幅
  injectBase: true,            // 是否注入 <base href>（让相对链接仍指向原站）
  askLocation: false,          // 下载时是否弹出"另存为"对话框
  subdir: 'webpage-snapshots', // 下载子目录（相对于浏览器下载目录）
  maxAssetMB: 12,              // 单资源体积上限（MB），超过则跳过
  recordHistory: true          // 是否记录快照历史
};

/** 单次快照的资源总字节上限，超出后跳过后续资源（防止超大页面拖垮内存） */
var MAX_TOTAL_BYTES = 48 * 1024 * 1024;

/** 历史记录条数上限 */
var HISTORY_LIMIT = 300;

/** 抓取缓存：'url|kind' -> Promise<asset|null>，避免同 URL 重复下载 */
var fetchCache = new Map();

/* ================================================================== */
/* 标签页消息工具                                                        */
/* ================================================================== */

/**
 * 向指定标签页发送消息并等待响应（Promise 化）。
 *
 * 为什么需要包一层：
 *   1. MV3 的 chrome.tabs.sendMessage 在 Chrome/Edge 上直接返回 Promise，
 *      但在只支持 callback 风格的内核上返回 undefined —— 这里同时兼容两种；
 *   2. 把 "Could not establish connection / Receiving end does not exist"
 *      这类 lastError 翻译成中文可读错误，避免上层拿到裸英文；
 *   3. 内容脚本未注入（如刚打开还没 load 完）时，这里会 reject，
 *      上层 saveAsSingleHtml 会捕获并提示"请刷新页面后重试"。
 *
 * @param {number} tabId 目标标签页 id
 * @param {Object} msg 消息体，须带 type 字段
 * @returns {Promise<any>} 内容脚本的响应对象
 */
function tabsSend(tabId, msg) {
  return new Promise(function (resolve, reject) {
    var settled = false;
    function done(err, resp) {
      if (settled) return; // callback 与 Promise 双触发时只认第一个
      settled = true;
      if (err) {
        reject(new Error(err.message || '与页面的通信失败'));
      } else {
        resolve(resp);
      }
    }
    try {
      var ret = chrome.tabs.sendMessage(tabId, msg, function (resp) {
        var le = chrome.runtime && chrome.runtime.lastError;
        done(le, resp);
      });
      // 新内核：未传 callback 时才返回 Promise；此处双保险，互不冲突
      if (ret && typeof ret.then === 'function') {
        ret.then(function (resp) { done(null, resp); }, function (e) {
          done(e, undefined);
        });
      }
    } catch (e) {
      done(e, undefined);
    }
  });
}

/* ================================================================== */
/* 设置                                                                 */
/* ================================================================== */

/**
 * 读取设置（默认值与 storage 合并）。
 * @returns {Promise<Object>}
 */
function getSettings() {
  return chrome.storage.local.get('settings').then(function (data) {
    var merged = {};
    for (var key in DEFAULT_SETTINGS) {
      merged[key] = DEFAULT_SETTINGS[key];
    }
    if (data && data.settings) {
      for (var k in data.settings) {
        if (data.settings[k] !== undefined && data.settings[k] !== null) {
          merged[k] = data.settings[k];
        }
      }
    }
    return merged;
  });
}

/* ================================================================== */
/* 生命周期：右键菜单 / 快捷键                                            */
/* ================================================================== */

chrome.runtime.onInstalled.addListener(function () {
  buildMenus();
});

/** 创建右键菜单（重复安装时先清空再建，避免堆积）。 */
function buildMenus() {
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({
      id: 'save-snapshot',
      title: '保存当前网页为快照',
      contexts: ['page', 'frame']
    });
  });
}

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (info.menuItemId === 'save-snapshot' && tab) {
    saveFromTab(tab, {});
  }
});

chrome.commands.onCommand.addListener(function (command) {
  if (command !== 'save-snapshot') return;
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (tabs && tabs[0]) saveFromTab(tabs[0], {});
  });
});

/* ================================================================== */
/* 主编排：保存快照                                                      */
/* ================================================================== */

/**
 * 保存指定标签页的快照（统一入口）。
 * @param {chrome.tabs.Tab} tab
 * @param {Object} [options] 覆盖设置的临时参数（如 {format:'html'}）
 * @returns {Promise<void>}
 */
async function saveFromTab(tab, options) {
  try {
    if (!tab || tab.id == null) throw new Error('找不到目标标签页');
    if (!tab.url || /^(chrome|edge|about|chrome-extension|moz-extension|https?:\/\/chrome\.google\.com)/i.test(tab.url)) {
      throw new Error('浏览器内部页面不支持保存');
    }

    var settings = await getSettings();
    var opts = Object.assign({}, settings, options || {});

    // 格式决策：auto 时优先原生 MHTML（仅当可用）
    var format = opts.format;
    if (format === 'auto') {
      format = (await canUseMhtml()) ? 'mhtml' : 'html';
    }
    if (format === 'mhtml' && !(await canUseMhtml())) {
      notify({ type: 'SAVE_PROGRESS', message: '原生 MHTML 不可用，已改用单文件 HTML' });
      format = 'html';
    }

    setBusy(true);
    notify({ type: 'SAVE_PROGRESS', message: '正在保存…' });

    var result = format === 'mhtml'
      ? await saveAsMhtml(tab, opts)
      : await saveAsSingleHtml(tab, opts);

    await recordHistory(Object.assign(
      { url: tab.url, title: tab.title || tab.url, format: format },
      result,
      { status: 'success', savedAt: Date.now() }
    ));
    notify({ type: 'SAVE_DONE', result: Object.assign({ format: format }, result) });
  } catch (err) {
    var message = (err && err.message) || String(err);
    try {
      await recordHistory({
        url: tab && tab.url,
        title: tab && tab.title,
        status: 'failed',
        error: message,
        savedAt: Date.now()
      });
    } catch (e) { /* 历史记录失败不影响主流程 */ }
    notify({ type: 'SAVE_ERROR', error: message });
  } finally {
    setBusy(false);
  }
}

/**
 * 判断能否走原生 MHTML：API 存在且权限已授予。
 * @returns {Promise<boolean>}
 */
async function canUseMhtml() {
  if (!chrome.pageCapture || typeof chrome.pageCapture.saveAsMHTML !== 'function') return false;
  try {
    return await chrome.permissions.contains({ permissions: ['pageCapture'] });
  } catch (e) {
    return false;
  }
}

/**
 * 链路 A：调用 pageCapture 生成原生 MHTML 并下载。
 * @param {chrome.tabs.Tab} tab
 * @param {Object} opts
 * @returns {Promise<{filename: string, bytes: number, downloadId: number}>}
 */
async function saveAsMhtml(tab, opts) {
  var blob = await new Promise(function (resolve, reject) {
    // 统一使用回调风格：支持 Promise 的 Chrome 版本同样兼容回调，避免重复调用
    chrome.pageCapture.saveAsMHTML({ tabId: tab.id }, function (data) {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(data);
    });
  });

  if (!blob) throw new Error('MHTML 生成失败');
  var filename = joinPath(opts.subdir, WSUtils.buildSnapshotFilename(tab.title, tab.url, 'mhtml'));
  var downloadId = await downloadBlob(blob, filename, opts.askLocation);
  return { filename: filename, bytes: blob.size || 0, downloadId: downloadId };
}

/**
 * 链路 B：采集 -> SW 抓取 -> 内容脚本内嵌 -> 下载单文件 HTML。
 * @param {chrome.tabs.Tab} tab
 * @param {Object} opts
 * @returns {Promise<{filename: string, bytes: number, downloadId: number, stats: Object, warnings: string[]}>}
 */
async function saveAsSingleHtml(tab, opts) {
  notify({ type: 'SAVE_PROGRESS', message: '正在注入采集脚本…' });
  try {
    // 注意：内容脚本依赖 utils / css-tools 两个纯逻辑库，
    // 必须按顺序一起注入（executeScript 会按 files 顺序注入到同一个隔离世界）
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [
        'src/lib/utils.js',
        'src/lib/css-tools.js',
        'src/content/snapshot-content.js'
      ]
    });
  } catch (e) {
    throw new Error('无法在此页面注入脚本（浏览器内部页面或受限页面不支持）');
  }

  notify({ type: 'SAVE_PROGRESS', message: '正在采集页面资源…' });
  var collected;
  try {
    collected = await tabsSend(tab.id, {
      type: 'CS_COLLECT',
      options: { banner: opts.banner, injectBase: opts.injectBase }
    });
  } catch (e) {
    // 典型场景：页面刚打开尚未就绪 / 被浏览器冻结 / SPA 刚导航删除了旧文档
    throw new Error('无法与页面建立通信，请刷新页面后重试（' + e.message + '）');
  }
  if (!collected || collected.error) {
    throw new Error((collected && collected.error) || '页面采集失败');
  }

  notify({ type: 'SAVE_PROGRESS', message: '正在生成快照文件…' });
  var html = collected.html;
  var filename = joinPath(opts.subdir, WSUtils.buildSnapshotFilename(tab.title, tab.url, 'html'));
  var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  var downloadId = await downloadBlob(blob, filename, opts.askLocation);

  return {
    filename: filename,
    bytes: blob.size,
    downloadId: downloadId,
    stats: collected.stats,
    warnings: collected.warnings || []
  };
}

/* ================================================================== */
/* 资源抓取（SW 侧）                                                     */
/* ================================================================== */

/**
 * 处理内容脚本的 CS_FETCH_ASSETS 请求：抓取全部资源并处理行内 CSS。
 * @param {{pageUrl: string, resources: Array, inlineCss: Array, inlineStyles: Array}} payload
 * @returns {Promise<{assets: Object, inlineCss: string[], inlineStyles: string[], warnings: string[]}>}
 */
async function handleFetchAssets(payload) {
  var settings = await getSettings();
  var ctx = {
    assets: {},                                     // 绝对URL -> {kind, dataUri?, text?}
    warnings: [],
    maxBytes: Math.max(1, settings.maxAssetMB || 12) * 1024 * 1024,
    totalBytes: 0
  };

  var resources = (payload && payload.resources) || [];

  // 1) 外链样式表：抓取 -> 展平 @import -> url() 内联为 dataUri
  var cssResources = resources.filter(function (r) { return r.kind === 'css'; });
  await WSUtils.mapLimit(cssResources, 4, async function (r) {
    var text = await fetchAndProcessCss(r.url, ctx, 3, new Set());
    if (text != null) ctx.assets[r.url] = { kind: 'css', text: text };
    else ctx.warnings.push('样式表下载失败：' + r.url);
  });

  // 2) 其它资源（图片/脚本/字体/媒体）：并发抓取
  var others = resources.filter(function (r) { return r.kind !== 'css'; });
  await WSUtils.mapLimit(others, 8, async function (r) {
    var asset = await fetchAsset(r.url, r.kind, ctx);
    if (asset) ctx.assets[r.url] = asset;
    else ctx.warnings.push('资源下载失败：' + r.url);
  });

  // 3) 行内 CSS / style 属性：同样走展平 + 内联管线（按请求顺序返回）
  var inlineCssTexts = [];
  for (var i = 0; i < (payload.inlineCss || []).length; i++) {
    inlineCssTexts.push(await processCssText(payload.inlineCss[i].text, payload.pageUrl, ctx));
  }
  var inlineStyleTexts = [];
  for (var j = 0; j < (payload.inlineStyles || []).length; j++) {
    inlineStyleTexts.push(await processCssText(payload.inlineStyles[j].text, payload.pageUrl, ctx));
  }

  return {
    assets: ctx.assets,
    inlineCss: inlineCssTexts,
    inlineStyles: inlineStyleTexts,
    warnings: ctx.warnings
  };
}

/**
 * 抓取单个资源（带缓存与体积上限）。
 * @param {string} url 绝对 URL
 * @param {string} kind image | js | css | media | asset
 * @param {Object} ctx 抓取上下文
 * @returns {Promise<{kind: string, dataUri?: string, text?: string}|null>}
 */
function fetchAsset(url, kind, ctx) {
  var key = url + '|' + kind;
  if (fetchCache.has(key)) return fetchCache.get(key);

  var p = (async function () {
    if (ctx.totalBytes > MAX_TOTAL_BYTES) {
      ctx.warnings.push('超出快照总大小上限，已跳过：' + url);
      return null;
    }
    var resp = await fetchWithFallback(url);
    if (!resp) return null;

    var contentType = resp.headers.get('content-type') || '';
    var buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.byteLength > ctx.maxBytes) {
      ctx.warnings.push('资源体积超过上限，已跳过：' + url);
      return null;
    }
    ctx.totalBytes += buf.byteLength;

    if (kind === 'js') {
      // JS 以文本形式内联（需按正确编码解码，否则中文注释/字符串会乱码）
      return { kind: 'js', text: WSUtils.decodeText(buf, contentType) };
    }
    var mime = (contentType.split(';')[0] || '').trim() ||
      WSUtils.guessMimeFromUrl(url) ||
      'application/octet-stream';
    return { kind: kind, dataUri: WSUtils.bufferToDataUri(buf, mime) };
  })().catch(function (err) {
    if (globalThis.console && console.warn) {
      console.warn('[snapshot] 抓取失败:', url, err && err.message);
    }
    return null;
  });

  // 缓存上限保护，防止长时间运行膨胀
  if (fetchCache.size > 500) fetchCache.clear();
  fetchCache.set(key, p);
  return p;
}

/**
 * 带降级的抓取：先尝试携带 Cookie（同源/需登录资源），
 * 跨域被拒后再尝试裸请求。
 * @param {string} url
 * @returns {Promise<Response|null>}
 */
async function fetchWithFallback(url) {
  try {
    var r1 = await fetch(url, { credentials: 'include', redirect: 'follow' });
    if (r1.ok) return r1;
  } catch (e) { /* 继续降级尝试 */ }
  try {
    var r2 = await fetch(url, { credentials: 'omit', redirect: 'follow' });
    if (r2.ok) return r2;
  } catch (e) { /* 忽略 */ }
  return null;
}

/**
 * 抓取并完整处理一个外链 CSS：解码 -> 展平 @import -> url() 内联。
 * @param {string} url CSS 绝对 URL
 * @param {Object} ctx 抓取上下文
 * @param {number} [depth=3] @import 剩余递归深度
 * @param {Set<string>} [visited] 共享的已访问集合（跨层级防循环引用）
 * @returns {Promise<string|null>} 处理后的 CSS 文本；失败返回 null
 */
async function fetchAndProcessCss(url, ctx, depth, visited) {
  var remain = depth == null ? 3 : depth;
  if (remain <= 0) return null; // 深度耗尽：不再深入抓取
  var resp = await fetchWithFallback(url);
  if (!resp) return null;
  var contentType = resp.headers.get('content-type') || '';
  var buf = new Uint8Array(await resp.arrayBuffer());
  if (buf.byteLength > ctx.maxBytes) {
    ctx.warnings.push('样式表体积超过上限，已跳过：' + url);
    return null;
  }
  return processCssText(WSUtils.decodeText(buf, contentType), url, ctx, remain, visited);
}

/**
 * 处理一段 CSS 文本（外链或行内均可）：
 *   1. 展平 @import（递归抓取并内联，深度 3，visited 防循环）；
 *   2. 下载其中 url() 引用的资源（字体/图片等）；
 *   3. 把 url() 重写为 dataUri（抓不到的保留原样，联网时仍生效）。
 * @param {string} cssText 原始 CSS 文本
 * @param {string} baseUrl 该 CSS 的基准 URL
 * @param {Object} ctx
 * @param {number} [depth=3] @import 剩余递归深度
 * @param {Set<string>} [visited] 共享的已访问集合
 * @returns {Promise<string>} 处理后的 CSS 文本
 */
async function processCssText(cssText, baseUrl, ctx, depth, visited) {
  var remain = depth == null ? 3 : depth;
  var css = await WSCss.flattenCssImports(cssText, baseUrl, function (importUrl, childDepth, seen) {
    return fetchAndProcessCss(importUrl, ctx, childDepth, seen);
  }, remain, visited);

  // 下载 url() 引用（已在 assets 中的跳过）
  var refs = WSCss.extractCssUrls(css);
  await WSUtils.mapLimit(refs, 6, async function (ref) {
    var abs = WSUtils.resolveUrl(baseUrl, ref);
    if (!abs || ctx.assets[abs]) return;
    var asset = await fetchAsset(abs, 'asset', ctx);
    if (asset) ctx.assets[abs] = asset;
    else ctx.warnings.push('资源下载失败：' + abs);
  });

  // 重写为 dataUri
  return WSCss.rewriteCssUrls(css, function (ref) {
    var abs = WSUtils.resolveUrl(baseUrl, ref);
    var a = abs && ctx.assets[abs];
    return a && a.dataUri ? a.dataUri : null;
  });
}

/* ================================================================== */
/* 下载（offscreen 文档代建 blob URL）                                    */
/* ================================================================== */

/**
 * offscreen 文档在扩展内的相对路径。
 * 该页面不在 manifest 注册，由 chrome.offscreen.createDocument 按需加载。
 */
var OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

/** offscreen 文档就绪状态（每个 SW 生命周期内维护；SW 重启后重置） */
var offscreenReady = false;

/** 等待 OFFSCREEN_READY 广播的回调队列 */
var offscreenReadyWaiters = [];

/** 下载串行锁：并发保存时避免前一次下载的收尾逻辑提前关闭 offscreen 文档 */
var downloadChain = Promise.resolve();

// 接收 offscreen 文档的就绪广播：SW 重启后文档可能已存在，靠它完成握手
chrome.runtime.onMessage.addListener(function (msg) {
  if (msg && msg.type === 'OFFSCREEN_READY') {
    offscreenReady = true;
    var waiters = offscreenReadyWaiters;
    offscreenReadyWaiters = [];
    waiters.forEach(function (fn) { fn(); });
  }
});

/**
 * 探测 offscreen 文档是否已存在。
 * @returns {Promise<boolean>}
 */
async function offscreenDocumentExists() {
  var url = chrome.runtime.getURL(OFFSCREEN_PATH);
  // Chrome 116+：getContexts 最准确
  if (typeof chrome.runtime.getContexts === 'function') {
    try {
      var ctxs = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [url]
      });
      return ctxs.length > 0;
    } catch (e) { /* 异常则降级 clients 探测 */ }
  }
  // 老版本：clients.matchAll（ServiceWorkerGlobalScope 全局可用）
  try {
    var clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    return clients.some(function (c) { return c.url === url; });
  } catch (e) {
    return false; // 探测失败按"不存在"处理，交给创建分支的异常兜底
  }
}

/**
 * 向 offscreen 文档发 PING 等 PONG（判断文档是否真的存活）。
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
function pingOffscreen(timeoutMs) {
  return new Promise(function (resolve) {
    var settled = false;
    var timer = setTimeout(function () {
      if (!settled) { settled = true; resolve(false); }
    }, timeoutMs || 3000);
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_PING' }, function (resp) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (chrome.runtime.lastError) resolve(false);
      else resolve(!!(resp && resp.pong));
    });
  });
}

/**
 * 确保 offscreen 文档存在且就绪（幂等，可反复调用）。
 *
 * 三种情况：
 *   1. 本 SW 生命周期内已知就绪 -> 直接返回；
 *   2. 文档已存在（SW 重启后的残留） -> PING 握手，通则复用，不通则关闭重建；
 *   3. 文档不存在 -> createDocument 并等待 READY 广播
 *      （createDocument 返回时页面脚本未必执行完，必须等广播）。
 *
 * @returns {Promise<void>}
 */
async function ensureOffscreenDocument() {
  if (offscreenReady) return;

  if (await offscreenDocumentExists()) {
    if (await pingOffscreen(3000)) {
      offscreenReady = true;
      return;
    }
    // 握手失败：文档已死但 Chrome 仍认为存在，强制关闭后走创建分支
    try { await chrome.offscreen.closeDocument(); } catch (e) { /* 忽略 */ }
  }

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['BLOBS'],
      justification: 'MV3 服务线程没有 URL.createObjectURL，需要 DOM 上下文创建 blob URL 以下载快照文件'
    });
  } catch (e) {
    // 并发场景下另一个调用可能刚创建成功
    if (!/only a single offscreen document/i.test(e.message || '')) {
      throw new Error('创建下载辅助文档失败：' + (e.message || e));
    }
  }

  if (!offscreenReady) {
    await new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        offscreenReadyWaiters = offscreenReadyWaiters.filter(function (fn) { return fn !== onReady; });
        reject(new Error('下载辅助文档就绪超时'));
      }, 8000);
      function onReady() {
        clearTimeout(timer);
        resolve();
      }
      offscreenReadyWaiters.push(onReady);
    });
  }
}

/**
 * 与 offscreen 文档做一次消息往返（Promise 化 + 超时保护）。
 * @param {Object} msg 消息体
 * @param {number} [timeoutMs] 超时毫秒数
 * @returns {Promise<any>}
 */
function offscreenRequest(msg, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var settled = false;
    var timer = setTimeout(function () {
      if (!settled) { settled = true; reject(new Error('下载辅助文档响应超时')); }
    }, timeoutMs || 20000);
    chrome.runtime.sendMessage(msg, function (resp) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(resp);
    });
  });
}

/**
 * 让 offscreen 文档回收 blob: URL（必须由创建方回收，SW 里回收无效）。
 * @param {string} url
 * @returns {Promise<void>}
 */
async function revokeOffscreenUrl(url) {
  try {
    await offscreenRequest({ type: 'OFFSCREEN_REVOKE', url: url }, 5000);
  } catch (e) { /* 回收失败仅损失少量内存，不影响下载结果 */ }
}

/** 关闭 offscreen 文档释放资源（每次下载收尾调用）。 */
async function closeOffscreenDocument() {
  try {
    await chrome.offscreen.closeDocument();
  } catch (e) { /* 文档可能已关闭 */ }
  offscreenReady = false;
}

/**
 * 读取 Blob 的文本内容（优先原生 Blob.text()，老内核退回 FileReader）。
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToText(blob) {
  if (blob && typeof blob.text === 'function') return blob.text();
  return new Promise(function (resolve, reject) {
    var fr = new FileReader();
    fr.onload = function () { resolve(fr.result); };
    fr.onerror = function () { reject(fr.error || new Error('读取文件内容失败')); };
    fr.readAsText(blob);
  });
}

/**
 * 读取 Blob 的 data: URL（无 offscreen API 时的降级下载方案）。
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToDataUrl(blob) {
  return new Promise(function (resolve, reject) {
    var fr = new FileReader();
    fr.onload = function () { resolve(fr.result); };
    fr.onerror = function () { reject(fr.error || new Error('读取文件内容失败')); };
    fr.readAsDataURL(blob);
  });
}

/**
 * 下载 Blob 到本地，返回 downloadId。
 *
 * MV3 服务线程没有 URL.createObjectURL，完整链路：
 *   1. ensureOffscreenDocument() 准备隐藏 DOM 文档；
 *   2. 把文件文本交给它创建 blob: URL（offscreen 上下文只暴露 chrome.runtime，
 *      不能自己调 chrome.downloads）；
 *   3. 回到 SW 调 chrome.downloads.download —— 官方推荐的 MV3 大文件下载模式，
 *      没有 data: URL 的约 2MB 长度上限；
 *   4. 等下载进入 complete / interrupted 后再回收 URL
 *      （提前回收会读到半截文件，这是已知坑）；
 *   5. 关闭 offscreen 文档。
 *
 * 无 offscreen API 的浏览器（如旧版 Firefox）降级为 data: URL 下载，
 * 超出 URL 长度上限时会失败并给出明确错误。
 *
 * @param {Blob} blob 文件内容
 * @param {string} filename 相对路径（如 webpage-snapshots/xxx.html）
 * @param {boolean} askLocation 是否弹出另存为对话框
 * @returns {Promise<number>} downloadId
 */
async function downloadBlob(blob, filename, askLocation) {
  // 串行化：避免两次保存并发时，前一次收尾（关闭 offscreen）打断后一次
  var run = downloadChain.then(function () {
    return downloadBlobOnce(blob, filename, askLocation);
  });
  downloadChain = run.catch(function () { /* 吞掉异常，防止串行链断裂 */ });
  return run;
}

/** downloadBlob 的单次执行体（被串行锁包住，内部不再并发）。 */
async function downloadBlobOnce(blob, filename, askLocation) {
  var mime = (blob && blob.type) || 'application/octet-stream';
  var text = await blobToText(blob);

  // 1+2. 通过 offscreen 文档创建 blob: URL
  var url = null;
  var viaOffscreen = typeof chrome.offscreen !== 'undefined';
  if (viaOffscreen) {
    try {
      await ensureOffscreenDocument();
      var resp = await offscreenRequest(
        { type: 'OFFSCREEN_MAKE_BLOB_URL', text: text, mime: mime },
        30000
      );
      if (resp && resp.url) {
        url = resp.url;
      } else {
        throw new Error((resp && resp.error) || '创建下载链接失败');
      }
    } catch (e) {
      // offscreen 链路异常时降级 data: URL（小文件仍可成功）
      viaOffscreen = false;
      url = null;
      console.warn('[下载] offscreen 链路失败，降级 data URL：', e && e.message);
    }
  }
  if (!url) {
    url = await blobToDataUrl(blob);
  }

  // 3. SW 侧发起下载
  var downloadId;
  try {
    downloadId = await chrome.downloads.download({
      url: url,
      filename: filename,
      saveAs: !!askLocation,
      conflictAction: 'uniquify' // 重名时自动追加序号，不覆盖旧快照
    });
  } catch (e) {
    if (viaOffscreen) await revokeOffscreenUrl(url);
    throw new Error('下载失败：' + (e && e.message ? e.message : e));
  }

  // 4. 等待下载结束（complete/interrupted）后再回收 URL
  await new Promise(function (resolve) {
    var finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve();
    }
    function onChanged(delta) {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete' || delta.state.current === 'interrupted') finish();
    }
    chrome.downloads.onChanged.addListener(onChanged);
    setTimeout(finish, 5 * 60 * 1000); // 兜底：异常也不会卡死保存流程
  });
  if (viaOffscreen) await revokeOffscreenUrl(url);

  // 5. 收尾：关闭 offscreen 文档
  if (viaOffscreen) await closeOffscreenDocument();
  return downloadId;
}

/* ================================================================== */
/* 历史记录（快照库数据源）                                               */
/* ================================================================== */

/**
 * 记录一条快照历史（成功/失败都记录，失败记录便于排查）。
 * @param {Object} entry
 * @returns {Promise<void>}
 */
async function recordHistory(entry) {
  var settings = await getSettings();
  if (!settings.recordHistory) return;
  var data = await chrome.storage.local.get('history');
  var list = Array.isArray(data.history) ? data.history : [];
  list.unshift(Object.assign({ id: WSUtils.uuid() }, entry));
  if (list.length > HISTORY_LIMIT) list.length = HISTORY_LIMIT;
  await chrome.storage.local.set({ history: list });
}

/**
 * "重新保存"：把当前标签页导航到原 URL，加载完成后再保存一次。
 * @param {string} url
 * @returns {Promise<void>}
 */
async function resaveUrl(url) {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  var tab = tabs && tabs[0];
  if (!tab) throw new Error('找不到当前标签页');
  await chrome.tabs.update(tab.id, { url: url });
  await waitForTabComplete(tab.id, 15000);
  var fresh = await chrome.tabs.get(tab.id);
  await saveFromTab(fresh, {});
}

/**
 * 轮询等待标签页加载完成（或超时）。
 * @param {number} tabId
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function waitForTabComplete(tabId, timeoutMs) {
  var deadline = Date.now() + (timeoutMs || 15000);
  return new Promise(function (resolve) {
    (function poll() {
      chrome.tabs.get(tabId, function (tab) {
        if ((tab && tab.status === 'complete') || Date.now() > deadline) resolve();
        else setTimeout(poll, 500);
      });
    })();
  });
}

/* ================================================================== */
/* 通知与徽标                                                            */
/* ================================================================== */

/**
 * 向所有扩展页面（popup/options）广播消息。
 * @param {Object} msg
 */
function notify(msg) {
  try {
    var maybe = chrome.runtime.sendMessage(msg);
    if (maybe && typeof maybe.catch === 'function') {
      maybe.catch(function () { /* 没有监听方时静默 */ });
    }
  } catch (e) { /* 忽略：没有页面在听 */ }
}

/** 保存期间显示徽标，给用户反馈。 */
function setBusy(on) {
  try {
    if (on) {
      chrome.action.setBadgeBackgroundColor({ color: '#315EFB' });
      chrome.action.setBadgeText({ text: '保存中' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch (e) { /* 忽略 */ }
}

/* ================================================================== */
/* 消息路由                                                              */
/* ================================================================== */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return false;

  switch (msg.type) {
    case 'POPUP_SAVE':
      chrome.tabs.get(msg.tabId, function (tab) {
        if (chrome.runtime.lastError) {
          notify({ type: 'SAVE_ERROR', error: chrome.runtime.lastError.message });
          return;
        }
        saveFromTab(tab, msg.options || {});
      });
      sendResponse({ accepted: true });
      return false;

    case 'CS_FETCH_ASSETS':
      handleFetchAssets(msg.payload).then(sendResponse, function (e) {
        sendResponse({ error: (e && e.message) || String(e) });
      });
      return true;

    case 'GET_HISTORY':
      chrome.storage.local.get('history', function (data) {
        sendResponse({ history: Array.isArray(data.history) ? data.history : [] });
      });
      return true;

    case 'DELETE_HISTORY':
      chrome.storage.local.get('history', function (data) {
        var list = Array.isArray(data.history) ? data.history : [];
        list = list.filter(function (item) { return item.id !== msg.id; });
        chrome.storage.local.set({ history: list }, function () {
          sendResponse({ ok: true });
        });
      });
      return true;

    case 'CLEAR_HISTORY':
      chrome.storage.local.set({ history: [] }, function () {
        sendResponse({ ok: true });
      });
      return true;

    case 'OPEN_DOWNLOAD':
      if (msg.downloadId != null) {
        chrome.downloads.show(msg.downloadId);
      } else if (msg.filename) {
        chrome.downloads.search({ query: [msg.filename] }, function (items) {
          if (items && items[0]) chrome.downloads.show(items[0].id);
        });
      }
      sendResponse({ ok: true });
      return false;

    case 'RESAVE_URL':
      resaveUrl(msg.url).catch(function (e) {
        notify({ type: 'SAVE_ERROR', error: (e && e.message) || String(e) });
      });
      sendResponse({ accepted: true });
      return false;

    default:
      return false;
  }
});

/* ================================================================== */
/* 内部工具                                                              */
/* ================================================================== */

/**
 * 拼接下载路径：清洗子目录与文件名中的非法分隔符。
 * @param {string} subdir 子目录名
 * @param {string} filename 文件名
 * @returns {string} 'subdir/filename'
 */
function joinPath(subdir, filename) {
  var dir = String(subdir || '').trim().replace(/^[\/\\]+/, '').replace(/[\/\\]+$/, '');
  var name = String(filename || 'snapshot.html').replace(/[\/\\]+/g, '_');
  return dir ? dir + '/' + name : name;
}
