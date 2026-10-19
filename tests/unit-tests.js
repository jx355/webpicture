'use strict';
/**
 * @file tests/unit-tests.js
 * @description 纯逻辑单元测试：src/lib/utils.js、src/lib/css-tools.js
 *              与 src/content/snapshot-content.js 的纯函数部分。
 *
 * 运行方式（零依赖，只用 Node 内置模块）：
 *   node tests/unit-tests.js
 *
 * 覆盖重点：
 *   - 编码解码（防乱码核心路径：Content-Type charset / BOM / CSS @charset / UTF-8 兜底）
 *   - URL 解析与文件名清洗
 *   - srcset 解析
 *   - 并发控制（保序 / 限流 / 失败隔离）
 *   - CSS url() 提取与重写、@import 展平（含循环引用与深度上限）
 *   - 内联转义（防 script/style 元素被裸闭合标签提前截断的回归测试）
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadLibs, PROJECT_ROOT } = require('./helpers/load-lib');

const sandbox = loadLibs([
  'src/lib/utils.js',
  'src/lib/css-tools.js',
  'src/content/snapshot-content.js'
]);
const WSUtils = sandbox.WSUtils;
const WSCss = sandbox.WSCss;
const WSSnapshot = sandbox.WSSnapshot;

/**
 * 跨 Realm 归一化：vm 沙箱里创建的对象带有沙箱 Realm 的原型，
 * 直接 deepStrictEqual 会因原型不同而失败，先用 JSON 往返转成宿主对象。
 * @param {*} value
 * @returns {*}
 */
function norm(value) {
  return JSON.parse(JSON.stringify(value));
}

/* ================================================================== */
/* 迷你测试框架（避免引入第三方测试库）                                  */
/* ================================================================== */
const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

async function run() {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log('  ok  ' + t.name);
    } catch (e) {
      failed++;
      console.log('  FAIL ' + t.name);
      console.log('       ' + (e && e.message ? e.message : e));
    }
  }
  console.log('\n单元测试：' + passed + ' 通过，' + failed + ' 失败');
  process.exit(failed > 0 ? 1 : 0);
}

/* ================================================================== */
/* 编码测试夹具（GBK / BOM 字节流，Node 的 Buffer 不支持 gbk 故用预制文件） */
/* ================================================================== */
const gbkWithCharset = fs.readFileSync(path.join(PROJECT_ROOT, 'tests/fixtures/gbk-sample.css'));
const gbkNoCharset = fs.readFileSync(path.join(PROJECT_ROOT, 'tests/fixtures/gbk-nocharset.css'));
const utf8Bom = fs.readFileSync(path.join(PROJECT_ROOT, 'tests/fixtures/utf8-bom.css'));

/* ================================================================== */
/* utils.js 测试                                                        */
/* ================================================================== */

test('resolveUrl：相对 / 绝对 / 越级 / 非法输入', () => {
  assert.strictEqual(WSUtils.resolveUrl('https://a.com/x/y.html', 'z.png'), 'https://a.com/x/z.png');
  assert.strictEqual(WSUtils.resolveUrl('https://a.com/x/y.html', '/z.png'), 'https://a.com/z.png');
  assert.strictEqual(WSUtils.resolveUrl('https://a.com/x/', '../z.png'), 'https://a.com/z.png');
  assert.strictEqual(WSUtils.resolveUrl('https://a.com/x/', 'https://b.com/1.png'), 'https://b.com/1.png');
  assert.strictEqual(WSUtils.resolveUrl('', 'z.png'), null);
  assert.strictEqual(WSUtils.resolveUrl('https://a.com', 'http://[bad'), null);
});

test('isSkippableUrl：伪协议与空值', () => {
  assert.strictEqual(WSUtils.isSkippableUrl(''), true);
  assert.strictEqual(WSUtils.isSkippableUrl('data:image/png;base64,AAA'), true);
  assert.strictEqual(WSUtils.isSkippableUrl('javascript:void(0)'), true);
  assert.strictEqual(WSUtils.isSkippableUrl('mailto:a@b.com'), true);
  assert.strictEqual(WSUtils.isSkippableUrl('https://a.com/x.png'), false);
  assert.strictEqual(WSUtils.isSkippableUrl('/assets/x.png'), false);
});

