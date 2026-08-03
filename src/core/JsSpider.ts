import axios from 'axios';
import CryptoJS from 'crypto-js';
import * as cheerio from 'cheerio';
import type { ISpider } from './models';

// Node.js builtins - use require() at runtime since Vite doesn't bundle them
const vm: typeof import('vm') | undefined = (() => {
  try {
    if ((globalThis as any).require) {
      return (globalThis as any).require('vm');
    }
    return undefined;
  } catch {
    return undefined;
  }
})();

let nodeRequire: ((id: string) => any) | undefined;
try {
  if ((globalThis as any).require) {
    nodeRequire =
      (globalThis as any).require('module')?.createRequire?.(import.meta.url) ||
      (globalThis as any).require;
  }
} catch {
  nodeRequire = undefined;
}

let forge: any;
try {
  if ((globalThis as any).require) {
    forge = (globalThis as any).require('node-forge');
  }
} catch {
  forge = null;
}

// ─── Jinja2 template stub for cheerio.jinja2 ───────────────────────────────
// drpy2.min.js calls cheerio.jinja2(url, {fl: fl}) and
// cheerio.jinja2(rule.homeUrl, {rule: rule}) to render URL templates with
// Jinja2-style {{ var.prop }} syntax. The real implementation comes from
// drpy2's side-effect import modules (cLFE.js/kOUW.js/ucoN.js) which are
// stubbed as `void 0;` because down.nigx.cn is Cloudflare-blocked. This
// minimal stub handles variable substitution with dot notation, covering
// the common URL template use case.
function drpyJinja2(template: string, vars: any): string {
  if (!template || typeof template !== 'string') return template || '';
  vars = vars || {};
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, expr) => {
    const parts = expr.trim().split('.');
    let val: any = vars;
    for (const p of parts) {
      if (val == null) return '';
      val = val[p];
    }
    return val == null ? '' : String(val);
  });
}

// Wrap cheerio to add jinja2 method. `import * as cheerio` yields a namespace
// object with own enumerable properties; Object.assign copies them into a new
// mutable object so we can attach jinja2. This wrapper is used for both the
// sandbox global and __require__('cheerio') so drpy2 sees the same object.
const cheerioWithJinja: any = Object.assign({}, cheerio as any, {
  jinja2: drpyJinja2,
});

// ─── GitHub mirror fallback ────────────────────────────────────────────────
// Some GitHub acceleration proxies (e.g., git.yylx.win) may fail from the
// browser due to CORS, SSL, or network issues. When a fetch to a known proxy
// domain fails, we retry with alternative mirrors.
const GITHUB_MIRROR_CHAINS: string[][] = [
  // Each chain is a list of proxy domains that serve the same URL pattern:
  // https://{proxy}/{original-url}
  // We try them in order until one succeeds.
  ['git.yylx.win', 'gh-proxy.com', 'fastgit.cc'],
  // gh-proxy.net returns an HTML interstitial ("Loading...") instead of the
  // raw file content for some URLs. ghproxy.net serves the same URL pattern
  // and returns the actual file directly.
  ['gh-proxy.net', 'ghproxy.net'],
];

function rewriteUrlWithMirror(
  url: string,
  fromMirror: string,
  toMirror: string,
): string {
  // Replace the proxy domain in the URL
  const prefix = `https://${fromMirror}/`;
  if (url.startsWith(prefix)) {
    return `https://${toMirror}/` + url.slice(prefix.length);
  }
  return url;
}

// Detect HTML interstitial responses (e.g., gh-proxy.net's "Loading..." page).
// These return HTTP 200 but contain HTML, not the requested JS/JSON content.
// Treating them as failures lets fetchWithMirrorFallback try alternative mirrors.
function isHtmlInterstitial(body: string): boolean {
  if (!body || body.length === 0) return false;
  const trimmed = body.trimStart();
  // JS/JSON content never starts with <!DOCTYPE or <html
  return trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html');
}

async function fetchWithMirrorFallback(
  url: string,
  options: { responseType?: string; timeout?: number } = {},
): Promise<string> {
  // Try the original URL first
  try {
    const resp = await axios.get(url, {
      responseType: options.responseType || 'text',
      timeout: options.timeout || 15000,
    });
    const body =
      typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    if (body && body.length > 0 && !isHtmlInterstitial(body)) return body;
    if (isHtmlInterstitial(body)) {
      console.warn(
        `[JsSpider] ${url.substring(0, 80)} returned HTML interstitial, trying mirrors`,
      );
    }
  } catch (e: any) {
    // Fall through to mirror retry
    const errMsg = e.message || '';
    console.warn(
      `[JsSpider] fetch failed for ${url}: ${errMsg.substring(0, 100)}, trying mirrors`,
    );
  }

  // Find which mirror chain this URL belongs to and try alternatives
  for (const chain of GITHUB_MIRROR_CHAINS) {
    const matchedMirror = chain.find((m) => url.startsWith(`https://${m}/`));
    if (!matchedMirror) continue;

    for (const altMirror of chain) {
      if (altMirror === matchedMirror) continue;
      const altUrl = rewriteUrlWithMirror(url, matchedMirror, altMirror);
      try {
        const resp = await axios.get(altUrl, {
          responseType: options.responseType || 'text',
          timeout: options.timeout || 15000,
        });
        const body =
          typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
        if (body && body.length > 0 && !isHtmlInterstitial(body)) {
          console.log(
            `[JsSpider] mirror fallback: ${altMirror} succeeded for ${url.substring(0, 80)}...`,
          );
          return body;
        }
      } catch (e2: any) {
        console.warn(
          `[JsSpider] mirror ${altMirror} also failed: ${(e2.message || '').substring(0, 80)}`,
        );
      }
    }
  }

  throw new Error(`All mirrors failed for ${url}`);
}

// Like fetchWithMirrorFallback but skips the original URL (already known to fail)
async function fetchMirrorOnly(
  url: string,
  options: { responseType?: string; timeout?: number } = {},
): Promise<string> {
  for (const chain of GITHUB_MIRROR_CHAINS) {
    const matchedMirror = chain.find((m) => url.startsWith(`https://${m}/`));
    if (!matchedMirror) continue;

    for (const altMirror of chain) {
      if (altMirror === matchedMirror) continue;
      const altUrl = rewriteUrlWithMirror(url, matchedMirror, altMirror);
      try {
        const resp = await axios.get(altUrl, {
          responseType: options.responseType || 'text',
          timeout: options.timeout || 15000,
        });
        const body =
          typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
        if (body && body.length > 0 && !isHtmlInterstitial(body)) {
          console.log(
            `[JsSpider] mirror retry: ${altMirror} succeeded for ${url.substring(0, 80)}...`,
          );
          return body;
        }
      } catch (e2: any) {
        console.warn(
          `[JsSpider] mirror ${altMirror} also failed: ${(e2.message || '').substring(0, 80)}`,
        );
      }
    }
  }

  throw new Error(`All mirrors failed for ${url}`);
}

// ─── Module source cache (URL → transpiled source) ─────────────────────────
const moduleSourceCache: Map<string, string> = new Map();

// ─── drpy rule patches for broken upstream spiders ─────────────────────────
// Some drpy spiders reference sites that have changed their HTML structure
// since the spider was last updated. The `推荐` (recommendation) selectors
// no longer match, so homeContent returns classes but no videos.
// Each patch is applied AFTER drpy2's init() completes, overriding specific
// rule fields. Matching is by spider key (drpy_js_ prefix stripped).
//
// The optional `originHeaders` field registers per-origin header overrides
// via the `js:registerSpiderOriginHeaders` IPC. Browsers silently ignore
// `User-Agent` set via XHR.setRequestHeader() (forbidden header), so hosts
// that require a mobile UA (e.g., tuxiaobei.com returns 404 for desktop UA)
// need the override to be applied at the network layer in the main process.
const DRPY_RULE_PATCHES: Record<
  string,
  {
    reason: string;
    fields: Record<string, string>;
    originHeaders?: Record<string, Record<string, string>>;
  }
> = {
  // 兔小贝 (儿童): tuxiaobei.com homepage was redesigned and no longer has
  // `.pic-list.list-box .items` selectors. The /list/mip-data API still
  // returns JSON with video items. Point homeUrl at the儿歌 category API
  // and set 推荐 to `*` so drpy2 falls back to 一级 (json:data.items;...).
  //
  // Additionally, tuxiaobei.com returns 404 for desktop User-Agents, so we
  // register a mobile UA override for the origin. The XHR in drpy2's
  // `request()` cannot set User-Agent (browser forbidden header), so the
  // override must be applied at the network layer.
  儿童: {
    reason:
      'tuxiaobei.com 首页改版后 .pic-list.list-box 选择器失效；改用 /list/mip-data API + js 解析；tuxiaobei.com 对桌面 UA 返回 404，需注入移动端 UA；API 返回 JSONP 包裹 ({...})，需 strip 括号后 JSON.parse',
    fields: {
      homeUrl:
        'https://www.tuxiaobei.com/list/mip-data?typeId=2&page=1&callback=',
      推荐: '*',
      // API 返回 JSONP 格式：({"status":0,"data":{"items":[...]}})
      // json: 解析器无法处理前缀 ( 和后缀 )，改用 js: 手动 strip + JSON.parse
      // drpy2 的 homeVodParse 和 categoryParse 都在 __hostEval 后读取 VODS，
      // 所以 js: 代码必须显式设置 VODS（不仅设置 input）
      一级: 'js:var d=[];var resp=request(input);var data=JSON.parse(resp.replace(/^\\(/,"").replace(/\\);?\\s*$/,""));data.data.items.forEach(function(it){d.push({title:it.name,img:it.image,url:String(it.video_id),desc:it.duration_string})});VODS=d;input=d',
    },
    originHeaders: {
      'https://www.tuxiaobei.com': {
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36',
        Referer: 'https://www.tuxiaobei.com/',
      },
    },
  },
};

function applyDrpyRulePatch(
  key: string,
  context: import('vm').Context,
): boolean {
  // Strip drpy_js_ prefix if present
  const bareKey = key.startsWith('drpy_js_') ? key.substring(8) : key;
  const patch = DRPY_RULE_PATCHES[bareKey] || DRPY_RULE_PATCHES[key];
  if (!patch) return false;
  try {
    const fieldsJson = JSON.stringify(patch.fields);
    const vm = require('vm');
    vm.runInContext(`Object.assign(globalThis.rule, ${fieldsJson});`, context, {
      timeout: 2000,
    });
    console.log(
      `[JsSpider] applied drpy rule patch for ${key}: ${patch.reason}`,
    );

    // Register per-origin header overrides (e.g., mobile UA for hosts that
    // 404 on desktop UA). The XHR in drpy2's request() cannot set
    // User-Agent (browser forbidden header), so we route through the main
    // process network layer.
    if (patch.originHeaders) {
      let electronIPC: any = (globalThis as any).electronIPC;
      if (!electronIPC && typeof (globalThis as any).window !== 'undefined') {
        electronIPC = (globalThis as any).window.electronIPC;
      }
      if (!electronIPC) {
        try {
          if ((globalThis as any).require) {
            const { ipcRenderer } = (globalThis as any).require('electron');
            electronIPC = {
              invoke: (channel: string, ...args: any[]) =>
                ipcRenderer.invoke(channel, ...args),
            };
          }
        } catch {
          // No electron available
        }
      }
      if (electronIPC && typeof electronIPC.invoke === 'function') {
        for (const [origin, headers] of Object.entries(patch.originHeaders)) {
          electronIPC
            .invoke('js:registerSpiderOriginHeaders', origin, headers)
            .catch((e: any) => {
              console.warn(
                `[JsSpider] Failed to register origin headers for ${origin}: ${e.message}`,
              );
            });
        }
      } else {
        console.warn(
          `[JsSpider] electronIPC not available; cannot register origin headers for ${key}`,
        );
      }
    }
    return true;
  } catch (e: any) {
    console.warn(
      `[JsSpider] failed to apply drpy rule patch for ${key}: ${e.message}`,
    );
    return false;
  }
}

