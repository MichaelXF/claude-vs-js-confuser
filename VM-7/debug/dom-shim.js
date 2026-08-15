// Minimal browser-ish shim, shared by tracing scripts.
function makeShim(log) {
  function rec(...a) { if (log) log.push(a); }
  function makeEl(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      nodeType: 1,
      style: {},
      children: [],
      childNodes: [],
      attributes: {},
      textContent: "",
      innerHTML: "",
      innerText: "",
      className: "",
      id: "",
      value: "",
      setAttribute(k, v) { this.attributes[k] = v; rec("setAttribute", this.tagName, k, v); },
      getAttribute(k) { return this.attributes[k]; },
      appendChild(c) { this.children.push(c); this.childNodes.push(c); rec("appendChild", this.tagName, c && (c.tagName || c.textContent)); return c; },
      removeChild(c) { rec("removeChild"); return c; },
      insertBefore(c) { rec("insertBefore"); return c; },
      addEventListener(t, fn) { rec("addEventListener", this.tagName, t); (this._ev || (this._ev = {}))[t] = fn; },
      removeEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      getElementsByTagName() { return []; },
      focus() {}, blur() {}, click() { rec("click", this.tagName); },
      classList: { add(...a) { rec("classList.add", ...a); }, remove() {}, toggle() {}, contains() { return false; } },
    };
    return el;
  }
  const document = {
    body: makeEl("body"),
    head: makeEl("head"),
    documentElement: makeEl("html"),
    title: "",
    createElement: (t) => { rec("createElement", t); return makeEl(t); },
    createTextNode: (t) => ({ nodeType: 3, textContent: t }),
    getElementById: (id) => { rec("getElementById", id); return null; },
    getElementsByClassName: (c) => { rec("getElementsByClassName", c); return []; },
    getElementsByTagName: (c) => { rec("getElementsByTagName", c); return []; },
    querySelector: (s) => { rec("querySelector", s); return null; },
    querySelectorAll: (s) => { rec("querySelectorAll", s); return []; },
    addEventListener: (t) => { rec("document.addEventListener", t); },
    write: (s) => rec("document.write", s),
    cookie: "",
  };
  const windowObj = {
    document,
    location: { href: "https://example.com/", hostname: "example.com", protocol: "https:", search: "", pathname: "/" },
    navigator: { userAgent: "node-shim", language: "en-US", platform: "node" },
    alert: (m) => rec("alert", m),
    prompt: (m) => { rec("prompt", m); return null; },
    confirm: (m) => { rec("confirm", m); return true; },
    addEventListener: (t) => rec("window.addEventListener", t),
    setTimeout: (fn, t) => { rec("setTimeout", t); return 0; },
    setInterval: (fn, t) => { rec("setInterval", t); return 0; },
    clearTimeout: () => {}, clearInterval: () => {},
    localStorage: { getItem: (k) => { rec("localStorage.getItem", k); return null; }, setItem: (k, v) => rec("localStorage.setItem", k, v), removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    fetch: (...a) => { rec("fetch", ...a); return Promise.resolve({ json: () => Promise.resolve({}), text: () => Promise.resolve("") }); },
    XMLHttpRequest: function () { rec("XMLHttpRequest"); this.open = () => {}; this.send = () => {}; this.setRequestHeader = () => {}; },
    screen: { width: 1920, height: 1080 },
    innerWidth: 1920, innerHeight: 1080,
  };
  windowObj.window = windowObj;
  windowObj.self = windowObj;
  windowObj.top = windowObj;
  return { window: windowObj, document, makeEl };
}
module.exports = { makeShim };
