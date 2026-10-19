/**
 * @file tests/browser-e2e.mjs
 * @description 真实浏览器端到端验证（Playwright + Chromium）。
 *
 * 运行方式：
 *   PYTHON_BIN="<python路径>" node tests/browser-e2e.mjs
 *
 * 可选环境变量：
 *   E2E_REAL_SITE   真实网站用例地址（默认 https://www.baidu.com）
 *   PW_CORE_PATH    playwright-core 模块路径（默认按常见位置自动查找）
 *   PW_BROWSERS_PATH  Playwright 浏览器安装根目录（默认 ~/AppData/Local/ms-playwright）
 *
 * 覆盖两大部分：
 *   Part A  核心保存逻辑：在真实 Chromium 中加载演示页，注入扩展的 lib 与内容脚本，
 *           完整跑"采集 -> 抓取 -> 内嵌 -> 序列化 -> 回滚"流程并断言输出；
 *           （demo 页同源，页面内 fetch 即可，不依赖扩展消息通道）
 *   Part B  扩展集成：以 --load-extension 加载扩展，通过 POPUP_SAVE 消息触发保存，
 *           分别验证【演示页】与【真实网站】，确认历史记录、下载落地、内容正确。
 *
 * 说明：
 *   - Part A 用页面内 fetch 模拟 SW 抓取（同源无 CORS 问题）；
 *     Part B 走扩展真实链路（SW 凭 <all_urls> 特权跨域抓取），两者互补。
 *   - Part B 为什么用 POPUP_SAVE 消息而不是按 Alt+S：
 *     headless Chromium 不会向扩展分发快捷键命令（chrome.commands.onCommand 不触发，
 *     已实测确认），而 POPUP_SAVE 与点击弹窗"保存当前网页"按钮时 popup.js 发出的
 *     消息完全一致（同 type、同字段），走的仍是同一条 SW 链路，等价于真实用户操作。
 *   - Part B 为什么用 chrome.downloads.search 校验而不是找磁盘文件：
 *     Playwright 的 CDP 下载拦截层会把所有落盘文件改名为 GUID（真实浏览器不会），
 *     因此磁盘文件名不可直接断言；下载项状态（complete/字节数/byExtensionId）
 *     与历史记录里的 filename 字段才是可靠观测点。
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

/* ================================================================== */
/* 配置                                                                 */
/* ================================================================== */
const DEMO_PORT = 8899;
const REAL_SITE = process.env.E2E_REAL_SITE || 'https://www.baidu.com';
const PYTHON_BIN = process.env.PYTHON_BIN || 'python';

/** 断言结果收集 */
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? '  ok  ' : '  FAIL ') + name + (!ok && detail ? '\n       ' + detail : ''));
}

/* ================================================================== */
/* 环境解析                                                             */
/* ================================================================== */

/** 按优先级查找 playwright-core。 */
function loadPlaywright() {
  const candidates = [
    process.env.PW_CORE_PATH,
    'playwright-core',
    'C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright-core',
    path.join(os.homedir(), '.workbuddy/binaries/node/workspace/node_modules/playwright-core')
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      return require(c);
    } catch (e) { /* 尝试下一个 */ }
  }
  throw new Error('未找到 playwright-core，请通过 PW_CORE_PATH 指定');
}

/**
 * 查找可用的 Chrome 可执行文件。
 * 注意：必须用完整版 chromium（chrome.exe），headless shell 不支持加载扩展。
 */