// ─── Prototype defineProperty neutralization ───────────────────────────────
// drpy2.min.js calls Object.defineProperty(Object.prototype, "myValues", {value:...,enumerable:false})
// without configurable:true. Since vm contexts share Object/Array/String with the
// host, the first call defines a non-configurable property; subsequent inits in
// different vm contexts fail with "Cannot redefine property". We rewrite these
// calls to __safeDP__, which forces configurable:true and swallows redefine errors.
function neutralizeProtoDefineProperty(code: string): string {
  return code.replace(
    /Object\.defineProperty\(\s*(Object\.prototype|String\.prototype|Array\.prototype|Number\.prototype|Boolean\.prototype|Function\.prototype)\s*,/g,
    '__safeDP__($1,',
  );
}

// ─── ESM → CJS transpilation ───────────────────────────────────────────────

function transpileESM(code: string): string {
  let out = code;

  // 1. import * as X from 'Y' (X can be unicode identifier)
  out = out.replace(
    /import\s+\*\s+as\s+([\w$]+)\s*from\s*['"]([^'"]+)['"]\s*;?/g,
    "const $1 = __require__('$2');",
  );

  // 2. import { X, Y } from 'Z'
  out = out.replace(
    /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]\s*;?/g,
    (_match, names: string, mod: string) => {
      return `const { ${names.trim()} } = __require__('${mod}');`;
    },
  );

  // 3b. import X, { Y } from 'Z'  (combined default + named, before plain default)
  out = out.replace(
    /import\s+([\w$]+)\s*,\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]\s*;?/g,
    (_match, defName: string, names: string, mod: string) => {
      return `const ${defName} = __require__('${mod}'); const { ${names.trim()} } = __require__('${mod}');`;
    },
  );

  // 3. import X from 'Y' (X can be unicode identifier like 模板, 模 etc.)
  // Use [^\s{,*]+ to match any non-whitespace, non-brace, non-comma, non-star identifier
  out = out.replace(
    /import\s+([^\s{,*][^\s{,]*)\s*from\s*['"]([^'"]+)['"]\s*;?/g,
    "const $1 = __require__('$2');",
  );

  // 3c. import 'Y' (side-effect import, also matches import"Y" without space)
  out = out.replace(/import\s*['"]([^'"]+)['"]\s*;?/g, "__require__('$1');");

  // 4. export default { ... } — replace with assignment to __exports__
  out = out.replace(/export\s+default\s*/g, '__exports_default__ = ');

  // 5. export function X() — replace with function + assignment
  out = out.replace(/export\s+function\s+(\w+)/g, 'function $1');
  // After each exported function, we'll add an assignment.
  // This is tricky for general cases. We handle the simple case:
  // export function X(...)  →  function X(...); __exports__.X = X
  // We add these assignments at the end via a second pass below.

  // 6. export const X =  →  const X = ; __exports__.X = X
  out = out.replace(/export\s+const\s+(\w+)\s*=/g, 'const $1 =');

  // Collect exported names for function/const exports
  const exportedFuncs: string[] = [];
  const exportedConsts: string[] = [];

  // Re-scan the original code for export function / export const to collect names
  const funcMatch = code.matchAll(/export\s+function\s+(\w+)/g);
  for (const m of funcMatch) exportedFuncs.push(m[1]);

  const constMatch = code.matchAll(/export\s+const\s+(\w+)/g);
  for (const m of constMatch) exportedConsts.push(m[1]);

  // Append export assignments
  let suffix = '';
  for (const fn of exportedFuncs) {
    suffix += `\n__exports__.${fn} = ${fn};`;
  }
  for (const cn of exportedConsts) {
    suffix += `\n__exports__.${cn} = ${cn};`;
  }

  // Handle export default: assign __exports_default__ to __exports__ and spider
  suffix += `
if (typeof __exports_default__ !== 'undefined') {
    if (typeof __exports_default__ === 'object' && __exports_default__ !== null) {
        Object.assign(__exports__, __exports_default__);
    } else {
        __exports__.default = __exports_default__;
    }
    __spider__ = __exports__;
}
`;

  return out + suffix;
}

// ─── Local stubs for known drpy2 URL modules ───────────────────────────────
// down.nigx.cn is frequently blocked by Cloudflare. These stubs provide
// minimal implementations of the drpy2 helper modules so spiders can still
// initialize and run when the real modules cannot be fetched.

const DRPY_MUBAN_STUB = `
var muban = {
  mxpro: {
    title: '',
    host: '',
    url: '/vodshow/fyclass--------fypage---.html',
    searchUrl: '/vodsearch/**----------fypage---.html',
    searchable: 2,
    quickSearch: 0,
    filterable: 1,
    class_parse: '.navbar-items li:gt(0):lt(10);a&&Text;a&&href;/(\\\\d+)',
    一级: '.module-items .module-item;a&&title;img&&data-src;.module-item-text&&Text;a&&href',
    二级: {
      title: 'h1&&Text;.module-info-tag&&Text',
      img: '.module-item-pic&&img&&data-src',
      desc: '.module-info-item:eq(4)&&Text;;;.module-info-item-content:eq(1)&&Text;.module-info-item-content:eq(0)&&Text',
      content: '.module-info-introduction&&Text',
      tabs: '.module-tab-item',
      lists: '.module-play-list:eq(#id) a',
      tab_text: 'body&&Text',
      list_text: 'body&&Text',
      list_url: 'a&&href'
    },
    搜索: '.module-items .module-search-item;a&&title;img&&data-src;.module-item-text&&Text;a&&href'
  },
  mxone: {
    title: '',
    host: '',
    url: '/vodshow/fyclass--------fypage---.html',
    searchUrl: '/vodsearch/**----------fypage---.html',
    searchable: 2,
    quickSearch: 0,
    filterable: 1,
    class_parse: '.nav-menu-items li:gt(0):lt(10);a&&Text;a&&href;/(\\\\d+)',
    一级: '.module-list .module-item;a&&title;img&&data-src;.module-item-text&&Text;a&&href',
    二级: {
      title: 'h1&&Text;.tag-link&&Text',
      img: '.module-item-pic&&img&&data-src',
      desc: '.video-info-items:eq(3)&&Text;;;.video-info-items:eq(1)&&Text;.video-info-items:eq(0)&&Text',
      content: '.video-info-content&&Text',
      tabs: '.module-tab-item',
      lists: '.module-player-list:eq(#id) a',
      tab_text: 'body&&Text',
      list_text: 'body&&Text',
      list_url: 'a&&href'
    },
    搜索: '.module-list .module-search-item;a&&title;img&&data-src;.module-item-text&&Text;a&&href'
  },
  首图: {
    title: '',
    host: '',
    url: '/list/fyclass-fypage.html',
    searchUrl: '/search.php?q=**',
    searchable: 2,
    quickSearch: 0,
    filterable: 0,
    class_parse: '.stui-header__menu li:gt(0):lt(10);a&&Text;a&&href;/(\\\\d+)',
    一级: '.stui-vodlist li;a&&title;a&&data-original;.pic-text&&Text;a&&href',
    二级: {
      title: 'h1&&Text;.stui-content__detail .data:eq(4)&&Text',
      img: '.stui-content__thumb .thumb&&data-original',
      desc: '.stui-content__detail .data:eq(1)&&Text;;;.stui-content__detail .data:eq(2)&&Text;.stui-content__detail .data:eq(0)&&Text',
      content: '.stui-content__desc&&Text',
      tabs: '.stui-pannel__head h3',
      lists: '.stui-content__playlist:eq(#id) li',
      tab_text: 'body&&Text',
      list_text: 'body&&Text',
      list_url: 'a&&href'
    },
    搜索: '.stui-vodlist li;a&&title;a&&data-original;.pic-text&&Text;a&&href'
  },
  海螺: {
    title: '',
    host: '',
    url: '/vodshow/fyclass--------fypage---.html',
    searchUrl: '/vodsearch/**----------fypage---.html',
    searchable: 2,
    quickSearch: 0,
    filterable: 1,
    class_parse: '.nav-menu-items li:gt(0):lt(10);a&&Text;a&&href;/(\\\\d+)',
    一级: '.module-list .module-item;a&&title;img&&data-src;.module-item-text&&Text;a&&href',
    二级: {
      title: 'h1&&Text;.tag-link&&Text',
      img: '.module-item-pic&&img&&data-src',
      desc: '.video-info-items:eq(3)&&Text;;;.video-info-items:eq(1)&&Text;.video-info-items:eq(0)&&Text',
      content: '.video-info-content&&Text',
      tabs: '.module-tab-item',
      lists: '.module-player-list:eq(#id) a',
      tab_text: 'body&&Text',
      list_text: 'body&&Text',
      list_url: 'a&&href'
    },
    搜索: '.module-list .module-search-item;a&&title;img&&data-src;.module-item-text&&Text;a&&href'
  },
  短视: {
    title: '',
    host: '',
    url: '/api.php/provide/vod/?ac=list&class=fyclass&page=fypage',
    searchUrl: '/api.php/provide/vod/?ac=list&wd=**&pg=fypage',
    searchable: 2,
    quickSearch: 0,
    filterable: 0,
    class_parse: 'js:var classes=[];input=JSON.parse(request(input)).class;input.forEach(it=>{classes.push({type_id:it.type_id,type_name:it.type_name})});input=classes',
    一级: 'js:var d=[];var input=JSON.parse(request(input)).list;d.forEach(function(it){d.push({title:it.vod_name,img:it.vod_pic,url:it.vod_id,desc:it.vod_remarks})});input=d',
    二级: 'js:var input=JSON.parse(request("https://v1.hhzy.com/api.php/provide/vod/?ac=detail&ids="+input)).list[0];input={title:input.vod_name,img:input.vod_pic,desc:input.vod_year+" "+input.vod_area+" "+input.vod_remarks,content:input.vod_content,category:input.vod_class}',
    搜索: 'js:var d=[];var input=JSON.parse(request(input)).list;d.forEach(function(it){d.push({title:it.vod_name,img:it.vod_pic,url:it.vod_id,desc:it.vod_remarks})});input=d'
  },
  vfed: {
    title: '',
    host: '',
    url: '/vodshow/fyclass--------fypage---.html',
    searchUrl: '/vodsearch/**----------fypage---.html',
    searchable: 2,
    quickSearch: 0,
    filterable: 1,
    class_parse: '.fed-pops-list li:gt(0):lt(10);a&&Text;a&&href;/(\\\\d+)',
    一级: '.fed-list-item;a&&title;a&&data-original;.fed-list-remarks&&Text;a&&href',
    二级: {
      title: 'h1&&Text;.fed-part-rows a:eq(3)&&Text',
      img: '.fed-list-item&&a&&data-original',
      desc: '.fed-part-rows:eq(3)&&Text;;;.fed-part-rows:eq(1)&&Text;.fed-part-rows:eq(0)&&Text',
      content: '.fed-part-es&&Text',
      tabs: '.fed-drop-boxs li',
      lists: '.fed-play-item:eq(#id) a',
      tab_text: 'body&&Text',
      list_text: 'body&&Text',
      list_url: 'a&&href'
    },
    搜索: '.fed-list-item;a&&title;a&&data-original;.fed-list-remarks&&Text;a&&href'
  },
  默认: {
    title: '',
    host: '',
    url: '',
    searchUrl: '',
    searchable: 2,
    quickSearch: 0,
    filterable: 1,
    class_parse: '',
    一级: '',
    二级: '',
    搜索: ''
  }
};

var 模板 = {
  getMubans: function() { return muban; },
  getMuban: function(key) { return muban[key] || muban['默认']; }
};

// CJS-style export (loadUrlModule runs raw code without transpileESM)
// Expose both as default and as direct properties so 'import 模板 from'
// (which becomes 'const 模板 = __require__(...)') yields an object with
// getMubans() - Android drpy2 calls 模板.getMubans() directly.
__exports__.default = 模板;
Object.assign(__exports__, 模板);
`;

const DRPY_GBK_TOOL_STUB = `
function gbkTool() {
  return {
    encode: function(s) { return s; },
    decode: function(s) { return s; }
  };
}
// CJS-style export
__exports__.gbkTool = gbkTool;
__exports__.default = { gbkTool: gbkTool };
`;

// ─── Stub for drpy-core-lite.min.js (drpy2 v3.9.52+) ──────────────────────
// Newer drpy2 versions (3.9.52+) bundle all dependencies into a single
// drpy-core-lite.min.js file and import them as:
//   import { cheerio, 妯℃澘 } from "./drpy-core-lite.min.js";
// 妯℃澘 is 模板 with GBK encoding corruption. This stub provides cheerio
// (the host-side cheerioWithJinja), 模板 (muban templates), and 妯℃澘
// (alias for 模板 so both names resolve correctly after ESM transpilation).
const DRPY_CORE_LITE_STUB = `
var muban = {
  mxpro: {
    title: '', host: '',
    url: '/vodshow/fyclass--------fypage---.html',
    searchUrl: '/vodsearch/**----------fypage---.html',
    searchable: 2, quickSearch: 0, filterable: 1,
    class_parse: '.navbar-items li:gt(0):lt(10);a&&Text;a&&href;/(\\\\d+)',
    一级: '.module-items .module-item;a&&title;img&&data-src;.module-item-text&&Text;a&&href',
    二级: {
      title: 'h1&&Text;.module-info-tag&&Text',
      img: '.module-item-pic&&img&&data-src',
      desc: '.module-info-item:eq(4)&&Text;;;.module-info-item-content:eq(1)&&Text;.module-info-item-content:eq(0)&&Text',
      content: '.module-info-introduction&&Text',
      tabs: '.module-tab-item', lists: '.module-play-list:eq(#id) a',
      tab_text: 'body&&Text', list_text: 'body&&Text', list_url: 'a&&href'
    },
    搜索: '.module-items .module-search-item;a&&title;img&&data-src;.module-item-text&&Text;a&&href'
  },
  mxone: {
    title: '', host: '',
    url: '/vodshow/fyclass--------fypage---.html',
    searchUrl: '/vodsearch/**----------fypage---.html',
    searchable: 2, quickSearch: 0, filterable: 1,
    class_parse: '.nav-menu-items li:gt(0):lt(10);a&&Text;a&&href;/(\\\\d+)',
    一级: '.module-list .module-item;a&&title;img&&data-src;.module-item-text&&Text;a&&href',
    二级: {
      title: 'h1&&Text;.tag-link&&Text',
      img: '.module-item-pic&&img&&data-src',
      desc: '.video-info-items:eq(3)&&Text;;;.video-info-items:eq(1)&&Text;.video-info-items:eq(0)&&Text',
      content: '.video-info-content&&Text',
      tabs: '.module-tab-item', lists: '.module-player-list:eq(#id) a',
      tab_text: 'body&&Text', list_text: 'body&&Text', list_url: 'a&&href'
    },
    搜索: '.module-list .module-search-item;a&&title;img&&data-src;.module-item-text&&Text;a&&href'
  },
  首图: {
    title: '', host: '',
    url: '/list/fyclass-fypage.html', searchUrl: '/search.php?q=**',
    searchable: 2, quickSearch: 0, filterable: 0,
    class_parse: '.stui-header__menu li:gt(0):lt(10);a&&Text;a&&href;/(\\\\d+)',
    一级: '.stui-vodlist li;a&&title;a&&data-original;.pic-text&&Text;a&&href',
    二级: {
      title: 'h1&&Text;.stui-content__detail .data:eq(4)&&Text',
      img: '.stui-content__thumb .thumb&&data-original',
      desc: '.stui-content__detail .data:eq(1)&&Text;;;.stui-content__detail .data:eq(2)&&Text;.stui-content__detail .data:eq(0)&&Text',
      content: '.stui-content__desc&&Text',
      tabs: '.stui-pannel__head h3', lists: '.stui-content__playlist:eq(#id) li',
      tab_text: 'body&&Text', list_text: 'body&&Text', list_url: 'a&&href'
    },
    搜索: '.stui-vodlist li;a&&title;a&&data-original;.pic-text&&Text;a&&href'
  },
  海螺: {
    title: '', host: '',
    url: '/vodshow/fyclass--------fypage---.html',
    searchUrl: '/vodsearch/**----------fypage---.html',
    searchable: 2, quickSearch: 0, filterable: 1,
    class_parse: '.nav-menu-items li:gt(0):lt(10);a&&Text;a&&href;/(\\\\d+)',
    一级: '.module-list .module-item;a&&title;img&&data-src;.module-item-text&&Text;a&&href',
    二级: {
      title: 'h1&&Text;.tag-link&&Text',
      img: '.module-item-pic&&img&&data-src',
      desc: '.video-info-items:eq(3)&&Text;;;.video-info-items:eq(1)&&Text;.video-info-items:eq(0)&&Text',
      content: '.video-info-content&&Text',
      tabs: '.module-tab-item', lists: '.module-player-list:eq(#id) a',
      tab_text: 'body&&Text', list_text: 'body&&Text', list_url: 'a&&href'
    },
    搜索: '.module-list .module-search-item;a&&title;img&&data-src;.module-item-text&&Text;a&&href'
  },
  短视: {
    title: '', host: '',
    url: '/api.php/provide/vod/?ac=list&class=fyclass&page=fypage',
    searchUrl: '/api.php/provide/vod/?ac=list&wd=**&pg=fypage',
    searchable: 2, quickSearch: 0, filterable: 0,
    class_parse: 'js:var classes=[];input=JSON.parse(request(input)).class;input.forEach(it=>{classes.push({type_id:it.type_id,type_name:it.type_name})});input=classes',
    一级: 'js:var d=[];var input=JSON.parse(request(input)).list;d.forEach(function(it){d.push({title:it.vod_name,img:it.vod_pic,url:it.vod_id,desc:it.vod_remarks})});input=d',
    二级: 'js:var input=JSON.parse(request("https://v1.hhzy.com/api.php/provide/vod/?ac=detail&ids="+input)).list[0];input={title:input.vod_name,img:input.vod_pic,desc:input.vod_year+" "+input.vod_area+" "+input.vod_remarks,content:input.vod_content,category:input.vod_class}',
    搜索: 'js:var d=[];var input=JSON.parse(request(input)).list;d.forEach(function(it){d.push({title:it.vod_name,img:it.vod_pic,url:it.vod_id,desc:it.vod_remarks})});input=d'
  },
  vfed: {
    title: '', host: '',
    url: '/vodshow/fyclass--------fypage---.html',
    searchUrl: '/vodsearch/**----------fypage---.html',
    searchable: 2, quickSearch: 0, filterable: 1,
    class_parse: '.fed-pops-list li:gt(0):lt(10);a&&Text;a&&href;/(\\\\d+)',
    一级: '.fed-list-item;a&&title;a&&data-original;.fed-list-remarks&&Text;a&&href',
    二级: {
      title: 'h1&&Text;.fed-part-rows a:eq(3)&&Text',
      img: '.fed-list-item&&a&&data-original',
      desc: '.fed-part-rows:eq(3)&&Text;;;.fed-part-rows:eq(1)&&Text;.fed-part-rows:eq(0)&&Text',
      content: '.fed-part-es&&Text',
      tabs: '.fed-drop-boxs li', lists: '.fed-play-item:eq(#id) a',
      tab_text: 'body&&Text', list_text: 'body&&Text', list_url: 'a&&href'
    },
    搜索: '.fed-list-item;a&&title;a&&data-original;.fed-list-remarks&&Text;a&&href'
  },
  默认: {
    title: '', host: '', url: '', searchUrl: '',
    searchable: 2, quickSearch: 0, filterable: 1,
    class_parse: '', 一级: '', 二级: '', 搜索: ''
  }
};

var 模板 = {
  getMubans: function() { return muban; },
  getMuban: function(key) { return muban[key] || muban['默认']; }
};

// drpy2 v3.9.52+ imports 模板 under a GBK-corrupted name.
// We export it via bracket notation with Unicode escapes to avoid
// encoding issues. The corrupted name is U+592F U+2103 U+6FA0.
var _mubanAlias = 模板;

// Export cheerio (host-side), 模板, and the GBK-corrupted alias
__exports__.cheerio = __cheerio__;
__exports__.模板 = 模板;
__exports__['\\u592f\\u2103\\u6fa0'] = _mubanAlias;
__exports__.default = { cheerio: __cheerio__, 模板: 模板 };
`;

/**
 * Return a local stub source string for known drpy2 URL modules.
 * Returns null if no stub is available for the URL.
 */
function getLocalStubForUrl(url: string): string | null {
  // Match by filename to be robust against host changes
  if (url.includes('/XUKQ.js') || url.endsWith('XUKQ.js')) {
    return DRPY_MUBAN_STUB;
  }
  if (url.includes('/wYCz.js') || url.endsWith('wYCz.js')) {
    return DRPY_GBK_TOOL_STUB;
  }
  // drpy2 v3.9.52+ bundles all deps into drpy-core-lite.min.js
  // import { cheerio, 妯℃澘 } from "./drpy-core-lite.min.js"
  if (
    url.includes('drpy-core-lite.min.js') ||
    url.endsWith('drpy-core-lite.min.js')
  ) {
    return DRPY_CORE_LITE_STUB;
  }
  // Side-effect imports (cLFE.js, kOUW.js, ucoN.js) — empty stub is fine.
  // Use `void 0;` (not a `//` comment) because the stub is wrapped as
  // `(function() { ... ${stub} })();` — a `//` comment would swallow the
  // closing `})();` and cause "Unexpected end of input".
  if (
    url.includes('/cLFE.js') ||
    url.includes('/kOUW.js') ||
    url.includes('/ucoN.js')
  ) {
    return 'void 0;';
  }
  return null;
}

// ─── Bytecode decode ────────────────────────────────────────────────────────

function decodeBytecode(code: string): string {
  if (code.startsWith('//bb')) {
    const b64 = code.substring(4).trim();
    const raw = Buffer.from(b64, 'base64');
    // Strip first 4 bytes
    return raw.subarray(4).toString('utf-8');
  }
  if (code.startsWith('//DRPY')) {
    const b64 = code.substring(6).trim();
    // URL-safe base64 → standard base64
    const std = b64.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(std, 'base64').toString('utf-8');
  }
  return code;
}

// ─── HTML Parsing helpers (matching Android Global.java) ────────────────────

/**
 * Apply a single CSS rule step on a cheerio selection.
 * Returns a new cheerio selection.
 */
function applyCssStep(
  _$: cheerio.CheerioAPI,
  sel: cheerio.Cheerio<any>,
  step: string,
): cheerio.Cheerio<any> {
  if (!step) return sel;
  // :eq(N) support
  const eqMatch = step.match(/^(.+):eq\((\d+)\)$/);
  if (eqMatch) {
    return sel.find(eqMatch[1]).eq(parseInt(eqMatch[2]));
  }
  return sel.find(step);
}

/**
 * pdfh - parse single element, return text/attribute value.
 *
 * Rule syntax uses && as step separator, || as OR separator.
 * Special last-step keywords: Text, Html, href, src, data-original, @attr
 * style&&url(regex) extracts URL from style using regex.
 */
function pdfh(html: string, rule: string): string {
  if (!rule || !html) return '';
  const $ = cheerio.load(html);

  // OR logic: try each option, return first non-empty
  const orOptions = rule
    .split('||')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const option of orOptions) {
    try {
      const result = applyPdfhRule($, option);
      if (result) return result;
    } catch {
      /* try next */
    }
  }
  return '';
}

