'use strict';
/**
 * @file tests/helpers/load-lib.js
 * @description 测试辅助：在 vm 沙箱中加载扩展的经典脚本（src/lib/*.js），
 *              使其挂载到沙箱全局（WSUtils / WSCss），供单元测试直接调用。
 *
 * 为什么用 vm 而不是 require：
 *   源码是给浏览器用的经典脚本（IIFE + 全局挂载），不是 CommonJS 模块；
 *   vm 沙箱既能原样执行它们，又不污染 Node 全局，完美适配"零构建"约束。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/** 项目根目录（tests/helpers -> 项目根） */
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/**
 * 把多个经典脚本按顺序加载到同一个 vm 沙箱（共享全局，模拟浏览器加载顺序）。
 * @param {string[]} relPaths 相对于项目根目录的脚本路径，按依赖顺序排列
 * @returns {Object} 沙箱全局对象（WSUtils / WSCss 等挂载在它上面）
 */
function loadLibs(relPaths) {
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    ArrayBuffer,
    DataView,
    Promise,
    setTimeout,
    clearTimeout,
    // Node 18+ 已有全局 btoa/atob，这里显式提供以防运行环境差异
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary')
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);

  relPaths.forEach(function (rel) {
    const abs = path.join(PROJECT_ROOT, rel);
    const code = fs.readFileSync(abs, 'utf8');
    vm.runInContext(code, sandbox, { filename: abs });
  });
  return sandbox;
}

module.exports = { loadLibs, PROJECT_ROOT };