function findChrome() {
  const roots = [
    process.env.PW_BROWSERS_PATH,
    path.join(os.homedir(), 'AppData/Local/ms-playwright'),
    path.join(os.homedir(), '.cache/ms-playwright')
  ].filter(Boolean);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let dirs = [];
    try {
      dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    } catch (e) { continue; }
    for (const d of dirs) {
      const candidates = [
        path.join(root, d, 'chrome-win64', 'chrome.exe'),
        path.join(root, d, 'chrome-win', 'chrome.exe'),
        path.join(root, d, 'chrome-linux', 'chrome'),
        path.join(root, d, 'chrome-mac', 'Chromium.app/Contents/MacOS/Chromium')
      ];
      for (const exe of candidates) {
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  return null;
}

/** Windows 路径转为 Chrome 启动参数友好的正斜杠形式。 */
function toArg(p) {
  return String(p).replace(/\\/g, '/');
}

/* ================================================================== */
/* demo 静态服务                                                        */
/* ================================================================== */

/** 启动 demo 目录的本地 HTTP 服务（保存流程需要 http 源）。 */
function startDemoServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      PYTHON_BIN,
      ['-m', 'http.server', String(DEMO_PORT), '--directory', path.join(PROJECT_ROOT, 'demo')],
      { stdio: 'ignore' }
    );
    child.on('error', (e) => reject(new Error('无法启动 demo 服务（' + PYTHON_BIN + '）：' + e.message)));
    const deadline = Date.now() + 20000;
    (async function poll() {
      while (Date.now() < deadline) {
        try {
          const r = await fetch('http://127.0.0.1:' + DEMO_PORT + '/utf8-page.html');
          if (r.ok) {
            resolve(child);
            return;
          }
        } catch (e) { /* 未就绪，重试 */ }
        await new Promise((r) => setTimeout(r, 400));
      }
      reject(new Error('demo 服务启动超时'));
    })();
  });
}

/* ================================================================== */
/* Part A：核心保存逻辑（页面内执行，验证真实引擎行为）                   */
/* ================================================================== */

/**
 * 在页面上下文里执行的完整保存流程。
 * 注意：本函数会被序列化后注入页面，【不能引用任何外部变量】，
 *       只能使用 window.WSUtils / window.WSCss / window.WSSnapshot（已提前注入）。
 */
async function runSavePipelineInPage() {
  const WSUtils = window.WSUtils;
  const WSCss = window.WSCss;
  const WSSnapshot = window.WSSnapshot;
  const pageUrl = location.href;
  const page = WSSnapshot.collectPage(document, pageUrl);

  const assets = {};
  const warnings = [];

  async function fetchBinary(url, kind) {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) return null;
    const ct = resp.headers.get('content-type') || '';
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (kind === 'js') return { kind: kind, text: WSUtils.decodeText(buf, ct) };
    const mime = (ct.split(';')[0] || '').trim() || WSUtils.guessMimeFromUrl(url) || 'application/octet-stream';
    return { kind: kind, dataUri: WSUtils.bufferToDataUri(buf, mime) };
  }

  // 与 Service Worker 的 processCssText 同逻辑：展平 @import -> 下载 url() -> 重写
  async function processCss(text, baseUrl, depth) {
    const remain = depth == null ? 3 : depth;
    const visited = new Set();
    const css = await WSCss.flattenCssImports(text, baseUrl, async (importUrl, childDepth, seen) => {
      if (childDepth <= 0) return null;
      const resp = await fetch(importUrl);
      if (!resp.ok) return null;
      const buf = new Uint8Array(await resp.arrayBuffer());
      return processCss(WSUtils.decodeText(buf, resp.headers.get('content-type') || ''), importUrl, childDepth);
    }, remain, visited);

    const refs = WSCss.extractCssUrls(css);
    await Promise.all(refs.map(async (ref) => {
      const abs = WSUtils.resolveUrl(baseUrl, ref);
      if (!abs || assets[abs]) return;
      const a = await fetchBinary(abs, 'asset');
      if (a) assets[abs] = a;
      else warnings.push('fail ' + abs);
    }));

    return WSCss.rewriteCssUrls(css, (ref) => {
      const abs = WSUtils.resolveUrl(baseUrl, ref);
      const a = abs && assets[abs];
      return a && a.dataUri ? a.dataUri : null;
    });
  }

  for (const r of page.resources) {
    if (r.kind === 'css') {
      const resp = await fetch(r.url);
      if (!resp.ok) {
        warnings.push('css fail ' + r.url);
        continue;
      }
      const buf = new Uint8Array(await resp.arrayBuffer());
      assets[r.url] = {
        kind: 'css',
        text: await processCss(WSUtils.decodeText(buf, resp.headers.get('content-type') || ''), r.url, 3)
      };
    } else {
      const a = await fetchBinary(r.url, r.kind);
      if (a) assets[r.url] = a;
      else warnings.push('fail ' + r.url);
    }
  }

  const cssTextById = {};
  for (const item of page.inlineCss) cssTextById[item.id] = await processCss(item.text, pageUrl, 3);
  for (const item of page.inlineStyles) cssTextById[item.id] = await processCss(item.text, pageUrl, 3);

  const ectx = { assets: assets, cssTextById: cssTextById, undo: [], warnings: warnings };
  let html = '';
  try {
    WSSnapshot.embedTree(ectx, page.tree);
    WSSnapshot.injectCharset(document, ectx);
    WSSnapshot.injectBase(document, pageUrl, ectx);
    WSSnapshot.injectBanner(document, { url: pageUrl, savedAt: Date.now() }, ectx);
    html = WSSnapshot.serializeDoc(document);
  } finally {
    WSSnapshot.rollback(ectx);
  }
  return { html: html, resourceCount: page.resources.length, warnings: warnings };
}