test('sanitizeFilename：非法字符 / 长度 / 空值回退', () => {
  assert.strictEqual(WSUtils.sanitizeFilename('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
  assert.strictEqual(WSUtils.sanitizeFilename('  多个   空格  '), '多个 空格');
  assert.strictEqual(WSUtils.sanitizeFilename(''), 'snapshot');
  assert.strictEqual(WSUtils.sanitizeFilename(null), 'snapshot');
  assert.strictEqual(WSUtils.sanitizeFilename('一二三四五六', 3), '一二三');
});

test('buildSnapshotFilename：格式与兜底', () => {
  const ts = new Date(2026, 0, 2, 3, 4, 5).getTime();
  assert.strictEqual(WSUtils.buildSnapshotFilename('测试页面', 'https://a.com/p/1', 'html', ts), '测试页面_20260102-030405.html');
  assert.strictEqual(WSUtils.buildSnapshotFilename('', 'https://a.com/p/1', 'mhtml', ts), 'a.com_20260102-030405.mhtml');
});

test('parseSrcset：候选拆分与描述符', () => {
  assert.deepStrictEqual(norm(WSUtils.parseSrcset('a.png 1x, b.png 2x')), [
    { url: 'a.png', descriptor: '1x' },
    { url: 'b.png', descriptor: '2x' }
  ]);
  assert.deepStrictEqual(norm(WSUtils.parseSrcset('a.png')), [{ url: 'a.png', descriptor: '' }]);
  assert.deepStrictEqual(norm(WSUtils.parseSrcset('')), []);
  assert.deepStrictEqual(norm(WSUtils.parseSrcset('a.png 100w, , b.png 200w')), [
    { url: 'a.png', descriptor: '100w' },
    { url: 'b.png', descriptor: '200w' }
  ]);
});

test('decodeText：@charset 嗅探识别 GBK（防乱码关键路径）', () => {
  const text = WSUtils.decodeText(new Uint8Array(gbkWithCharset), 'text/css');
  assert.ok(text.indexOf('中文测试') >= 0, '应按 @charset 正确解码 GBK');
  assert.ok(text.indexOf('@charset "GBK"') === 0);
  assert.ok(text.indexOf('\uFFFD') < 0, '不应出现替换字符');
});

test('decodeText：Content-Type charset 识别 GBK', () => {
  const text = WSUtils.decodeText(new Uint8Array(gbkNoCharset), 'text/css; charset=gbk');
  assert.ok(text.indexOf('中文测试') >= 0);
});

test('decodeText：UTF-8 BOM 识别', () => {
  const text = WSUtils.decodeText(new Uint8Array(utf8Bom), 'text/css');
  assert.ok(text.indexOf('中文') >= 0);
});

test('decodeText：无声明时 UTF-8 兜底且不抛异常', () => {
  const bytes = new Uint8Array(Buffer.from('hello 世界', 'utf8'));
  assert.strictEqual(WSUtils.decodeText(bytes, ''), 'hello 世界');
  const broken = new Uint8Array([0xFF, 0xFE, 0x00, 0x41]);
  assert.ok(typeof WSUtils.decodeText(broken, '') === 'string');
});

test('bufferToDataUri / bytesToBase64：往返一致', () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x00, 0x01]);
  const uri = WSUtils.bufferToDataUri(bytes, 'image/png');
  assert.strictEqual(uri, 'data:image/png;base64,' + WSUtils.bytesToBase64(bytes));
  const decoded = atob(uri.split(',')[1]);
  assert.deepStrictEqual(Array.from(decoded).map((c) => c.charCodeAt(0)), Array.from(bytes));
});

test('escapeHtml：转义全部危险字符', () => {
  assert.strictEqual(
    WSUtils.escapeHtml('<a href="x">&\''),
    '&lt;a href=&quot;x&quot;&gt;&amp;&#39;'
  );
});

test('formatBytes / formatTimestamp / byteLength', () => {
  assert.strictEqual(WSUtils.formatBytes(512), '512 B');
  assert.strictEqual(WSUtils.formatBytes(2048), '2.0 KB');
  assert.strictEqual(WSUtils.formatBytes(1024 * 1024 * 2), '2.00 MB');
  const d = new Date(2026, 8, 5, 7, 8, 9);
  assert.strictEqual(WSUtils.formatTimestamp(d.getTime()), '2026-09-05 07:08:09');
  assert.strictEqual(WSUtils.byteLength('中文'), 6);
  assert.strictEqual(WSUtils.byteLength('ab'), 2);
});

test('guessMimeFromUrl：扩展名映射', () => {
  assert.strictEqual(WSUtils.guessMimeFromUrl('https://a.com/x.PNG?v=1'), 'image/png');
  assert.strictEqual(WSUtils.guessMimeFromUrl('https://a.com/x.css'), 'text/css');
  assert.strictEqual(WSUtils.guessMimeFromUrl('https://a.com/x.woff2'), 'font/woff2');
  assert.strictEqual(WSUtils.guessMimeFromUrl('https://a.com/x'), null);
});

test('mapLimit：保序 / 限流 / 失败隔离', async () => {
  let running = 0;
  let maxRunning = 0;
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const results = await WSUtils.mapLimit(items, 3, async (n) => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((r) => setTimeout(r, 10));
    running--;
    if (n === 4) throw new Error('boom');
    return n * 2;
  });
  assert.strictEqual(maxRunning, 3, '并发不应超过限制');
  assert.deepStrictEqual(norm(results), [2, 4, 6, null, 10, 12, 14, 16]);
  const empty = await WSUtils.mapLimit([], 4, async (n) => n);
  assert.deepStrictEqual(norm(empty), []);
});

/* ================================================================== */
/* css-tools.js 测试                                                    */
/* ================================================================== */