function applyPdfhRule($: cheerio.CheerioAPI, rule: string): string {
  const steps = rule
    .split('&&')
    .map((s) => s.trim())
    .filter(Boolean);
  if (steps.length === 0) return '';

  let sel: cheerio.Cheerio<any> = $.root();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // Last step special keywords
    if (i === steps.length - 1) {
      const lower = step.toLowerCase();

      // style&&url(regex) pattern
      if (lower.startsWith('url(') && lower.endsWith(')')) {
        const regexStr = step.substring(4, step.length - 1);
        try {
          const re = new RegExp(regexStr);
          const styleVal = sel.attr('style') || sel.text() || '';
          const m = styleVal.match(re);
          return m ? m[1] || m[0] : '';
        } catch {
          return '';
        }
      }

      if (lower === 'text') return sel.text().trim();
      if (lower === 'html') return sel.html() || '';
      if (lower === 'innerhtml') return sel.html() || '';
      if (lower === 'href') return sel.attr('href') || '';
      if (lower === 'src') return sel.attr('src') || '';
      if (lower === 'data-original') return sel.attr('data-original') || '';
      if (lower === 'data-src') return sel.attr('data-src') || '';
      if (lower === 'title') return sel.attr('title') || sel.text().trim();
      if (lower === 'alt') return sel.attr('alt') || '';
      if (lower === 'style') return sel.attr('style') || '';
      // @attr
      if (step.startsWith('@')) {
        return sel.attr(step.substring(1)) || '';
      }
      // Tag name (e.g., a, img)
      if (/^[a-zA-Z][a-zA-Z0-9]*$/.test(step) && step.toUpperCase() === step) {
        // All caps = tag name, find within
        const found = sel.find(step);
        return found.text().trim();
      }
    }

    // Not last step, or last step is a CSS selector
    sel = applyCssStep($, sel, step);
  }

  // Default: return text
  return sel.text().trim();
}

/**
 * pdfa - parse array of elements, return array of outer HTML strings.
 * All steps except last narrow context; last step selects the array.
 */
function pdfa(html: string, rule: string): string[] {
  if (!rule || !html) return [];
  const $ = cheerio.load(html);
  const steps = rule
    .split('&&')
    .map((s) => s.trim())
    .filter(Boolean);
  if (steps.length === 0) return [];

  let sel: cheerio.Cheerio<any> = $.root();

  // All but last step narrow the context
  for (let i = 0; i < steps.length - 1; i++) {
    sel = applyCssStep($, sel, steps[i]);
  }

  // Last step selects the array
  const lastStep = steps[steps.length - 1];
  const elements = applyCssStep($, sel, lastStep);

  const results: string[] = [];
  elements.each((_i, el) => {
    results.push($(el).toString());
  });
  return results;
}

/**
 * pd - parse URL from element, resolving relative to addUrl.
 */
function pd(html: string, rule: string, addUrl?: string): string {
  if (!rule || !html) return '';
  const $ = cheerio.load(html);

  const orOptions = rule
    .split('||')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const option of orOptions) {
    try {
      const result = applyPdRule($, option, addUrl);
      if (result) return result;
    } catch {
      /* try next */
    }
  }
  return '';
}

function applyPdRule(
  $: cheerio.CheerioAPI,
  rule: string,
  addUrl?: string,
): string {
  const steps = rule
    .split('&&')
    .map((s) => s.trim())
    .filter(Boolean);
  if (steps.length === 0) return '';

  let sel: cheerio.Cheerio<any> = $.root();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    if (i === steps.length - 1) {
      const lower = step.toLowerCase();

      // style&&url(regex)
      if (lower.startsWith('url(') && lower.endsWith(')')) {
        const regexStr = step.substring(4, step.length - 1);
        try {
          const re = new RegExp(regexStr);
          const styleVal = sel.attr('style') || sel.text() || '';
          const m = styleVal.match(re);
          const url = m ? m[1] || m[0] : '';
          return url ? joinUrl(addUrl || '', url) : '';
        } catch {
          return '';
        }
      }

      // Attribute extraction for URL-like attributes
      let url = '';
      if (lower === 'href') url = sel.attr('href') || '';
      else if (lower === 'src') url = sel.attr('src') || '';
      else if (lower === 'data-original') url = sel.attr('data-original') || '';
      else if (lower === 'data-src') url = sel.attr('data-src') || '';
      else if (step.startsWith('@')) url = sel.attr(step.substring(1)) || '';
      else {
        // It's a CSS selector, find element then get its URL attribute
        const found = applyCssStep($, sel, step);
        url =
          found.attr('href') ||
          found.attr('src') ||
          found.attr('data-original') ||
          found.attr('data-src') ||
          '';
      }

      if (url && addUrl) {
        return joinUrl(addUrl, url);
      }
      return url;
    }

    sel = applyCssStep($, sel, step);
  }

  // Default: try href/src
  const url = sel.attr('href') || sel.attr('src') || '';
  return url && addUrl ? joinUrl(addUrl, url) : url;
}

/**
 * pdfla - parse list of items with separate text/url rules.
 */
function pdfla(
  html: string,
  p1: string,
  listText: string,
  listUrl: string,
  addUrl?: string,
): Array<{ name: string; url: string }> {
  const items = pdfa(html, p1);
  return items.map((item) => ({
    name: pdfh(item, listText),
    url: pd(item, listUrl, addUrl),
  }));
}

// ─── URL helpers ────────────────────────────────────────────────────────────