async function partA(chromium) {
  console.log('\n== Part A：核心保存逻辑（真实 Chromium 引擎，演示页）==');
  const browser = await chromium.launch({ headless: true, executablePath: findChrome() });
  try {
    const page = await browser.newPage();

    /* ---------- UTF-8 综合演示页 ---------- */
    await page.goto('http://127.0.0.1:' + DEMO_PORT + '/utf8-page.html', { waitUntil: 'load' });
    await page.waitForTimeout(800); // 等 app.js 把 #js-status 置为"已执行"
    await page.addScriptTag({ path: path.join(PROJECT_ROOT, 'src/lib/utils.js') });
    await page.addScriptTag({ path: path.join(PROJECT_ROOT, 'src/lib/css-tools.js') });
    await page.addScriptTag({ path: path.join(PROJECT_ROOT, 'src/content/snapshot-content.js') });

    const out = await page.evaluate(runSavePipelineInPage);
    console.log('        资源总数：' + out.resourceCount + '，警告 ' + out.warnings.length + ' 条');

    check('UTF-8 页：图片已内嵌为 data URI', out.html.includes('data:image/png;base64'));
    check('UTF-8 页：不再残留相对资源引用', !/src="assets\//.test(out.html) && !/href="assets\/style\.css"/.test(out.html));
    check('UTF-8 页：统一 UTF-8 声明', out.html.includes('<meta charset="utf-8">'));
    check('UTF-8 页：快照横幅已注入', out.html.includes('id="ws-snapshot-banner"') && out.html.includes('网页快照'));
    check('UTF-8 页：iframe 已递归内嵌（srcdoc）', out.html.includes('srcdoc=') && out.html.includes('同源 iframe 内容'));
    check('UTF-8 页：@import 展平内容可见', out.html.includes('imported-banner') && out.html.includes('@import 展平成功'));
    check('UTF-8 页：懒加载图片已补 src', /data:image\/png;base64,[A-Za-z0-9+/=]{100,}/.test(out.html));
    check('UTF-8 页：脚本执行态保留', out.html.includes('脚本已执行'));
    check('UTF-8 页：无乱码替换符', !out.html.includes('\uFFFD'));

    // 回滚验证：保存后用户页面必须恢复原状
    const restored = await page.evaluate(() => ({
      firstImgSrc: document.querySelector('.img-row img') ? document.querySelector('.img-row img').getAttribute('src') : null,
      lazySrc: document.querySelector('img.lazy') ? document.querySelector('img.lazy').getAttribute('src') : 'NO_ELEMENT',
      bannerGone: document.getElementById('ws-snapshot-banner') === null,
      bodyChildren: document.body.children.length
    }));
    check('UTF-8 页：保存后原页面已回滚', restored.firstImgSrc === 'assets/photo.png' && restored.lazySrc === null && restored.bannerGone,
      JSON.stringify(restored));

    /* ---------- GBK 编码演示页 ---------- */
    await page.goto('http://127.0.0.1:' + DEMO_PORT + '/gbk-page.html', { waitUntil: 'load' });
    await page.waitForTimeout(500);
    await page.addScriptTag({ path: path.join(PROJECT_ROOT, 'src/lib/utils.js') });
    await page.addScriptTag({ path: path.join(PROJECT_ROOT, 'src/lib/css-tools.js') });
    await page.addScriptTag({ path: path.join(PROJECT_ROOT, 'src/content/snapshot-content.js') });

    const gbkOut = await page.evaluate(runSavePipelineInPage);
    check('GBK 页：CSS 中文正确解码（@charset 嗅探）', gbkOut.html.includes('GBK 样式表生效'));
    check('GBK 页：正文中文无乱码', gbkOut.html.includes('网页快照、防乱码、自包含、离线访问'));
    check('GBK 页：标点符号完整', gbkOut.html.includes('《书名号》') && gbkOut.html.includes('——破折号'));
    check('GBK 页：统一 UTF-8 声明', gbkOut.html.includes('<meta charset="utf-8">'));
    check('GBK 页：无乱码替换符', !gbkOut.html.includes('\uFFFD'));
  } finally {
    await browser.close();
  }
}

/**
 * 剔除所有 <script>/<style> 元素（含内容），返回剩余的"可见文本"部分。
 * 按 HTML 规范的边界扫描实现：元素内容从开标签后开始、到第一个对应闭合标签结束，
 * 不受"属性值里含裸 > 导致正则误判"的影响（真实站点常见）。
 * @param {string} html
 * @returns {string}
 */
function stripCodeElements(html) {
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { out += html.slice(i); break; }
    out += html.slice(i, lt);
    const head = html.slice(lt, lt + 9).toLowerCase();
    const isCode = head.startsWith('<script') || head.startsWith('<style');
    if (isCode) {
      const tag = head.startsWith('<script') ? 'script' : 'style';
      // HTML 规范：代码元素的内容在第一个对应闭合标签处结束
      const close = html.toLowerCase().indexOf('</' + tag, lt + 7);
      if (close >= 0) {
        const closeEnd = html.indexOf('>', close);
        i = closeEnd >= 0 ? closeEnd + 1 : close + tag.length + 3;
        continue;
      }
    }
    out += '<';
    i = lt + 1;
  }
  return out;
}

