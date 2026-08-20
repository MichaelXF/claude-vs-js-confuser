'use strict';
// Deterministic browser environment so that the obfuscated sample and the
// deobfuscated output can be compared byte for byte.
module.exports = function makeSandbox(seed) {
  const calls = [];
  let rndState = seed || 1;
  const rnd = () => {
    rndState = (Math.imul(rndState, 1103515245) + 12345) >>> 0;
    return rndState / 4294967296;
  };
  let widthCounter = 100;
  function mkEl(tag) {
    const el = {
      tagName: String(tag).toUpperCase(), style: {}, children: [], attributes: {},
      innerHTML: '', textContent: '', className: '',
      get offsetWidth() { return widthCounter; },
      appendChild(c) { calls.push(['appendChild', this.tagName, c && c.tagName]); this.children.push(c); return c; },
      setAttribute(k, v) { calls.push(['setAttribute', k, v]); this.attributes[k] = v; },
      getAttribute(k) { return this.attributes[k]; },
      addEventListener(t) { calls.push(['addEventListener', t]); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      remove() { calls.push(['remove', this.tagName]); },
    };
    return el;
  }
  const document = {
    createElement(tag) { calls.push(['createElement', tag]); return mkEl(tag); },
    getElementById(id) { calls.push(['getElementById', id]); return mkEl('div'); },
    querySelector(s) { calls.push(['querySelector', s]); return mkEl('div'); },
    querySelectorAll() { return []; },
    addEventListener(t) { calls.push(['doc.addEventListener', t]); },
    body: mkEl('body'), head: mkEl('head'), cookie: '', title: 'test',
  };
  const sandbox = {
    console: { log: (...a) => calls.push(['log', ...a.map(String)]), warn: () => {}, error: () => {} },
    document,
    navigator: { userAgent: 'node', language: 'en-US', platform: 'test' },
    location: { href: 'http://example.com/', hostname: 'example.com', protocol: 'http:' },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    alert: (...a) => calls.push(['alert', ...a.map(String)]),
    Math: Object.create(Math),
    Date: class FakeDate extends Date {
      static now() { return 1700000000000; }
    },
    JSON, Object, Array, String, Number, Boolean, Function, Symbol, Reflect, Proxy,
    Error, TypeError, RangeError, ReferenceError, SyntaxError, RegExp, Map, Set,
    WeakMap, WeakSet, Promise, Uint8Array, Uint32Array, Int32Array, ArrayBuffer, Buffer,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    module: { exports: {} }, exports: {},
    __calls: calls,
  };
  sandbox.Math.random = rnd;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  return sandbox;
};