function joinUrl(parent: string, child: string): string {
  if (!child) return '';
  if (/^https?:\/\//i.test(child)) return child;
  if (child.startsWith('//')) return 'https:' + child;
  if (child.startsWith('/')) {
    try {
      const base = new URL(parent);
      return base.origin + child;
    } catch {
      return child;
    }
  }
  try {
    return new URL(child, parent).href;
  } catch {
    return child;
  }
}

// ─── Crypto helpers ─────────────────────────────────────────────────────────

function aesX(
  mode: string,
  encrypt: boolean,
  input: string,
  inBase64: boolean,
  key: string,
  iv: string,
  outBase64: boolean,
): string {
  try {
    const parsedKey = CryptoJS.enc.Utf8.parse(key);
    const parsedIv = iv ? CryptoJS.enc.Utf8.parse(iv) : undefined;
    const src = inBase64
      ? CryptoJS.enc.Base64.parse(input)
      : CryptoJS.enc.Utf8.parse(input);

    const modeMap: Record<string, typeof CryptoJS.mode.CBC> = {
      CBC: CryptoJS.mode.CBC,
      ECB: CryptoJS.mode.ECB,
      CFB: CryptoJS.mode.CFB,
      OFB: CryptoJS.mode.OFB,
      CTR: CryptoJS.mode.CTR,
    };

    const cipherMode = modeMap[mode] || CryptoJS.mode.CBC;
    const pad = CryptoJS.pad.Pkcs7;

    if (encrypt) {
      const encrypted = CryptoJS.AES.encrypt(src, parsedKey, {
        iv: parsedIv,
        mode: cipherMode,
        padding: pad,
      });
      return outBase64
        ? encrypted.ciphertext.toString(CryptoJS.enc.Base64)
        : encrypted.ciphertext.toString(CryptoJS.enc.Hex);
    } else {
      const decrypted = CryptoJS.AES.decrypt(
        { ciphertext: src } as any,
        parsedKey,
        {
          iv: parsedIv,
          mode: cipherMode,
          padding: pad,
        },
      );
      return outBase64
        ? CryptoJS.enc.Base64.stringify(decrypted)
        : decrypted.toString(CryptoJS.enc.Utf8);
    }
  } catch (e) {
    console.error('[aesX] error:', e);
    return '';
  }
}

function rsaX(
  mode: string,
  pub: string,
  encrypt: boolean,
  input: string,
  inBase64: boolean,
  key: string,
  outBase64: boolean,
): string {
  if (!forge) {
    console.warn('[rsaX] node-forge not available');
    return '';
  }
  try {
    let inputData = inBase64
      ? forge.util.decode64(input)
      : forge.util.encodeUtf8(input);

    let rsaKey;
    if (pub === '1') {
      rsaKey = forge.pki.publicKeyFromPem(
        key.startsWith('-----')
          ? key
          : '-----BEGIN PUBLIC KEY-----\n' + key + '\n-----END PUBLIC KEY-----',
      );
    } else {
      rsaKey = forge.pki.privateKeyFromPem(
        key.startsWith('-----')
          ? key
          : '-----BEGIN RSA PRIVATE KEY-----\n' +
              key +
              '\n-----END RSA PRIVATE KEY-----',
      );
    }

    if (encrypt) {
      const encrypted = rsaKey.encrypt(
        inputData,
        mode === 'oaep' ? 'RSA-OAEP' : 'RSAES-PKCS1-V1_5',
      );
      return outBase64
        ? forge.util.encode64(encrypted)
        : forge.util.bytesToHex(encrypted);
    } else {
      const decrypted = rsaKey.decrypt(
        inputData,
        mode === 'oaep' ? 'RSA-OAEP' : 'RSAES-PKCS1-V1_5',
      );
      return outBase64
        ? forge.util.encode64(decrypted)
        : forge.util.decodeUtf8(decrypted);
    }
  } catch (e) {
    console.error('[rsaX] error:', e);
    return '';
  }
}

// ─── Chinese conversion ──────────────────────────────────────────────────────

const S2T_MAP: Record<string, string> = {
  爱: '愛',
  碍: '礙',
  暗: '闇',
  罢: '罷',
  备: '備',
  贝: '貝',
  笔: '筆',
  毕: '畢',
  边: '邊',
  变: '變',
  表: '錶',
  标: '標',
  别: '別',
  卜: '蔔',
  补: '補',
  参: '參',
  仓: '倉',
  产: '產',
  长: '長',
  尝: '嘗',
  偿: '償',
  场: '場',
  车: '車',
  彻: '徹',
  尘: '塵',
  陈: '陳',
  衬: '襯',
  称: '稱',
  惩: '懲',
  迟: '遲',
  冲: '衝',
  丑: '醜',
  出: '齣',
  础: '礎',
  处: '處',
  触: '觸',
  辞: '辭',
  聪: '聰',
  丛: '叢',
  从: '從',
  窜: '竄',
  达: '達',
  带: '帶',
  担: '擔',
  单: '單',
  当: '當',
  党: '黨',
  导: '導',
  灯: '燈',
  邓: '鄧',
  敌: '敵',
  递: '遞',
  点: '點',
  淀: '澱',
  电: '電',
  钓: '釣',
  调: '調',
  叠: '疊',
  钉: '釘',
  顶: '頂',
  订: '訂',
  东: '東',
  动: '動',
  栋: '棟',
  斗: '鬥',
  独: '獨',
  读: '讀',
  断: '斷',
  队: '隊',
  对: '對',
  吨: '噸',
  夺: '奪',
  堕: '墮',
  鹅: '鵝',
  发: '發',
  罚: '罰',
  阀: '閥',
  法: '灋',
  帆: '帆',
  飞: '飛',
  废: '廢',
  费: '費',
  奋: '奮',
  粪: '糞',
  丰: '豐',
  风: '風',
  凤: '鳳',
  肤: '膚',
  妇: '婦',
  复: '復',
  负: '負',
  讣: '訃',
  赶: '趕',
  冈: '岡',
  刚: '剛',
  纲: '綱',
  钢: '鋼',
  岗: '崗',
  港: '港',
  搁: '擱',
  个: '個',
  给: '給',
  巩: '鞏',
  贡: '貢',
  构: '構',
  沟: '溝',
  购: '購',
  蛊: '蠱',
  顾: '顧',
  刮: '刮',
  关: '關',
  观: '觀',
  馆: '館',
  惯: '慣',
  贯: '貫',
  广: '廣',
  归: '歸',
  龟: '龜',
  规: '規',
  柜: '櫃',
  贵: '貴',
  国: '國',
  过: '過',
  骇: '駭',
  汉: '漢',
  号: '號',
  合: '閤',
  轰: '轟',
  红: '紅',
  后: '後',
  护: '護',
  沪: '滬',
  户: '戶',
  华: '華',
  画: '畫',
  划: '劃',
  怀: '懷',
  坏: '壞',
  欢: '歡',
  环: '環',
  还: '還',
  换: '換',
  黄: '黃',
  汇: '匯',
  会: '會',
  绘: '繪',
  毁: '毀',
  浑: '渾',
  混: '溷',
  获: '獲',
  货: '貨',
  祸: '禍',
  击: '擊',
  饥: '饑',
  鸡: '雞',
  积: '積',
  极: '極',
  际: '際',
  剂: '劑',
  济: '濟',
  继: '繼',
  计: '計',
  记: '記',
  纪: '紀',
  技: '技',
  迹: '跡',
  寂: '寂',
  价: '價',
  驾: '駕',
  假: '假',
  坚: '堅',
  歼: '殲',
  监: '監',
  间: '間',
  艰: '艱',
  俭: '儉',
  茧: '繭',
  检: '檢',
  捡: '撿',
  简: '簡',
  减: '減',
  荐: '薦',
  槛: '檻',
  践: '踐',
  鉴: '鑒',
  键: '鍵',
  剑: '劍',
  舰: '艦',
  渐: '漸',
  溅: '濺',
  涧: '澗',
  将: '將',
  浆: '漿',
  桨: '槳',
  奖: '獎',
  讲: '講',
  匠: '匠',
  酱: '醬',
  胶: '膠',
  教: '教',
  阶: '階',
  节: '節',
  杰: '傑',
  洁: '潔',
  结: '結',
  姐: '姐',
  届: '屆',
  紧: '緊',
  仅: '僅',
  锦: '錦',
  尽: '盡',
  劲: '勁',
  进: '進',
  晋: '晉',
  浸: '浸',
  烬: '燼',
  禁: '禁',
  京: '京',
  茎: '莖',
  经: '經',
  惊: '驚',
  精: '精',
  鲸: '鯨',
  颈: '頸',
  景: '景',
  警: '警',
  净: '淨',
  竞: '競',
  纠: '糾',
  旧: '舊',
  举: '舉',
  剧: '劇',
  据: '據',
  惧: '懼',
  卷: '捲',
  觉: '覺',
  决: '決',
  绝: '絕',
  军: '軍',
  开: '開',
  凯: '凱',
  壳: '殼',
  课: '課',
  恳: '懇',
  垦: '墾',
  库: '庫',
  裤: '褲',
  夸: '誇',
  块: '塊',
  宽: '寬',
  矿: '礦',
  亏: '虧',
  困: '睏',
  扩: '擴',
  腊: '臘',
  蜡: '蠟',
  来: '來',
  赖: '賴',
  蓝: '藍',
  栏: '欄',
  拦: '攔',
  篮: '籃',
  兰: '蘭',
  烂: '爛',
  捞: '撈',
  劳: '勞',
  乐: '樂',
  类: '類',
  累: '纍',
  离: '離',
  里: '裡',
  礼: '禮',
  丽: '麗',
  两: '兩',
  辆: '輛',
  谅: '諒',
  猎: '獵',
  临: '臨',
  邻: '鄰',
  灵: '靈',
  岭: '嶺',
  领: '領',
  刘: '劉',
  龙: '龍',
  楼: '樓',
  娄: '婁',
  卢: '盧',
  虏: '虜',
  鲁: '魯',
  录: '錄',
  陆: '陸',
  驴: '驢',
  吕: '呂',
  铝: '鋁',
  旅: '旅',
  虑: '慮',
  律: '律',
  乱: '亂',
  略: '略',
  轮: '輪',
  论: '論',
  络: '絡',
  罗: '羅',
  妈: '媽',
  马: '馬',
  骂: '罵',
  买: '買',
  卖: '賣',
  麦: '麥',
  脉: '脈',
  蛮: '蠻',
  满: '滿',
  猫: '貓',
  贸: '貿',
  么: '麼',
  没: '沒',
  门: '門',
  闷: '悶',
  锰: '錳',
  梦: '夢',
  弥: '彌',
  幂: '冪',
  缅: '緬',
  庙: '廟',
  灭: '滅',
  鸣: '鳴',
  铭: '銘',
  谬: '謬',
  摸: '摸',
  模: '模',
  磨: '磨',
  谋: '謀',
  亩: '畝',
  纳: '納',
  难: '難',
  脑: '腦',
  恼: '惱',
  闹: '鬧',
  馁: '餒',
  拟: '擬',
  酿: '釀',
  鸟: '鳥',
  聂: '聶',
  镍: '鎳',
  柠: '檸',
  宁: '寧',
  拧: '擰',
  牛: '牛',
  纽: '紐',
  农: '農',
  浓: '濃',
  疟: '瘧',
  诺: '諾',
  欧: '歐',
  呕: '嘔',
  盘: '盤',
  庞: '龐',
  赔: '賠',
  喷: '噴',
  鹏: '鵬',
  骗: '騙',
  飘: '飄',
  频: '頻',
  贫: '貧',
  苹: '蘋',
  凭: '憑',
  评: '評',
  泼: '潑',
  扑: '撲',
  铺: '鋪',
  朴: '樸',
  谱: '譜',
  栖: '棲',
  齐: '齊',
  骑: '騎',
  启: '啟',
  气: '氣',
  弃: '棄',
  签: '簽',
  千: '千',
  迁: '遷',
  牵: '牽',
  纤: '纖',
  浅: '淺',
  谴: '譴',
  枪: '槍',
  强: '強',
  墙: '牆',
  抢: '搶',
  桥: '橋',
  侨: '僑',
  翘: '翹',
  窃: '竊',
  亲: '親',
  钦: '欽',
  寝: '寢',
  庆: '慶',
  穷: '窮',
  秋: '鞦',
  区: '區',
  驱: '驅',
  趋: '趨',
  权: '權',
  劝: '勸',
  确: '確',
  让: '讓',
  扰: '擾',
  热: '熱',
  认: '認',
  韧: '韌',
  荣: '榮',
  绒: '絨',
  软: '軟',
  锐: '銳',
  闰: '閏',
  润: '潤',
  洒: '灑',
  赛: '賽',
  伞: '傘',
  丧: '喪',
  扫: '掃',
  涩: '澀',
  杀: '殺',
  晒: '曬',
  山: '山',
  闪: '閃',
  陕: '陝',
  善: '善',
  伤: '傷',
  赏: '賞',
  烧: '燒',
  绍: '紹',
  赊: '賒',
  设: '設',
  摄: '攝',
  审: '審',
  婶: '嬸',
  肾: '腎',
  渗: '滲',
  声: '聲',
  胜: '勝',
  师: '師',
  湿: '濕',
  诗: '詩',
  时: '時',
  识: '識',
  实: '實',
  视: '視',
  饰: '飾',
  试: '試',
  寿: '壽',
  兽: '獸',
  书: '書',
  术: '術',
  树: '樹',
  竖: '豎',
  数: '數',
  帅: '帥',
  双: '雙',
  谁: '誰',
  水: '水',
  顺: '順',
  说: '說',
  丝: '絲',
  饲: '飼',
  松: '鬆',
  讼: '訟',
  诵: '誦',
  苏: '蘇',
  肃: '肅',
  虽: '雖',
  随: '隨',
  孙: '孫',
  损: '損',
  缩: '縮',
  锁: '鎖',
  态: '態',
  贪: '貪',
  滩: '灘',
  摊: '攤',
  瘫: '癱',
  谈: '談',
  叹: '嘆',
  坛: '壇',
  涛: '濤',
  讨: '討',
  腾: '騰',
  誊: '謄',
  体: '體',
  条: '條',
  贴: '貼',
  铁: '鐵',
  听: '聽',
  厅: '廳',
  铜: '銅',
  统: '統',
  头: '頭',
  图: '圖',
  涂: '塗',
  团: '團',
  颓: '頹',
  脱: '脫',
  鸵: '鴕',
  驮: '馱',
  挖: '挖',
  洼: '窪',
  袜: '襪',
  弯: '彎',
  湾: '灣',
  万: '萬',
  网: '網',
  违: '違',
  围: '圍',
  韦: '韋',
  维: '維',
  伟: '偉',
  伪: '偽',
  卫: '衛',
  温: '溫',
  纹: '紋',
  闻: '聞',
  问: '問',
  涡: '渦',
  乌: '烏',
  无: '無',
  吴: '吳',
  误: '誤',
  务: '務',
  雾: '霧',
  牺: '犧',
  习: '習',
  席: '席',
  戏: '戲',
  细: '細',
  虾: '蝦',
  吓: '嚇',
  辖: '轄',
  峡: '峽',
  狭: '狹',
  显: '顯',
  险: '險',
  县: '縣',
  宪: '憲',
  线: '線',
  献: '獻',
  乡: '鄉',
  详: '詳',
  响: '響',
  项: '項',
  象: '象',
  萧: '蕭',
  协: '協',
  挟: '挾',
  胁: '脅',
  写: '寫',
  泻: '瀉',
  卸: '卸',
  亵: '褻',
  谢: '謝',
  兴: '興',
  刑: '刑',
  选: '選',
  旋: '旋',
  悬: '懸',
  学: '學',
  勋: '勛',
  询: '詢',
  寻: '尋',
  驯: '馴',
  训: '訓',
  讯: '訊',
  逊: '遜',
  压: '壓',
  鸦: '鴉',
  鸭: '鴨',
  牙: '牙',
  亚: '亞',
  严: '嚴',
  颜: '顏',
  阎: '閻',
  艳: '艷',
  砚: '硯',
  验: '驗',
  杨: '楊',
  扬: '揚',
  阳: '陽',
  养: '養',
  尧: '堯',
  钥: '鑰',
  谣: '謠',
  摇: '搖',
  遥: '遙',
  药: '藥',
  爷: '爺',
  业: '業',
  叶: '葉',
  页: '頁',
  医: '醫',
  仪: '儀',
  忆: '憶',
  义: '義',
  艺: '藝',
  议: '議',
  译: '譯',
  异: '異',
  阴: '陰',
  银: '銀',
  饮: '飲',
  隐: '隱',
  印: '印',
  樱: '櫻',
  鹰: '鷹',
  应: '應',
  萤: '螢',
  营: '營',
  蝇: '蠅',
  赢: '贏',
  颖: '穎',
  拥: '擁',
  佣: '傭',
  痈: '癰',
  踊: '踴',
  优: '優',
  邮: '郵',
  忧: '憂',
  犹: '猶',
  诱: '誘',
  于: '於',
  余: '餘',
  鱼: '魚',
  娱: '娛',
  渔: '漁',
  与: '與',
  屿: '嶼',
  语: '語',
  玉: '玉',
  驭: '馭',
  吁: '籲',
  誉: '譽',
  预: '預',
  鸳: '鴛',
  渊: '淵',
  园: '園',
  员: '員',
  圆: '圓',
  原: '原',
  源: '源',
  远: '遠',
  约: '約',
  跃: '躍',
  阅: '閱',
  云: '雲',
  运: '運',
  酝: '醞',
  杂: '雜',
  灾: '災',
  赃: '贓',
  凿: '鑿',
  枣: '棗',
  灶: '竈',
  择: '擇',
  泽: '澤',
  赞: '贊',
  贼: '賊',
  赠: '贈',
  扎: '扎',
  铡: '鍘',
  斋: '齋',
  毡: '氈',
  战: '戰',
  占: '佔',
  张: '張',
  账: '賬',
  赵: '趙',
  这: '這',
  针: '針',
  侦: '偵',
  诊: '診',
  镇: '鎮',
  阵: '陣',
  争: '爭',
  征: '徵',
  挣: '掙',
  睁: '睜',
  狰: '猙',
  蒸: '蒸',
  整: '整',
  证: '證',
  郑: '鄭',
  织: '織',
  职: '職',
  执: '執',
  纸: '紙',
  指: '指',
  质: '質',
  滞: '滯',
  制: '制',
  钟: '鐘',
  终: '終',
  种: '種',
  众: '眾',
  肿: '腫',
  重: '重',
  洲: '洲',
  诌: '謅',
  皱: '皺',
  猪: '豬',
  诛: '誅',
  逐: '逐',
  烛: '燭',
  筑: '築',
  注: '注',
  驻: '駐',
  专: '專',
  砖: '磚',
  转: '轉',
  庄: '莊',
  装: '裝',
  壮: '壯',
  状: '狀',
  坠: '墜',
  缀: '綴',
  资: '資',
  渍: '漬',
  总: '總',
  纵: '縱',
  棕: '棕',
  综: '綜',
  钻: '鑽',
  醉: '醉',
  尊: '尊',
  昨: '昨',
  左: '左',
  做: '做',
};

const T2S_MAP: Record<string, string> = {};
for (const [s, t] of Object.entries(S2T_MAP)) {
  T2S_MAP[t] = s;
}

function s2t(text: string): string {
  return text
    .split('')
    .map((c) => S2T_MAP[c] || c)
    .join('');
}

function t2s(text: string): string {
  return text
    .split('')
    .map((c) => T2S_MAP[c] || c)
    .join('');
}

// ─── Proxy helpers ──────────────────────────────────────────────────────────

function getProxy(_local?: boolean): string {
  return 'http://127.0.0.1:9978/proxy?do=js';
}

function js2Proxy(
  _dynamic: boolean,
  _siteType: number,
  siteKey: string,
  url: string,
  _headers?: Record<string, string>,
): string {
  return `http://127.0.0.1:9978/proxy?do=js&siteKey=${encodeURIComponent(siteKey)}&url=${encodeURIComponent(url)}`;
}

// ─── JsSpider ───────────────────────────────────────────────────────────────

export class JsSpider implements ISpider {
  private key: string;
  private api: string;
  private ext: string;
  private context: import('vm').Context | null = null;
  private sandbox: Record<string, any> = {};
  private spiderObj: any = null;
  private baseUrl: string;
  // For drpy spiders: stores the transpiled rules code so we can pass it
  // directly to drpy2's init() instead of the URL. drpy2's init() re-fetches
  // the rules via request(), but our req() is async and drpy2 calls it
  // synchronously, so the fetch returns empty and rule stays {}. Passing the
  // code directly bypasses the re-fetch.
  private drpyRulesCode: string = '';

  constructor(key: string, api: string, ext?: string) {
    this.key = key;
    this.api = api;
    this.ext = ext || '';
    this.baseUrl = api.substring(0, api.lastIndexOf('/') + 1);
  }

  // ── ISpider interface ────────────────────────────────────────────────

  async init(extend: string): Promise<void> {
    this.ext = extend || this.ext;
    const isDrpy = this.key.startsWith('drpy_js_') || this.api.includes('drpy');
    console.log(
      `[JsSpider] init: key=${this.key}, api=${this.api}, ext=${this.ext.substring(0, 80)}, isDrpy=${isDrpy}`,
    );

    // Reset spider state before re-initialization (init may be called multiple
    // times). buildContext() creates a fresh vm context, so any prior
    // __spider__/spiderObj reference is stale and must be cleared.
    this.spiderObj = null;

    // Build vm context with all global injections
    this.buildContext();

    if (isDrpy) {
      // Drpy spiders need two JS files: spider rules (ext) + drpy library (api)
      // The spider rules define `var rule = { ... }` and the drpy library
      // processes the rule to create spider methods
      await this.initDrpy();
    } else {
      // Normal JS spider — single file
      await this.initNormal();
    }

    // Resolve the spider object from the three possible formats
    this.resolveSpiderObject();
    console.log(
      `[JsSpider] spiderObj resolved: ${!!this.spiderObj}, methods: ${
        this.spiderObj
          ? Object.keys(this.spiderObj)
              .filter((k) => typeof this.spiderObj[k] === 'function')
              .join(',')
          : 'none'
      }`,
    );

    // Call the spider's init if it exists
    if (this.spiderObj && typeof this.spiderObj.init === 'function') {
      try {
        // For drpy spiders, pass the transpiled rules code directly instead
        // of the URL. drpy2's init() re-fetches rules via request() which is
        // async, but drpy2 calls it synchronously, causing empty rule. By
        // passing the code, drpy2 evals it directly without re-fetching.
        const initArg = this.drpyRulesCode || this.ext;
        const result = vm.runInContext(
          `__spider__.init(${JSON.stringify(initArg)})`,
          this.context!,
          { timeout: 10000 },
        );
        if (result && typeof result.then === 'function') {
          await result;
        }
        console.log(
          `[JsSpider] spider.init() called successfully for ${this.key}`,
        );
      } catch (e) {
        console.error(`[JsSpider] init() error for ${this.key}:`, e);
      }
    }

    // Apply drpy rule patches for broken upstream spiders (after init)
    if (isDrpy && this.context) {
      applyDrpyRulePatch(this.key, this.context);
    }
  }

  /**
   * Initialize a normal (non-drpy) JS spider.
   * Loads a single JS file from the api URL.
   */
  private async initNormal(): Promise<void> {
    let code: string;
    try {
      const resp = await axios.get(this.api, {
        responseType: 'text',
        timeout: 15000,
      });
      code =
        typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
      console.log(
        `[JsSpider] fetched code length: ${code.length} for ${this.key}`,
      );
    } catch (e) {
      throw new Error(`[JsSpider] Failed to fetch spider ${this.key}: ${e}`);
    }

    // Decode bytecode if needed
    code = decodeBytecode(code);

    // Neutralize prototype Object.defineProperty calls
    code = neutralizeProtoDefineProperty(code);

    // Transpile ESM → CJS
    code = transpileESM(code);

    // Wrap and evaluate
    const wrapped = this.wrapCode(code);
    try {
      vm.runInContext(wrapped, this.context!, { timeout: 10000 });
      console.log(`[JsSpider] code evaluated successfully for ${this.key}`);
    } catch (e) {
      throw new Error(`[JsSpider] Failed to evaluate spider ${this.key}: ${e}`);
    }
  }

  /**
   * Initialize a drpy-type spider.
   * Loads two JS files: spider rules (ext) + drpy library (api).
   * The spider rules define `var rule = { ... }` and the drpy library
   * processes the rule to create spider methods.
   */
  private async initDrpy(): Promise<void> {
    // Resolve URLs: ext is the spider rules, api is the drpy library
    const rulesUrl = this.resolveUrl(this.ext);
    const libUrl = this.resolveUrl(this.api);

    console.log(`[JsSpider] drpy init: rulesUrl=${rulesUrl}, libUrl=${libUrl}`);

    // 1. Fetch spider rules JS (skip if no rules URL — the library may be self-contained)
    let rulesCode = '';
    if (rulesUrl) {
      try {
        rulesCode = await fetchWithMirrorFallback(rulesUrl, {
          responseType: 'text',
          timeout: 15000,
        });
        console.log(
          `[JsSpider] drpy rules fetched: ${rulesCode.length} bytes from ${rulesUrl}`,
        );
      } catch (e) {
        throw new Error(
          `[JsSpider] Failed to fetch drpy rules ${rulesUrl}: ${e}`,
        );
      }
    } else {
      console.log(`[JsSpider] drpy: no rules URL, using library only`);
    }

    // 2. Fetch drpy library JS
    let libCode: string;
    try {
      libCode = await fetchWithMirrorFallback(libUrl, {
        responseType: 'text',
        timeout: 15000,
      });
      console.log(
        `[JsSpider] drpy library fetched: ${libCode.length} bytes from ${libUrl}`,
      );
    } catch (e) {
      console.warn(
        `[JsSpider] Failed to fetch drpy library ${libUrl}: ${e}, continuing without it`,
      );
      libCode = '';
    }

    // 3. Decode bytecode if needed
    rulesCode = decodeBytecode(rulesCode);
    libCode = decodeBytecode(libCode);

    // 3b. Detect encrypted rulesCode (AES-CBC, gzip, etc.)
    //     drpy2's getOriginalJs() handles decryption, but we must NOT
    //     eval the encrypted content directly. If rulesCode doesn't look
    //     like valid JS, store it for init() but skip it in combined eval.
    const jsPattern =
      /var rule|[\u4E00-\u9FA5]+|function|let |var |const |\(|\)|"|'/;
    const rulesCodeIsEncrypted =
      rulesCode.length > 0 && !jsPattern.test(rulesCode);
    if (rulesCodeIsEncrypted) {
      console.log(
        `[JsSpider] drpy rulesCode appears encrypted (${rulesCode.length} bytes), will pass to init() for decryption`,
      );
    }

    // 4. Pre-load URL modules referenced in import statements
    //    drpy2.min.js imports modules from URLs like https://down.nigx.cn/...
    //    These need to be fetched and cached before evaluation, because
    //    __require() is synchronous and cannot download at runtime.
    const allCodeForScan = `${rulesCode}\n${libCode}`;
    const urlImports = this.extractUrlImports(allCodeForScan);
    if (urlImports.length > 0) {
      console.log(
        `[JsSpider] drpy pre-loading ${urlImports.length} URL modules: ${urlImports.join(', ')}`,
      );
      await Promise.all(urlImports.map((url) => this.preloadUrlModule(url)));
    }

    // 5. Transpile both (neutralize prototype defineProperty first)
    //    Skip transpile for encrypted rulesCode — drpy2's init() will
    //    decrypt via getOriginalJs() and eval the decrypted code itself.
    if (!rulesCodeIsEncrypted) {
      rulesCode = neutralizeProtoDefineProperty(rulesCode);
      rulesCode = transpileESM(rulesCode);
      // Convert `var rule = {` to `globalThis.rule = {` so that `rule` is a
      // globalThis property, not an IIFE-scoped variable. This ensures all
      // `rule` references (drpy2 functions, init(), __hostEval, init_test)
      // resolve to the same globalThis.rule. Without this, the wrapCode IIFE
      // would have its own `rule` shadowing globalThis.rule, causing the
      // eval'd code (run at VM top-level via __hostEval) to set a different
      // globalThis.rule while drpy2 functions see the empty IIFE-scoped rule.
      rulesCode = rulesCode.replace(
        /\bvar\s+rule\s*=\s*\{/,
        'globalThis.rule = {',
      );
    }
    // Store the rules code so we can pass it directly to drpy2's init()
    // instead of the URL. drpy2's init() re-fetches rules via request()
    // which is async, but drpy2 calls it synchronously, causing empty rule.
    // For encrypted rulesCode, init() will call getOriginalJs() to decrypt.
    this.drpyRulesCode = rulesCode;
    if (libCode) {
      libCode = neutralizeProtoDefineProperty(libCode);
      libCode = transpileESM(libCode);
      // drpy2.min.js declares `let rule={}` at its top level. Since we wrap
      // the code in an IIFE (wrapCode), this `let` creates a lexical binding
      // local to the IIFE, NOT a globalThis property. drpy2's init() calls
      // `__hostEval(...)` (replacing eval) which runs at the VM context
      // top-level — a DIFFERENT scope from the IIFE. So `rule = {...}` inside
      // the eval'd code creates a separate globalThis.rule, leaving the
      // IIFE-scoped `rule` empty. init_test() sees the empty IIFE-scoped rule.
      //
      // Fix: replace `let rule={}` with `globalThis.rule = globalThis.rule || {}`
      // so `rule` is a globalThis property. Then all references to `rule`
      // (in drpy2 functions, init(), __hostEval, init_test) resolve to the
      // same globalThis.rule via scope chain lookup.
      libCode = libCode.replace(
        /\blet\s+rule\s*=\s*\{\s*\}\s*;?/g,
        'globalThis.rule = globalThis.rule || {};',
      );
      // Remove `var rule = ...` only if it's a re-declaration (not the first
      // one in the library which initializes the framework). We keep `var rule`
      // because in non-strict mode, re-declaring with var is allowed.

      // Replace eval() with __hostEval(). Electron's renderer CSP blocks
      // eval() inside VM contexts, but vm.runInContext (which __hostEval
      // uses) is not blocked. drpy2.min.js uses eval() to execute:
      //   - rules code (in init())
      //   - hostJs (in init())
      //   - 预处理 / pre-processing code (in pre())
      //   - js:-prefixed rule fields (lazy, 一级, 二级, etc.)
      //   - 模板修改 code
      // All these only need access to the VM's global scope, which
      // vm.runInContext provides.
      libCode = libCode.replace(/\beval\(/g, '__hostEval(');

      // __hostEval runs at VM context top-level, but drpy2 sets variables
      // like `var input = MY_URL` in the IIFE scope before calling eval().
      // Since __hostEval can't see IIFE-scoped vars, replace `var X =`
      // with `globalThis.X =` for all variables that drpy2 uses across
      // eval boundaries. This includes: input, MY_URL, HOST, VODS,
      // MY_CATE, MY_PAGE, MY_FLAG, RKEY, fetch_params, rule_fetch_params,
      // and other drpy2 execution-context variables.
      const evalScopedVars = [
        'input',
        'MY_URL',
        'HOST',
        'VODS',
        'MY_CATE',
        'MY_PAGE',
        'MY_FLAG',
        'RKEY',
        'fetch_params',
        'rule_fetch_params',
        'oheaders',
        'detailUrl',
        'play_url',
        'flag',
        'current',
      ];
      for (const v of evalScopedVars) {
        // Replace `var X =` (but not `var X = {}` initializers at top-level
        // which should stay local). We target assignments before eval calls.
        libCode = libCode.replace(
          new RegExp(`\\bvar\\s+${v}\\s*=`, 'g'),
          `globalThis.${v} =`,
        );
      }

      // After transpilation, relative __require__ calls (e.g., __require__('./drpy-core-lite.min.js'))
      // would resolve against this.baseUrl (rules URL directory) at runtime. But the imports are
      // in the library code, so they should resolve against the library URL's directory.
      // Fix: replace relative __require__ paths in libCode with fully resolved absolute URLs.
      if (libUrl) {
        const libBaseUrl = libUrl.substring(0, libUrl.lastIndexOf('/') + 1);
        libCode = libCode.replace(
          /__require__\(\s*['"](\.\/[^'"]+)['"]\s*\)/g,
          (_match, relPath: string) => {
            const resolved = joinUrl(libBaseUrl, relPath);
            return `__require__('${resolved}')`;
          },
        );
      }
    }

    // 6. Update baseUrl to the rules URL for resolving relative imports
    this.baseUrl = rulesUrl.substring(0, rulesUrl.lastIndexOf('/') + 1);

    // 6. Evaluate: spider rules first (defines `var rule`), then drpy library
    // The drpy library processes the `rule` object to create spider methods
    // Use noIIFE=true so drpy2's top-level functions (request, fetch, pdfh,
    // etc.) become globalThis properties, accessible from __hostEval which
    // runs at VM context top-level.
    // If rulesCode is encrypted (AES-CBC, gzip, etc.), don't include it in
    // the combined eval — drpy2's init() will call getOriginalJs() to decrypt.
    const evalRulesCode = rulesCodeIsEncrypted ? '' : rulesCode;
    const combinedCode = libCode
      ? `${evalRulesCode}\n// --- drpy library ---\n${libCode}`
      : evalRulesCode;

    const wrapped = this.wrapCode(combinedCode, true);
    try {
      vm.runInContext(wrapped, this.context!, { timeout: 15000 });
      console.log(
        `[JsSpider] drpy code evaluated successfully for ${this.key}`,
      );
    } catch (e) {
      // If combined evaluation fails, try rules-only (the rules might already
      // implement the spider methods directly without needing the drpy library)
      // Skip rules-only for encrypted rulesCode — it can't be eval'd directly.
      if (rulesCodeIsEncrypted) {
        throw new Error(
          `[JsSpider] drpy lib eval failed for ${this.key} (rulesCode is encrypted): ${e}`,
        );
      }
      console.warn(
        `[JsSpider] drpy combined eval failed for ${this.key}: ${e}, trying rules-only`,
      );
      const rulesOnlyWrapped = this.wrapCode(rulesCode, true);
      try {
        vm.runInContext(rulesOnlyWrapped, this.context!, { timeout: 10000 });
        console.log(`[JsSpider] drpy rules-only evaluated for ${this.key}`);
      } catch (e2) {
        throw new Error(
          `[JsSpider] Failed to evaluate drpy spider ${this.key}: ${e2}`,
        );
      }
    }
  }

  /**
   * Extract URL imports from JS code.
   * Matches: import X from "https://...", import "https://...", import {X} from "https://..."
   * Returns list of unique URLs.
   */
  private extractUrlImports(code: string): string[] {
    const urls = new Set<string>();
    // Match import statements with URL string literals (http:// or https://)
    // or relative paths (./xxx, ../xxx) which need resolution against baseUrl
    // Identifier part uses [^\s{,]+ to support unicode identifiers like 模板
    // Use \s* (not \s+) to support import"..." without space
    const importRegex =
      /import\s*(?:[^\s{,]+\s*from\s*|\{[^}]+\}\s*from\s*)?['"]([^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(code)) !== null) {
      const url = match[1];
      if (url.startsWith('http://') || url.startsWith('https://')) {
        urls.add(url);
      } else if (url.startsWith('./') || url.startsWith('../')) {
        // Resolve relative URL against baseUrl
        const resolved = joinUrl(this.baseUrl, url);
        if (resolved && resolved.startsWith('http')) {
          urls.add(resolved);
        }
      }
    }
    return Array.from(urls);
  }

  /**
   * Resolve a potentially relative URL against the spider base URL.
   */
  private resolveUrl(url: string): string {
    if (!url) return '';
    if (/^https?:\/\//i.test(url)) return url;
    if (url.startsWith('//')) return 'https:' + url;
    if (url.startsWith('./') || url.startsWith('../') || url.startsWith('/')) {
      try {
        return new URL(url, this.baseUrl).href;
      } catch {
        return this.baseUrl + url.replace(/^\.\//, '');
      }
    }
    return this.baseUrl + url;
  }

  async homeContent(filter: boolean): Promise<string> {
    return this.callSpiderMethod('home', filter);
  }

  async homeVideoContent(): Promise<string> {
    return this.callSpiderMethod('homeVod');
  }

  async categoryContent(
    tid: string,
    pg: string,
    filter: boolean,
    extend: Record<string, string>,
  ): Promise<string> {
    return this.callSpiderMethod('category', tid, pg, filter, extend);
  }

  async detailContent(ids: string[]): Promise<string> {
    return this.callSpiderMethod('detail', ids[0] || '');
  }

  async searchContent(
    key: string,
    quick: boolean,
    pg?: string,
  ): Promise<string> {
    if (pg !== undefined) {
      return this.callSpiderMethod('search', key, quick, pg);
    }
    return this.callSpiderMethod('search', key, quick);
  }

  async playerContent(
    flag: string,
    id: string,
    vipFlags: string[],
  ): Promise<string> {
    return this.callSpiderMethod('play', flag, id, vipFlags);
  }

  async isVideoFormat(url: string): Promise<boolean> {
    try {
      const result = this.callSpiderMethodSync('isVideoFormat', url);
      if (typeof result === 'boolean') return result;
      return false;
    } catch {
      return false;
    }
  }

  async manualVideoCheck(): Promise<boolean> {
    try {
      const result = this.callSpiderMethodSync('manualVideoCheck');
      if (typeof result === 'boolean') return result;
      return false;
    } catch {
      return false;
    }
  }

  async action(actionId: string, actionData: any): Promise<string> {
    return this.callSpiderMethod('action', actionId, actionData);
  }

  destroy(): void {
    this.context = null;
    this.sandbox = {};
    this.spiderObj = null;
  }

  /**
   * Call the spider's proxyLocal method with the given params map.
   * Used by LocalProxyServer to handle /proxy?do=js requests.
   */
  async callProxyLocal(params: Map<string, string>): Promise<string> {
    const obj: Record<string, string> = {};
    for (const [k, v] of params) {
      obj[k] = v;
    }
    return this.callSpiderMethod('proxyLocal', obj);
  }

  // ── Internal helpers ─────────────────────────────────────────────────

  private buildContext(): void {
    const self = this;

    this.sandbox = {
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,

      // Export/require bridge
      __exports__: {} as Record<string, any>,
      __exports_default__: undefined as any,
      __spider__: null as any,
      __require__: (moduleName: string) => self.__require(moduleName),

      // Note: __safeDP__ is intentionally NOT defined here. It is injected
      // as a VM-side function after createContext so that it uses the VM's
      // own Object.defineProperty and operates on VM built-in prototypes.
      // Defining it here (host closure) would modify host prototypes, which
      // VM primitive literals cannot see.

      // HTTP request — SYNCHRONOUS. drpy2's request() function calls
      // `let res = req(url, obj)` WITHOUT await, so async req would return
      // a Promise (whose .content is undefined). We must use sync XHR.
      // Sync XHR does NOT support responseType='arraybuffer', so for binary
      // requests we use overrideMimeType with x-user-defined and convert to
      // Buffer on the host side.
      req: (url: string, options: any = {}) => {
        // Helper: perform a synchronous XHR and return the result
        const doXhr = (xhrUrl: string) => {
          const xhr = new XMLHttpRequest();
          xhr.open(options.method || 'GET', xhrUrl, false); // false = synchronous
          const isBin =
            options.buffer ||
            options.responseType === 'arraybuffer' ||
            options.responseType === 'arraybuffer';
          if (isBin) {
            try {
              xhr.overrideMimeType('text/plain; charset=x-user-defined');
            } catch {}
          }
          if (options.headers) {
            for (const [k, v] of Object.entries(options.headers)) {
              try {
                xhr.setRequestHeader(k, String(v));
              } catch {}
            }
          }
          xhr.send(options.body || options.data || null);
          return xhr;
        };

        try {
          const isBinary =
            options.buffer ||
            options.responseType === 'arraybuffer' ||
            options.responseType === 'arraybuffer';
          let xhr = doXhr(url);

          // If the request failed (status 0 = network error, or 403/502) and
          // the URL uses a known GitHub mirror proxy, try alternatives synchronously
          if (
            (xhr.status === 0 || xhr.status >= 400) &&
            url.startsWith('https://')
          ) {
            for (const chain of GITHUB_MIRROR_CHAINS) {
              const matchedMirror = chain.find((m) =>
                url.startsWith(`https://${m}/`),
              );
              if (!matchedMirror) continue;
              for (const altMirror of chain) {
                if (altMirror === matchedMirror) continue;
                const altUrl = rewriteUrlWithMirror(
                  url,
                  matchedMirror,
                  altMirror,
                );
                try {
                  const altXhr = doXhr(altUrl);
                  if (altXhr.status > 0 && altXhr.status < 400) {
                    xhr = altXhr;
                    break;
                  }
                } catch {}
              }
              if (xhr.status > 0 && xhr.status < 400) break;
            }
          }

          let content: any = xhr.responseText;
          if (isBinary && content) {
            // Convert binary string to Buffer for compatibility with code
            // that expects Node Buffer (e.g., res.content.toString('utf8')).
            const buf = Buffer.alloc(content.length);
            for (let i = 0; i < content.length; i++) {
              buf[i] = content.charCodeAt(i) & 0xff;
            }
            content = buf;
          }
          // Parse response headers into a plain object
          const headers: Record<string, string> = {};
          const allHeaders = xhr.getAllResponseHeaders();
          if (allHeaders) {
            for (const line of allHeaders.split(/\r?\n/)) {
              const idx = line.indexOf(':');
              if (idx > 0) {
                headers[line.slice(0, idx).trim().toLowerCase()] = line
                  .slice(idx + 1)
                  .trim();
              }
            }
          }
          return {
            content,
            headers,
            code: xhr.status,
          };
        } catch (e: any) {
          return { content: '', headers: {}, code: 500, error: e.message };
        }
      },

      // Synchronous native bridge to MyCrypto.extDe(String).
      // Used by JS spiders (ManJu/WexV6/WexWenCai/WexGuaZi series) to decrypt
      // "v2.{keyPart}.{cipherB64}" API responses. The native extDe method is
      // in libdecjni.so (ARM only) and is emulated via unidbg-loader subprocess
      // in the main process. Results are cached in the main process per keyPart.
      //
      // Returns: hex string of 32 bytes (key=first16bytes/32hex, iv=last16bytes/32hex),
      // or empty string on failure. The hex format lets JS use CryptoJS.enc.Hex.parse directly.
      __nativeExtDe: (keyPart: string) => {
        try {
          if (!keyPart || typeof keyPart !== 'string') return '';
          // Validate keyPart to prevent command injection on the main side.
          // Real keyParts are alphanumeric with underscores (e.g. api_abc123...).
          if (!/^[A-Za-z0-9_]+$/.test(keyPart)) {
            console.warn(
              `[JsSpider] __nativeExtDe: invalid keyPart rejected: ${keyPart.substring(0, 50)}`,
            );
            return '';
          }
          let ipc: any = (globalThis as any).electronIPC;
          if (!ipc && typeof (globalThis as any).window !== 'undefined') {
            ipc = (globalThis as any).window.electronIPC;
          }
          if (!ipc) {
            try {
              if ((globalThis as any).require) {
                const { ipcRenderer } = (globalThis as any).require('electron');
                ipc = {
                  sendSync: (channel: string, ...args: any[]) =>
                    ipcRenderer.sendSync(channel, ...args),
                };
              }
            } catch {
              ipc = null;
            }
          }
          if (!ipc || typeof ipc.sendSync !== 'function') {
            console.warn(
              '[JsSpider] __nativeExtDe: electronIPC.sendSync not available',
            );
            return '';
          }
          const base64 = ipc.sendSync('jar:callExtDeSync', keyPart);
          if (!base64 || typeof base64 !== 'string') return '';
          // Convert base64 -> hex for easier CryptoJS.enc.Hex.parse
          try {
            const buf = Buffer.from(base64, 'base64');
            return buf.toString('hex');
          } catch {
            return '';
          }
        } catch (e: any) {
          console.warn('[JsSpider] __nativeExtDe failed:', e.message);
          return '';
        }
      },

      // Synchronous native bridge to MyCrypto.Awdm(String, byte[]).
      // Used by AnimeMiaoWu (and similar) spiders to decrypt API response data
      // that is encrypted with the native Awdm algorithm. The native Awdm
      // method is in libdecjni.so (ARM only) and is emulated via unidbg-loader
      // subprocess in the main process. Results are cached by (keyHex, cipher).
      //
      // Returns: decrypted UTF-8 string (typically JSON), or empty string on
      // failure. The string format lets JS use JSON.parse directly.
      __nativeAwdm: (keyHex: string, cipherBase64: string) => {
        try {
          if (!keyHex || typeof keyHex !== 'string') return '';
          if (!cipherBase64 || typeof cipherBase64 !== 'string') return '';
          // Validate keyHex (hex chars only)
          if (!/^[0-9a-fA-F]+$/.test(keyHex)) {
            console.warn(
              `[JsSpider] __nativeAwdm: invalid keyHex rejected (non-hex): ${keyHex.substring(0, 50)}`,
            );
            return '';
          }
          // Validate cipherBase64 (chars used by base64 only)
          if (!/^[A-Za-z0-9+/=\s]+$/.test(cipherBase64)) {
            console.warn(
              '[JsSpider] __nativeAwdm: invalid cipherBase64 rejected (non-base64)',
            );
            return '';
          }
          let ipc: any = (globalThis as any).electronIPC;
          if (!ipc && typeof (globalThis as any).window !== 'undefined') {
            ipc = (globalThis as any).window.electronIPC;
          }
          if (!ipc) {
            try {
              if ((globalThis as any).require) {
                const { ipcRenderer } = (globalThis as any).require('electron');
                ipc = {
                  sendSync: (channel: string, ...args: any[]) =>
                    ipcRenderer.sendSync(channel, ...args),
                };
              }
            } catch {
              ipc = null;
            }
          }
          if (!ipc || typeof ipc.sendSync !== 'function') {
            console.warn(
              '[JsSpider] __nativeAwdm: electronIPC.sendSync not available',
            );
            return '';
          }
          const plain = ipc.sendSync('jar:callAwdmSync', keyHex, cipherBase64);
          if (!plain || typeof plain !== 'string') return '';
          return plain;
        } catch (e: any) {
          console.warn('[JsSpider] __nativeAwdm failed:', e.message);
          return '';
        }
      },

      // Synchronous native bridge to LoadNiMa.decode(Context, String).
      // Used by ChildrenDuoDuo/ChildrenTuTu/ChildrenBaoBao/ChildrenBeiWa/
      // MusicLiYuan/MusicIKtv/WexWenCai/WexTangDou/WexXiaoPingGuo/DuanJuHeMa/
      // MyPan115/NewPan115/AnimeXiFan etc. to decrypt encrypted API responses.
      //
      // The native decode method is in libLoadNiMa.so (ARM only) and would
      // normally be emulated via unidbg-loader subprocess. However, unidbg
      // fails to decrypt wexguard-encrypted responses due to signature
      // verification issues (env_check at 0x915b4 patch doesn't fully bypass).
      //
      // Solution: wexguard encryption uses a date-based AES-128-CBC key that
      // is shared across all wexfnw series sources. We decrypt directly in JS:
      //   Key: YYYYMMDD + "woshini8" (16 bytes, UTF-8)
      //   IV:  "Wexfnwshinidieha" (16 bytes, capital W, UTF-8)
      //   Algorithm: AES-128-CBC, PKCS5/PKCS7 padding
      //   Input: base64-encoded ciphertext
      //   Output: UTF-8 string (typically JSON)
      //
      // This matches the AES fallback in
      // tools/stubs/com/wexfnw/libso/LoadNiMa.java tryWenCaiAESFallback()
      // and works for all wexfnw/wexguard encrypted responses.
      __nativeLoadNiMaDecode: (input: string) => {
        try {
          if (!input || typeof input !== 'string') return '';
          const trimmed = input.trim();
          if (!trimmed) return '';

          // Try today and yesterday (handle midnight boundary)
          const now = new Date();
          const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          const dateCandidates = [
            now.toISOString().substring(0, 10).replace(/-/g, ''),
            yesterday.toISOString().substring(0, 10).replace(/-/g, ''),
          ];

          const iv = CryptoJS.enc.Utf8.parse('Wexfnwshinidieha');
          let ciphertext;
          try {
            ciphertext = CryptoJS.enc.Base64.parse(trimmed);
          } catch {
            return '';
          }
          if (ciphertext.sigBytes === 0 || ciphertext.sigBytes % 16 !== 0) {
            return '';
          }

          for (const dateStr of dateCandidates) {
            const keyStr = dateStr + 'woshini8';
            const key = CryptoJS.enc.Utf8.parse(keyStr);
            try {
              const cp = CryptoJS.lib.CipherParams.create({ ciphertext });
              const plain = CryptoJS.AES.decrypt(cp, key, {
                iv,
                mode: CryptoJS.mode.CBC,
                padding: CryptoJS.pad.Pkcs7,
              });
              const hex = plain.toString(CryptoJS.enc.Hex);
              // Valid JSON responses start with { (7b) or [ (5b)
              if (hex.startsWith('7b') || hex.startsWith('5b')) {
                const utf8 = plain.toString(CryptoJS.enc.Utf8);
                if (utf8 && utf8.length > 0) {
                  return utf8;
                }
              }
            } catch {
              // try next date
            }
          }
          // AES fallback failed - return empty so spider can handle gracefully
          return '';
        } catch (e: any) {
          console.warn('[JsSpider] __nativeLoadNiMaDecode failed:', e.message);
          return '';
        }
      },

      // HTML parsing
      pdfh,
      pdfa,
      pd,
      pdfla,

      // Eval replacement: drpy2.min.js uses eval() to execute dynamic code
      // (rules, hostJs, 预处理, etc.). Electron's renderer CSP blocks eval
      // inside VM contexts even with codeGeneration.strings=true. We replace
      // `eval(` with `__hostEval(` in drpy2 code, and __hostEval uses
      // vm.runInContext which is NOT blocked. The code runs in the same VM
      // context, so it has access to all globals (rule, request, pdfh, etc.).
      __hostEval: (code: string) => {
        const codePreview = (code || '').substring(0, 200);
        console.log(
          `[JsSpider] __hostEval called, code length: ${(code || '').length}, preview: ${codePreview.replace(/\n/g, '\\n')}`,
        );
        try {
          // Replace `let` and `const` with `var` in the eval'd code.
          // drpy2's dynamic code (e.g., `let d = []` in category/home
          // methods) uses `let` which cannot be re-declared in the same
          // VM context scope. `var` allows re-declaration, which is safe
          // here because the code runs at context top-level where `var`
          // simply overwrites the existing binding.
          // We do NOT use IIFE because drpy2 eval code may set `input`
          // (e.g., `input = classes`) which needs to be visible to the
          // caller (drpy2 reads `input` after eval returns).
          let patchedCode = code
            .replace(/\blet\s+/g, 'var ')
            .replace(/\bconst\s+/g, 'var ');
          const result = vm.runInContext(patchedCode, self.context!, {
            timeout: 30000,
          });
          // Check if rule was set (for debugging init issue)
          try {
            const ruleJson = vm.runInContext(
              'typeof rule !== "undefined" ? JSON.stringify({title: rule.title, host: rule.host, homeUrl: rule.homeUrl}) : "rule undefined"',
              self.context!,
              { timeout: 1000 },
            );
            console.log(
              `[JsSpider] __hostEval result: rule after eval = ${ruleJson}`,
            );
          } catch {}
          return result;
        } catch (e: any) {
          console.error(`[JsSpider] __hostEval error: ${e.message}`);
          throw e;
        }
      },

      // URL helper
      joinUrl,

      // Crypto
      aesX,
      rsaX,

      // Chinese conversion
      s2t,
      t2s,

      // RSA convenience methods (matching Android Global.java)
      rsaEncrypt: (key: string, data: string, options: any = {}) =>
        rsaX(options.mode || 'pkcs1', '1', true, data, false, key, true),
      rsaDecrypt: (key: string, data: string, options: any = {}) =>
        rsaX(options.mode || 'pkcs1', '0', false, data, true, key, false),

      // Proxy
      getProxy,
      js2Proxy,

      // Local storage
      local: {
        get: (key: string, def: string = ''): string => {
          try {
            return localStorage.getItem(`spider_${self.key}_${key}`) || def;
          } catch {
            return def;
          }
        },
        set: (key: string, val: string): void => {
          try {
            localStorage.setItem(`spider_${self.key}_${key}`, val);
          } catch {
            /* ignore */
          }
        },
      },

      atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
      btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
      Buffer,
      ArrayBuffer,
      Uint8Array,
      // Note: do NOT pass Object/Array/String/Number/Boolean/RegExp/Error/etc.
      // to the sandbox. VM has its own built-in prototypes, and primitive
      // literals (e.g. "") use the VM's String.prototype, NOT the host's.
      // If we shadow with host builtins, drpy2's
      //   Object.defineProperty(String.prototype, "rstrip", ...)
      // would define on the host's String.prototype, but VM primitive strings
      // would still look up methods on the VM's String.prototype and fail
      // with "X is not a function". Letting the VM use its own builtins
      // ensures prototype modifications affect VM primitive values.
      JSON,
      Math,
      Date,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      encodeURIComponent,
      decodeURIComponent,
      encodeURI,
      decodeURI,

      // cheerio available as global for spiders that need it.
      // Use cheerioWithJinja so drpy2's cheerio.jinja2() calls work.
      cheerio: cheerioWithJinja,
      // Alias __cheerio__ for DRPY_CORE_LITE_STUB which exports it as named export
      __cheerio__: cheerioWithJinja,

      // CryptoJS as global: drpy2's getOriginalJs() uses CryptoJS directly
      // for AES decryption of encrypted rule files (e.g., 酷我听书).
      CryptoJS,
    };

    // Browser-compatible globals: some spiders reference `window`, `document`,
    // `navigator`, or `self`. Provide minimal mocks so they don't throw
    // ReferenceError. `window`/`self`/`globalThis` point to the sandbox itself
    // so global var assignments (e.g. `window.foo = 1`) persist.
    this.sandbox.window = this.sandbox;
    this.sandbox.self = this.sandbox;
    this.sandbox.globalThis = this.sandbox;
    this.sandbox.navigator = {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      platform: 'Win32',
      language: 'zh-CN',
    };
    this.sandbox.document = {
      cookie: '',
      title: '',
      URL: '',
      referrer: '',
      createElement: () => ({
        style: {},
        setAttribute: () => {},
        appendChild: () => {},
        href: '',
        src: '',
      }),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    this.sandbox.location = {
      href: '',
      protocol: 'https:',
      host: '',
      hostname: '',
      port: '',
      pathname: '/',
      search: '',
      hash: '',
    };

    // Note: codeGeneration.strings=true is set, but Electron's renderer
    // process CSP still blocks eval() inside VM contexts. We work around
    // this by replacing drpy2's eval() calls with __hostEval, which uses
    // vm.runInContext to execute code (vm.runInContext is NOT blocked).
    this.context = vm.createContext(this.sandbox, {
      codeGeneration: { strings: true },
    });
    console.log('[JsSpider] createContext with codeGeneration.strings=true');

    // Pre-evaluate the muban stub so `muban` is available as a global
    // variable. Some drpy spiders reference `muban` directly (e.g.
    // `var rule = {...muban.mxpro}`) without importing it, which throws
    // "ReferenceError: muban is not defined" during init.
    //
    // We wrap in an IIFE so `var muban` and `var 模板` are scoped to the
    // IIFE and NOT leaked to the global scope. We then expose only
    // `globalThis.muban` — this way, when spider code does
    // `import 模板 from "..."` (transpiled to `const 模板 = __require__(...)`),
    // there is no `var 模板` at global scope to conflict with the const
    // declaration (which would throw SyntaxError "Identifier '模板' has
    // already been declared").
    try {
      vm.runInContext(
        `(function(){${DRPY_MUBAN_STUB}\nglobalThis.muban = muban;})();`,
        this.context,
        { timeout: 5000 },
      );
    } catch (e) {
      console.warn('[JsSpider] Failed to pre-evaluate muban stub:', e);
    }

    // Inject __safeDP__ as a VM-side function. This must run inside the VM
    // so that it uses the VM's own Object.defineProperty and operates on
    // the VM's built-in prototypes (which are distinct from host prototypes).
    // drpy2.min.js calls Object.defineProperty(Object.prototype, "myValues", ...)
    // without configurable:true; the first call makes the property
    // non-configurable, and subsequent inits fail with "Cannot redefine
    // property". __safeDP__ forces configurable:true and swallows errors.
    // We replace these calls via neutralizeProtoDefineProperty() so they go
    // through this helper.
    vm.runInContext(
      `globalThis.__safeDP__ = function(obj, prop, desc) {
         try {
           return Object.defineProperty(obj, prop, Object.assign({}, desc, { configurable: true }));
         } catch (e) {
           return obj;
         }
       };
       globalThis.__safeDP__;`,
      this.context,
      { timeout: 5000 },
    );
  }

  private wrapCode(code: string, noIIFE: boolean = false): string {
    if (noIIFE) {
      // For drpy2: don't wrap in IIFE. drpy2's eval() calls (replaced with
      // __hostEval) run at VM context top-level. If we wrap in IIFE, drpy2's
      // top-level functions (request, fetch, pdfh, pdfa, pd, log, print,
      // cheerio, CryptoJS, HOST, etc.) become IIFE-scoped and __hostEval
      // can't access them. Without IIFE, all `var`/`function` declarations
      // become globalThis properties, accessible from __hostEval.
      return `var exports = __exports__;
            var module = { exports: __exports__ };
            ${code}
            // Format 1: __jsEvalReturn function (set cat=true)
            if (typeof __jsEvalReturn === 'function') {
                __spider__ = __jsEvalReturn(true);
            }
            // Format 3: __JS_SPIDER__ global assignment
            if (!__spider__ && typeof __JS_SPIDER__ !== 'undefined') {
                __spider__ = __JS_SPIDER__;
            }
            // If __spider__ was not set by transpilation or above formats,
            // check if module.exports has spider methods
            if (!__spider__ && module.exports && Object.keys(module.exports).length > 0) {
                __spider__ = module.exports;
            }`;
    }
    return `(function() {
            var exports = __exports__;
            var module = { exports: __exports__ };
            ${code}
            // Format 1: __jsEvalReturn function (set cat=true)
            if (typeof __jsEvalReturn === 'function') {
                __spider__ = __jsEvalReturn(true);
            }
            // Format 3: __JS_SPIDER__ global assignment
            if (!__spider__ && typeof __JS_SPIDER__ !== 'undefined') {
                __spider__ = __JS_SPIDER__;
            }
            // If __spider__ was not set by transpilation or above formats,
            // check if module.exports has spider methods
            if (!__spider__ && module.exports && Object.keys(module.exports).length > 0) {
                __spider__ = module.exports;
            }
        })();`;
  }

  private resolveSpiderObject(): void {
    // __spider__ should already be set by the wrapped code
    if (this.sandbox.__spider__) {
      this.spiderObj = this.sandbox.__spider__;
      return;
    }
    // Fallback: check __exports__
    if (
      this.sandbox.__exports__ &&
      Object.keys(this.sandbox.__exports__).length > 0
    ) {
      this.spiderObj = this.sandbox.__exports__;
      this.sandbox.__spider__ = this.spiderObj;
      return;
    }
    console.warn(`[JsSpider] No spider object found for ${this.key}`);
  }

  /**
   * Custom require function injected into vm context.
   * - Maps common module names to Node.js packages
   * - Downloads URL-based imports, transpiles, and caches
   * - Resolves relative imports against the spider's base URL
   */
  private __require(moduleName: string): any {
    // Built-in module mappings
    const builtinMap: Record<string, any> = {
      cheerio: cheerioWithJinja,
      'crypto-js': CryptoJS,
      zlib: nodeRequire ? nodeRequire('zlib') : undefined,
      pako: nodeRequire ? nodeRequire('pako') : undefined,
      https: nodeRequire ? nodeRequire('https') : undefined,
      http: nodeRequire ? nodeRequire('http') : undefined,
      url: nodeRequire ? nodeRequire('url') : undefined,
      querystring: nodeRequire ? nodeRequire('querystring') : undefined,
    };

    if (builtinMap[moduleName]) {
      return builtinMap[moduleName];
    }

    // assets:// protocol — Android TVBox maps these to bundled JS files.
    // We map common assets:// paths to our built-in modules.
    if (moduleName.startsWith('assets://')) {
      const assetPath = moduleName.substring('assets://'.length);
      if (assetPath.includes('cheerio')) {
        return cheerioWithJinja;
      }
      if (assetPath.includes('crypto-js') || assetPath.includes('crypto')) {
        return CryptoJS;
      }
      // Other assets:// modules are not available, return empty object
      console.warn(`[JsSpider] assets:// module not available: ${moduleName}`);
      return {};
    }

    // URL-based import
    if (moduleName.startsWith('http://') || moduleName.startsWith('https://')) {
      // Intercept cheerio URLs — the remote cheerio.min.js throws
      // "Illegal break statement" when re-evaluated in vm context.
      // Use the host-side cheerio (with jinja2) instead.
      if (moduleName.includes('cheerio')) {
        return cheerioWithJinja;
      }
      return this.loadUrlModule(moduleName);
    }

    // Relative import (./xxx or ../xxx)
    if (moduleName.startsWith('./') || moduleName.startsWith('../')) {
      const resolvedUrl = joinUrl(this.baseUrl, moduleName);
      return this.loadUrlModule(resolvedUrl);
    }

    // Try Node.js require as fallback (may not work in renderer)
    try {
      if (nodeRequire) return nodeRequire(moduleName);
      return {};
    } catch {
      console.warn(`[JsSpider] Cannot resolve module: ${moduleName}`);
      return {};
    }
  }

  private loadUrlModule(url: string): any {
    const cached = moduleSourceCache.get(url);
    if (cached) {
      // Re-evaluate cached transpiled source in our context
      // Save and restore __exports__ to avoid pollution
      const savedExports = this.sandbox.__exports__;
      this.sandbox.__exports__ = {};
      try {
        vm.runInContext(cached, this.context!, { timeout: 10000 });
        const result = this.sandbox.__exports__ || {};
        this.sandbox.__exports__ = savedExports;
        return result;
      } catch (e: any) {
        const errInfo = {
          message: e?.message || String(e),
          stack: (e?.stack || '').substring(0, 800),
          name: e?.name,
          code: e?.code,
          typeof: typeof e,
          keys: e && typeof e === 'object' ? Object.keys(e).slice(0, 10) : null,
        };
        console.warn(
          `[JsSpider] Failed to evaluate cached module ${url}:`,
          JSON.stringify(errInfo),
        );
        // Log the cached source preview for debugging
        console.warn(
          `[JsSpider] Cached source preview (first 300): ${(cached || '').substring(0, 300).replace(/\n/g, '\\n')}`,
        );
        this.sandbox.__exports__ = savedExports;
        return {};
      }
    }

    // Synchronous fetch is not possible; we do a best-effort with a cached approach.
    // For URL modules, we need to download first. Since __require is called
    // synchronously from within vm, we pre-load commonly needed modules.
    // Real async module loading would require a different architecture.
    console.warn(`[JsSpider] URL module not pre-loaded: ${url}`);
    return {};
  }

  /**
   * Pre-load a URL module and cache its transpiled source.
   * Call this before evaluating the spider if it has known URL dependencies.
   * On fetch failure, fall back to a built-in stub for known drpy2 modules
   * (down.nigx.cn is frequently blocked by Cloudflare).
   */
  async preloadUrlModule(url: string): Promise<void> {
    if (moduleSourceCache.has(url)) return;

    // For URLs with local stubs, prefer the stub over remote fetch.
    // Remote files like drpy-core-lite.min.js have complex ESM patterns
    // (export { ... }, export *) that our transpiler can't fully handle.
    // Local stubs are simpler and provide the essential exports.
    const stub = getLocalStubForUrl(url);
    if (stub) {
      const wrapped = `(function() { var exports = __exports__; var module = { exports: __exports__ }; ${stub} })();`;
      moduleSourceCache.set(url, wrapped);
      console.log(
        `[JsSpider] using local stub for ${url} (${stub.length} bytes)`,
      );
      return;
    }

    try {
      // Route through main process IPC: browsers refuse to set User-Agent
      // and Referer headers on fetch/XHR, but hosts like down.nigx.cn
      // return 403 without a browser-like UA.
      // Try multiple sources for electronIPC since preload exposure is unreliable.
      let electronIPC: any = (globalThis as any).electronIPC;
      if (!electronIPC && typeof (globalThis as any).window !== 'undefined') {
        electronIPC = (globalThis as any).window.electronIPC;
      }
      if (!electronIPC) {
        // Fallback: with nodeIntegration:true, we can require('electron') directly
        try {
          const { ipcRenderer } = (globalThis as any).require('electron');
          electronIPC = {
            invoke: (channel: string, ...args: any[]) =>
              ipcRenderer.invoke(channel, ...args),
          };
        } catch {
          // No electron available
        }
      }
      let body = '';
      let fetchFailed = false;
      if (electronIPC && typeof electronIPC.invoke === 'function') {
        const res = await electronIPC.invoke('js:fetchModule', url);
        if (!res || !res.ok) {
          fetchFailed = true;
          console.warn(
            `[JsSpider] IPC fetch failed for ${url}: ${res?.status || 0} ${res?.error || ''}, will try stub`,
          );
        } else {
          body = res.body;
          // gh-proxy.net returns HTTP 200 with an HTML interstitial
          // ("Loading..." page with JWT redirect) instead of the actual JS
          // content. Treat this as a failed fetch so we fall through to
          // mirror fallback (ghproxy.net serves the real file directly).
          if (isHtmlInterstitial(body)) {
            console.warn(
              `[JsSpider] IPC fetch returned HTML interstitial for ${url}, trying mirrors`,
            );
            body = '';
            fetchFailed = true;
          }
        }
      } else {
        // Fallback to axios (may fail with 403 on strict hosts)
        try {
          const resp = await axios.get(url, {
            responseType: 'text',
            timeout: 15000,
          });
          body =
            typeof resp.data === 'string'
              ? resp.data
              : JSON.stringify(resp.data);
          if (isHtmlInterstitial(body)) {
            console.warn(
              `[JsSpider] axios returned HTML interstitial for ${url}, trying mirrors`,
            );
            body = '';
            fetchFailed = true;
          }
        } catch (e: any) {
          fetchFailed = true;
          console.warn(
            `[JsSpider] axios fetch failed for ${url}: ${e.message}, will try stub`,
          );
        }
      }

      if (fetchFailed && !body) {
        // Try GitHub mirror fallback before giving up
        try {
          body = await fetchMirrorOnly(url, {
            responseType: 'text',
            timeout: 15000,
          });
          fetchFailed = false;
        } catch (mirrorErr: any) {
          // Mirrors also failed, fall through to stub
        }
      }

      if (fetchFailed && !body) {
        // Use a local stub for known drpy2 URL modules
        const stub = getLocalStubForUrl(url);
        if (stub) {
          const wrapped = `(function() { var exports = __exports__; var module = { exports: __exports__ }; ${stub} })();`;
          moduleSourceCache.set(url, wrapped);
          console.log(
            `[JsSpider] using local stub for ${url} (${stub.length} bytes)`,
          );
          return;
        }
        // No stub available, return empty
        console.error(`[JsSpider] No stub available for ${url}`);
        return;
      }

      let code = body;
      code = decodeBytecode(code);
      code = transpileESM(code);
      const wrapped = `(function() { var exports = __exports__; var module = { exports: __exports__ }; ${code} })();`;
      moduleSourceCache.set(url, wrapped);
      console.log(`[JsSpider] preloaded module ${url} (${body.length} bytes)`);
    } catch (e: any) {
      console.error(
        `[JsSpider] Failed to preload module ${url}:`,
        e.message || e,
      );
    }
  }

  private async callSpiderMethod(
    method: string,
    ...args: any[]
  ): Promise<string> {
    if (!this.spiderObj || typeof this.spiderObj[method] !== 'function') {
      console.warn(`[JsSpider] ${method}() not found for ${this.key}`);
      return '{}';
    }
    try {
      const argsJson = args.map((a) => JSON.stringify(a)).join(',');
      const expr = `__spider__.${method}(${argsJson})`;
      console.log(
        `[JsSpider] calling ${method}() for ${this.key}, args=[${argsJson.substring(0, 200)}${argsJson.length > 200 ? '...' : ''}]`,
      );
      const result = vm.runInContext(expr, this.context!, { timeout: 30000 });
      let resolvedResult: any;
      if (result && typeof result.then === 'function') {
        resolvedResult = await result;
      } else {
        resolvedResult = result;
      }
      const output =
        typeof resolvedResult === 'string'
          ? resolvedResult
          : JSON.stringify(resolvedResult);
      let logResult: any;
      try {
        logResult = JSON.parse(output);
      } catch {
        logResult = output;
      }
      console.log(
        `[JsSpider] ${method}() for ${this.key} returned:`,
        logResult,
      );
      return output;
    } catch (e) {
      console.error(`[JsSpider] ${method}() error for ${this.key}:`, e);
      return '{}';
    }
  }

  private callSpiderMethodSync(method: string, ...args: any[]): any {
    if (!this.spiderObj || typeof this.spiderObj[method] !== 'function') {
      return null;
    }
    try {
      const argsJson = args.map((a) => JSON.stringify(a)).join(',');
      const expr = `__spider__.${method}(${argsJson})`;
      return vm.runInContext(expr, this.context!, { timeout: 10000 });
    } catch (e) {
      console.error(`[JsSpider] ${method}() sync error for ${this.key}:`, e);
      return null;
    }
  }
}