/* ================================================================== */
/* Part B：扩展集成（加载扩展 + POPUP_SAVE 触发 + 下载校验）            */
/* ================================================================== */

async function partB(chromium) {
  console.log('\n== Part B：扩展集成（真实 Chromium 加载扩展）==');
  const extPath = PROJECT_ROOT;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-e2e-profile-'));

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    executablePath: findChrome(),
    args: [
      '--disable-extensions-except=' + toArg(extPath),
      '--load-extension=' + toArg(extPath),
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });

  /**
   * 打开扩展 options 页作为"控制台"（storage / tabs / runtime / downloads 都能用）。
   * @returns {Promise<import('playwright-core').Page>}
   */
  async function openConsole(extId) {
    const p = await context.newPage();
    await p.goto('chrome-extension://' + extId + '/src/options/options.html');
    return p;
  }

  /** 读取快照历史。 */
  function readHistory(consolePage) {
    return consolePage.evaluate(() => new Promise((resolve) => {
      chrome.storage.local.get('history', (d) => resolve(d.history || []));
    }));
  }

  /** 查询下载项列表。 */
  function queryDownloads(consolePage) {
    return consolePage.evaluate(() => new Promise((resolve) => {
      chrome.downloads.search({}, (list) => resolve(list || []));
    }));
  }

  /**
   * 触发一次保存并等待历史记录出现新条目。
   *
   * 为什么发消息而不按快捷键：headless Chromium 不向扩展分发快捷键命令
   * （chrome.commands.onCommand 不触发，已实测）；POPUP_SAVE 与点击弹窗
   * "保存当前网页"按钮时 popup.js 发出的消息完全一致，走的仍是同一条 SW 链路。
   *
   * @param {import('playwright-core').Page} consolePage options 控制台页
   * @param {string} urlPattern 目标标签页 URL 的正则（用于在全部标签页中定位）
   * @param {number} timeoutMs 等待历史记录的超时时间
   * @returns {Promise<Object|null>} 最新的历史记录条目
   */
  async function saveCurrentPage(consolePage, urlPattern, timeoutMs) {
    const startTs = Date.now();
    const triggered = await consolePage.evaluate(async (pat) => {
      const tab = await new Promise((resolve) => {
        chrome.tabs.query({}, (tabs) => {
          const hit = (tabs || []).find((t) => new RegExp(pat).test(t.url || ''));
          resolve(hit || null);
        });
      });
      if (!tab) return { ok: false, reason: '找不到匹配标签页: ' + pat };
      const resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'POPUP_SAVE', tabId: tab.id, options: { format: 'html', banner: true } },
          (r) => resolve(r)
        );
      });
      return { ok: true, resp };
    }, urlPattern);
    if (!triggered.ok) {
      check('触发保存（' + urlPattern + '）', false, triggered.reason);
      return null;
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const history = await readHistory(consolePage);
      const last = history[0];
      if (last && last.savedAt >= startTs) return last;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
  }

  /**
   * 校验下载项状态并读出快照文件内容。
   * 注意：Playwright 的 CDP 下载拦截会把落盘文件改名为 GUID（真实浏览器不会），
   * 因此不断言磁盘文件名，只断言下载项状态、字节数与文件内容。
   * @returns {Promise<string|null>} 文件内容（失败返回 null）
   */
  async function verifyDownload(consolePage, extId, entry, label) {
    await new Promise((r) => setTimeout(r, 2500)); // 等待下载状态收敛
    const items = await queryDownloads(consolePage);
    const mine = items.filter((it) => it.byExtensionId === extId);
    const pool = mine.length > 0 ? mine : items;
    const hit = pool
      .slice()
      .sort((a, b) => (b.endTime || b.startTime || 0) - (a.endTime || a.startTime || 0))[0];
    check(label + '：下载项由本扩展发起', mine.length > 0 && !!hit,
      hit ? 'byExtensionId=' + hit.byExtensionId : '未找到下载项');
    if (!hit) return null;
    check(label + '：下载已完成', hit.state === 'complete',
      'state=' + hit.state + (hit.error ? ' error=' + JSON.stringify(hit.error) : ''));
    check(label + '：下载字节数与历史记录一致', hit.bytesReceived === entry.bytes,
      hit.bytesReceived + ' vs ' + entry.bytes);
    let content = null;
    try {
      content = fs.readFileSync(hit.filename, 'utf8');
    } catch (e) {
      check(label + '：快照文件可读取', false, String(e.message));
      return null;
    }
    check(label + '：快照文件可读取', true,
      path.basename(hit.filename) + '（' + Math.round(content.length / 1024) + ' KB）');
    return content;
  }

  try {
    /* ---------- 等待扩展注册 ---------- */
    let extId = null;
    for (let i = 0; i < 40 && !extId; i++) {
      const workers = context.serviceWorkers();
      const sw = workers.find((w) => w.url().indexOf('service-worker.js') >= 0);
      if (sw) extId = new URL(sw.url()).host;
      else await new Promise((r) => setTimeout(r, 500));
    }
    if (!extId) throw new Error('扩展 Service Worker 未注册（manifest 或加载参数有问题？）');
    console.log('        扩展 ID：' + extId);

    const consolePage = await openConsole(extId);

    /* ---------- B1：演示页保存 ---------- */
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:' + DEMO_PORT + '/utf8-page.html', { waitUntil: 'load', timeout: 20000 });
    await page.waitForTimeout(800);

    const entry = await saveCurrentPage(consolePage, '127\\.0\\.0\\.1:' + DEMO_PORT + '/utf8-page\\.html', 60000);
    check('扩展保存演示页：历史记录保存成功', !!entry && entry.status === 'success', entry ? String(entry.error) : '超时无记录');
    if (entry && entry.status === 'success') {
      check('扩展保存演示页：未授权 pageCapture 时自动降级为单文件 HTML', entry.format === 'html', String(entry.format));
      check('扩展保存演示页：文件名带子目录与标题', /^webpage-snapshots\/.+\.html$/.test(entry.filename || ''), String(entry.filename));
      check('扩展保存演示页：字节数大于 0', entry.bytes > 0, String(entry.bytes));
      const html = await verifyDownload(consolePage, extId, entry, '扩展保存演示页');
      if (html) {
        check('扩展保存演示页：文件内容自包含（data URI）', html.includes('data:image/png;base64'));
        check('扩展保存演示页：文件内容中文无乱码', !html.includes('\uFFFD') && html.includes('网页快照演示页'));
        check('扩展保存演示页：统一 UTF-8 声明', html.includes('charset="utf-8"'));
        console.log('        演示页快照：' + Math.round(html.length / 1024) + ' KB，资源统计 ' + JSON.stringify(entry.stats || {}));
      }
    }

    /* ---------- B2：真实网站保存 ---------- */
    console.log('        正在打开真实网站：' + REAL_SITE);
    const page2 = await context.newPage();
    try {
      await page2.goto(REAL_SITE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      console.log('        页面加载提示：' + e.message + '（继续尝试保存）');
    }
    await page2.waitForTimeout(2500); // 等首屏资源与脚本稳定

    const realHost = new URL(REAL_SITE).host.replace(/\./g, '\\.');
    const entry2 = await saveCurrentPage(consolePage, realHost, 90000);
    check('真实网站保存（' + REAL_SITE + '）：历史记录保存成功', !!entry2 && entry2.status === 'success', entry2 ? String(entry2.error) : '超时无记录');
    if (entry2 && entry2.status === 'success') {
      check('真实网站保存：字节数大于 0', entry2.bytes > 0, String(entry2.bytes));
      const html2 = await verifyDownload(consolePage, extId, entry2, '真实网站保存');
      if (html2) {
        check('真实网站保存：输出为有效 HTML', /<html/i.test(html2) && html2.length > 2000);
        check('真实网站保存：含 UTF-8 声明', html2.includes('charset="utf-8"'));
        // 防乱码验收标准：正文可见文本（剔除 script/style）中不得出现 U+FFFD。
        // 背景：部分网站的外链脚本自身含非法 UTF-8 字节（百度首页某个 JS 实测含 5 个：
        // 以 charset=utf-8 提供，却在字符串字面量里带裸 0xFE/0xFF），浏览器解码同样
        // 产生 U+FFFD，快照忠实还原——这是源站缺陷，不是我们引入的乱码。
        // 用户看得见的正文无乱码，才是真正的验收标准。
        const visible2 = stripCodeElements(html2);
        const visibleFffd = (visible2.match(/\uFFFD/g) || []).length;
        check('真实网站保存：可见文本无乱码替换符', visibleFffd === 0,
          '可见文本中仍有 ' + visibleFffd + ' 个替换符');
        const totalFffd = (html2.match(/\uFFFD/g) || []).length;
        if (totalFffd > visibleFffd) {
          console.log('        说明：快照共有 ' + totalFffd + ' 个 U+FFFD，全部来自源站脚本自身的非法字节（浏览器解码同样如此），已全部位于 script/style 内');
        }
        const inlined = (html2.match(/data:[a-z]+\/[a-z0-9.+-]+;base64,/gi) || []).length;
        console.log('        真实网站快照：' + Math.round(html2.length / 1024) + ' KB，内嵌资源 ' + inlined + ' 个，警告 ' + (entry2.warnings || []).length + ' 条');
      }
    }
  } finally {
    await context.close();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
}

/* ================================================================== */
/* 主流程                                                               */
/* ================================================================== */

async function main() {
  const { chromium } = loadPlaywright();
  const chromeExe = findChrome();
  if (!chromeExe) throw new Error('未找到 Chrome 可执行文件，请设置 PW_BROWSERS_PATH');
  console.log('使用浏览器：' + chromeExe);

  const server = await startDemoServer();
  try {
    await partA(chromium);
    await partB(chromium);
  } finally {
    server.kill();
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n========================================');
  console.log('端到端验证：' + (results.length - failed.length) + ' / ' + results.length + ' 通过');
  if (failed.length > 0) {
    failed.forEach((f) => console.log('  FAIL ' + f.name));
    process.exit(1);
  }
  console.log('全部通过');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n端到端验证执行异常：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
