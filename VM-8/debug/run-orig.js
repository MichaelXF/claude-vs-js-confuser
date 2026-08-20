// Run the obfuscated sample with a minimal browser shim to observe behavior.
const log = [];
function mkEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(), style: {}, children: [], attributes: {},
    innerHTML: '', textContent: '', className: '',
    appendChild(c){ this.children.push(c); log.push(['appendChild', this.tagName, c && c.tagName]); return c; },
    setAttribute(k,v){ this.attributes[k]=v; log.push(['setAttribute', this.tagName, k, v]); },
    getAttribute(k){ return this.attributes[k]; },
    addEventListener(t,f){ log.push(['addEventListener', this.tagName, t]); },
    querySelector(){ return null; }, querySelectorAll(){ return []; },
  };
  return el;
}
const document = {
  createElement(t){ log.push(['createElement', t]); return mkEl(t); },
  getElementById(id){ log.push(['getElementById', id]); return mkEl('div'); },
  querySelector(s){ log.push(['querySelector', s]); return mkEl('div'); },
  querySelectorAll(s){ log.push(['querySelectorAll', s]); return []; },
  addEventListener(t,f){ log.push(['doc.addEventListener', t]); },
  body: mkEl('body'), head: mkEl('head'),
  cookie: '', title: 'test',
};
globalThis.document = document;
globalThis.window = globalThis;
globalThis.navigator = { userAgent: 'node', language: 'en-US' };
globalThis.location = { href: 'http://example.com/', hostname: 'example.com', protocol:'http:' };
globalThis.alert = (...a)=>log.push(['alert',...a]);
globalThis.localStorage = { getItem:()=>null, setItem:()=>{}, removeItem:()=>{} };
globalThis.fetch = (...a)=>{ log.push(['fetch',...a]); return Promise.resolve({ json:()=>Promise.resolve({}), text:()=>Promise.resolve('') }); };
globalThis.setTimeout = setTimeout; globalThis.setInterval = ()=>0;

const origLog = console.log.bind(console);
console.log = (...a) => { log.push(['console.log', ...a]); origLog('[console.log]', ...a); };

try {
  require(require('path').resolve(__dirname,'..','input.js'));
} catch (e) {
  origLog('THREW:', e && e.stack || e);
}
origLog('--- event log ---');
for (const l of log) origLog(JSON.stringify(l));
