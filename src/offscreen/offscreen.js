/**
 * @file src/offscreen/offscreen.js
 * @description MV3 服务线程的 "DOM 替身"（offscreen 文档，reasons: ['BLOBS']）。
 *
 * 存在的原因：
 *   Chrome 已从 Service Worker 全局移除 URL.createObjectURL，
 *   而 chrome.downloads.download 需要一个可下载的 URL（data: 有约 2MB 长度上限，
 *   内嵌大量图片的快照轻松超限）。官方推荐的解法就是本文件所在的 offscreen 文档：
 *   在隐藏 DOM 上下文中创建 blob: URL，回传给 SW 用于下载。
 *
 * 严格纪律（踩过坑，勿破）：
 *   1. 本上下文【只有 chrome.runtime 可用】——offscreen 文档不暴露 chrome.downloads
 *      等绝大多数扩展 API，顶层直接引用会抛 TypeError 导致整个文档加载失败；
 *   2. 所有 chrome.* 引用都放在消息回调内部（延迟到运行时），绝不在顶层执行；
 *   3. 消息监听必须返回 true 才会保持异步响应通道；
 *   4. blob: URL 的作用域限定在创建它的上下文，因此回收也必须由本文件完成
 *      （SW 里调 URL.revokeObjectURL 对别的上下文创建的 URL 无效）。
 *
 * 消息协议（均通过 chrome.runtime 收发）：
 *   OFFSCREEN_READY        offscreen -> 全部上下文   文档加载完成广播
 *   OFFSCREEN_PING         SW -> 全部上下文          探测文档是否存活（响应 {pong:true}）
 *   OFFSCREEN_MAKE_BLOB_URL {text, mime} -> {url}    创建 blob: URL
 *   OFFSCREEN_REVOKE       {url} -> {ok:true}        回收 blob: URL
 */
(function () {
  'use strict';

  /**
   * 创建 blob: URL。
   * @param {string} text 文件内容（快照 HTML / MHTML 文本）
   * @param {string} mime MIME 类型
   * @returns {string} blob: URL
   */
  function makeBlobUrl(text, mime) {
    var blob = new Blob([text], { type: mime || 'application/octet-stream' });
    return URL.createObjectURL(blob);
  }

  /**
   * 回收 blob: URL（失败静默：回收不了最多少一点内存，不影响用户）。
   * @param {string} url
   */
  function revokeBlobUrl(url) {
    if (!url) return;
    try {
      URL.revokeObjectURL(url);
    } catch (e) { /* 已失效或从未创建成功，忽略 */ }
  }

  // 注意：chrome.* 一律在回调内部使用（见文件头纪律第 2 条）
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return false;

    if (msg.type === 'OFFSCREEN_PING') {
      sendResponse({ pong: true });
      return true;
    }

    if (msg.type === 'OFFSCREEN_MAKE_BLOB_URL') {
      try {
        sendResponse({ url: makeBlobUrl(msg.text, msg.mime) });
      } catch (e) {
        sendResponse({ error: (e && e.message) || String(e) });
      }
      return true;
    }

    if (msg.type === 'OFFSCREEN_REVOKE') {
      revokeBlobUrl(msg.url);
      sendResponse({ ok: true });
      return true;
    }

    // 其余消息（SAVE_PROGRESS / CS_COLLECT 等）与本文档无关，放行给其他监听方
    return false;
  });

  // 文档就绪广播：SW 重启后可能不知道文档已存在，靠这条消息完成握手
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' });
})();
