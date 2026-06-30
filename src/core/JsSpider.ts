import axios from 'axios';
import CryptoJS from 'crypto-js';
import * as cheerio from 'cheerio';
import type { ISpider } from './models';

// Node.js builtins - use require() at runtime since Vite doesn't bundle them
const vm: typeof import('vm') =
  (globalThis as any).require?.('vm') || require('vm');
let nodeRequire: ((id: string) => any) | undefined;
try {
  nodeRequire =
    (globalThis as any).require?.('module')?.createRequire?.(import.meta.url) ||
    require;
} catch {
  nodeRequire = undefined;
}

let forge: any;
try {
  forge = require('node-forge');
} catch {
  forge = null;
}

// ─── Module source cache (URL → transpiled source) ─────────────────────────
const moduleSourceCache: Map<string, string> = new Map();

// ─── ESM → CJS transpilation ───────────────────────────────────────────────

function transpileESM(code: string): string {
  let out = code;

  // 1. import * as X from 'Y'
  out = out.replace(
    /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    "const $1 = __require__('$2');",
  );

  // 2. import { X, Y } from 'Z'
  out = out.replace(
    /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    (_match, names: string, mod: string) => {
      return `const { ${names.trim()} } = __require__('${mod}');`;
    },
  );

  // 3. import X from 'Y'
  out = out.replace(
    /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    "const $1 = __require__('$2');",
  );

  // 4. export default { ... } — replace with assignment to __exports__
  out = out.replace(/export\s+default\s+/g, '__exports_default__ = ');

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

  constructor(key: string, api: string, ext?: string) {
    this.key = key;
    this.api = api;
    this.ext = ext || '';
    this.baseUrl = api.substring(0, api.lastIndexOf('/') + 1);
  }

  // ── ISpider interface ────────────────────────────────────────────────

  async init(extend: string): Promise<void> {
    this.ext = extend || this.ext;
    console.log(
      `[JsSpider] init: key=${this.key}, api=${this.api}, ext=${this.ext.substring(0, 80)}`,
    );

    // Download JS source
    // Note: browsers block User-Agent header in fetch/XHR, so we omit it.
    // The spider JS files are public and accept any UA.
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

    // Transpile ESM → CJS
    code = transpileESM(code);

    // Build vm context with all global injections
    this.buildContext();

    // Wrap and evaluate
    const wrapped = this.wrapCode(code);
    try {
      vm.runInContext(wrapped, this.context!, { timeout: 10000 });
      console.log(`[JsSpider] code evaluated successfully for ${this.key}`);
    } catch (e) {
      throw new Error(`[JsSpider] Failed to evaluate spider ${this.key}: ${e}`);
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
        const result = vm.runInContext(
          `__spider__.init(${JSON.stringify(this.ext)})`,
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

      // HTTP request
      req: async (url: string, options: any = {}) => {
        try {
          const resp = await axios({
            url,
            method: options.method || 'GET',
            headers: options.headers || {},
            data: options.body || options.data || undefined,
            responseType:
              options.responseType || (options.buffer ? 'arraybuffer' : 'text'),
            timeout: options.timeout || 15000,
          });
          return {
            content: resp.data,
            headers: resp.headers as Record<string, string>,
            code: resp.status,
          };
        } catch (e: any) {
          return { content: '', headers: {}, code: 500, error: e.message };
        }
      },

      // HTML parsing
      pdfh,
      pdfa,
      pd,
      pdfla,

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

      // Standard globals
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
      atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
      btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
      Buffer,
      ArrayBuffer,
      Uint8Array,
      Object,
      Array,
      String,
      Number,
      Boolean,
      RegExp,
      Error,
      TypeError,
      RangeError,
      Promise,
      Map,
      Set,
      Symbol,

      // cheerio available as global for spiders that need it
      cheerio,
    };

    this.context = vm.createContext(this.sandbox);
  }

  private wrapCode(code: string): string {
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
      cheerio: cheerio,
      'crypto-js': CryptoJS,
    };

    if (builtinMap[moduleName]) {
      return builtinMap[moduleName];
    }

    // URL-based import
    if (moduleName.startsWith('http://') || moduleName.startsWith('https://')) {
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
      try {
        vm.runInContext(cached, this.context!, { timeout: 10000 });
      } catch {
        /* ignore */
      }
      return this.sandbox.__exports__ || {};
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
   */
  async preloadUrlModule(url: string): Promise<void> {
    if (moduleSourceCache.has(url)) return;
    try {
      const resp = await axios.get(url, {
        responseType: 'text',
        timeout: 15000,
      });
      let code =
        typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
      code = decodeBytecode(code);
      code = transpileESM(code);
      const wrapped = `(function() { var exports = __exports__; var module = { exports: __exports__ }; ${code} })();`;
      moduleSourceCache.set(url, wrapped);
    } catch (e) {
      console.error(`[JsSpider] Failed to preload module ${url}:`, e);
    }
  }

  private async callSpiderMethod(
    method: string,
    ...args: any[]
  ): Promise<string> {
    if (!this.spiderObj || typeof this.spiderObj[method] !== 'function') {
      return '{}';
    }
    try {
      const argsJson = args.map((a) => JSON.stringify(a)).join(',');
      const expr = `__spider__.${method}(${argsJson})`;
      const result = vm.runInContext(expr, this.context!, { timeout: 30000 });
      if (result && typeof result.then === 'function') {
        const resolved = await result;
        return typeof resolved === 'string'
          ? resolved
          : JSON.stringify(resolved);
      }
      return typeof result === 'string' ? result : JSON.stringify(result);
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