test('extractCssUrls：提取 / 去重 / 跳过伪协议', () => {
  const css = '.a{background:url(a.png)} .b{background:url("b.png")} ' +
    '.c{background:url(a.png)} .d{background:url(data:image/png;base64,xx)}';
  assert.deepStrictEqual(norm(WSCss.extractCssUrls(css)), ['a.png', 'b.png']);
});

test('extractCssImports：url() 与字符串两种写法', () => {
  // 注意：CSS 规范中 @import 后必须跟 url(...) 或字符串，裸 URL 非法，不应匹配
  const css = '@import url("a.css"); @import \'b.css\' screen; @import url(c.css);';
  assert.deepStrictEqual(norm(WSCss.extractCssImports(css)), ['a.css', 'b.css', 'c.css']);
});

test('rewriteCssUrls：替换与保留降级', () => {
  const css = '.a{background:url(a.png)} .b{background:url(b.png)}';
  const out = WSCss.rewriteCssUrls(css, (u) => (u === 'a.png' ? 'data:image/png;base64,AAA' : null));
  assert.ok(out.indexOf('url("data:image/png;base64,AAA")') >= 0, '成功项应替换');
  assert.ok(out.indexOf('url(b.png)') >= 0, '失败项应保留原样');
});

test('flattenCssImports：基本展平', async () => {
  const fetched = { 'https://a.com/b.css': '.b{color:red}' };
  const css = '@import url("b.css");\n.a{color:blue}';
  const out = await WSCss.flattenCssImports(css, 'https://a.com/style.css', (u) => Promise.resolve(fetched[u] || null));
  assert.ok(out.indexOf('.b{color:red}') >= 0, '应内联被引入的 CSS');
  assert.ok(out.indexOf('@import') < 0, '不应残留 @import');
  assert.ok(out.indexOf('.a{color:blue}') >= 0, '原有内容应保留');
});

test('flattenCssImports：循环引用被打破（共享 visited）', async () => {
  // mock 自身递归调用 flattenCssImports，模拟 Service Worker 侧的递归展平
  const fetchCss = (url, depth, visited) => {
    const next = url.indexOf('b.css') >= 0 ? 'a.css' : 'b.css';
    const text = '@import url("' + next + '"); .x{color:red}';
    return WSCss.flattenCssImports(text, url, fetchCss, depth, visited);
  };
  const out = await WSCss.flattenCssImports('@import url("b.css");', 'https://a.com/a.css', fetchCss);
  assert.ok(out.indexOf('@import') < 0, '循环引用后不应残留 @import');
  assert.ok(out.indexOf('.x{color:red}') >= 0);
});

test('flattenCssImports：抓取失败保留原 @import（降级路径）', async () => {
  const out = await WSCss.flattenCssImports('@import url("b.css");', 'https://a.com/a.css', () => Promise.resolve(null));
  assert.ok(out.indexOf('@import url("b.css")') >= 0);
});

test('flattenCssImports：递归深度受限（<=3）', async () => {
  let calls = 0;
  const fetchCss = () => {
    calls++;
    return Promise.resolve('@import url("deep' + calls + '.css"); .x{color:red}');
  };
  await WSCss.flattenCssImports('@import url("deep0.css");', 'https://a.com/a.css', fetchCss);
  assert.ok(calls <= 3, '递归深度不应超过 3，实际 ' + calls);
});

/* ================================================================== */
/* snapshot-content.js 测试（内联转义防"元素被提前闭合"回归）              */
/* ================================================================== */

test('escapeScriptText：裸 </script 被转义为 <\/script', () => {
  assert.strictEqual(
    WSSnapshot.escapeScriptText('a</script>b'),
    'a<\\/script>b'
  );
  // 大小写不敏感（HTML 闭合标签不区分大小写）
  assert.strictEqual(
    WSSnapshot.escapeScriptText('a</SCRIPT>b'),
    'a<\\/SCRIPT>b'
  );
});

test('escapeScriptText：可重入（已转义文本不会二次替换）', () => {
  const once = WSSnapshot.escapeScriptText('a</script>b');
  assert.strictEqual(WSSnapshot.escapeScriptText(once), once);
});

test('escapeScriptText：document.write 动态脚本场景（百度实测模式）', () => {
  const js = 's.write("<script src=\'' + 'x.js\'></script>");';
  const out = WSSnapshot.escapeScriptText(js);
  assert.ok(out.indexOf('</script') < 0, '不应残留裸 </script');
  assert.ok(out.indexOf('<\\/script') >= 0, '应包含转义形式');
  // 语义等价：<\/ 在 JS 字符串中等价于 </
  assert.strictEqual(eval('"' + out.slice(out.indexOf('"') + 1, out.lastIndexOf('"')) + '"'), js.slice(js.indexOf('"') + 1, js.lastIndexOf('"')));
});

test('escapeCssText：裸 </style 被转义且可重入', () => {
  assert.strictEqual(WSSnapshot.escapeCssText('.a{content:"</style>"}'), '.a{content:"<\\/style>"}');
  const once = WSSnapshot.escapeCssText('.a{content:"</STYLE>"}');
  assert.strictEqual(WSSnapshot.escapeCssText(once), once);
});

/* ================================================================== */
run();
/* ================================================================== */
