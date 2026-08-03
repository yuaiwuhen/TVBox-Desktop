/**
 * Normalizer for itv666 (AowuShinidie) spider responses with obfuscated
 * field names.
 *
 * Some itv666 spiders (e.g. Douban, woWogg, AppV6) return JSON with
 * obfuscated top-level keys and item field names instead of the standard
 * TVBox format (`list`, `class`, `filters`, `vod_name`, `vod_pic`, etc.).
 *
 * The obfuscation maps standard names to mixed-case O/o strings like
 * `O0OoO0OoOoOo0oO0oO`. The mapping is CONSISTENT across itv666 spiders
 * for the same semantic field, but the SAME obfuscated string can mean
 * different things in different contexts (e.g. `oOo0Oo0oO0Oo0O0Oo0` is
 * `vod_id` in list items but `type_name` in class items, and is also the
 * top-level key for the `list` array in some responses).
 *
 * This module uses a STATIC FIELD MAP for known obfuscated fields (precise)
 * and falls back to structural heuristics for unknown fields:
 *   - The `list` array is the only top-level array of objects whose items
 *     contain a URL-like field value (vod_pic).
 *   - The `class` array is a top-level array of objects whose fields are
 *     all short strings (type_id + type_name).
 */

/**
 * Static mapping for itv666 obfuscated field names in LIST ITEMS.
 * The obfuscation is consistent across spiders in the itv666 family.
 * Keys were collected by sampling detail/search responses from multiple
 * sources (AppV6Dxs, JinPai, Bddj, Qmdj, Xydj, Rbys, HuyaLive, etc.).
 */
const OBF_LIST_ITEM_FIELDS: Record<string, string> = {
  O0OoO0OoOoOo0oO0oO: 'vod_name',
  O0o0oOoOo0oOoO0o0O: 'vod_pic',
  O0oOoOoO0O0O0O0o0O: 'vod_remarks',
  oOo0Oo0oO0Oo0O0Oo0: 'vod_id',
  o0OoO0o0Oo0o0o0OoO: 'vod_play_url',
  oO0O0O0O0oOoO0O0Oo: 'vod_play_from',
  O0O0o0OoOo0oO0oO0o: 'vod_area',
  o0OoO0oO0oOoO0O0oO: 'vod_class',
  o0o0o0oOoO0oOo0OoO: 'vod_year',
  o0o0oO0o0O0O0OoOo0: 'vod_actor',
  oO0o0O0O0o0o0oOo0o: 'vod_director',
  oOoO0O0O0o0oOoOoO0: 'vod_content',
  // Folder/cover marker — value is "folder" for SeedHub pan-style items
  // whose vod_id is a path (e.g. "/movies/117429/_tid_1"). Maps to vod_tag
  // so isFolderItem() detects them and navigates via categoryContent.
  o0o0o0OoOo0o0oO0oO: 'vod_tag',
};

/**
 * Static mapping for itv666 obfuscated field names in CLASS ITEMS.
 * Note: `oOo0Oo0oO0Oo0O0Oo0` is type_name here (but vod_id in list items).
 */
const OBF_CLASS_ITEM_FIELDS: Record<string, string> = {
  o0OoO0oO0oOoO0O0oO: 'type_id',
  oOo0Oo0oO0Oo0O0Oo0: 'type_name',
};

/**
 * Check if a string looks like a URL (http/https).
 */
function isUrlLike(v: unknown): boolean {
  return typeof v === 'string' && /^https?:\/\//.test(v);
}

/**
 * Check if a string looks like a vod_remarks (rating, episode count, etc.).
 * Examples: "评分：7.5", "更新至第10集", "HD", "2026".
 */
function isRemarksLike(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  return (
    v.startsWith('评分') ||
    v.startsWith('更新') ||
    v.startsWith('完结') ||
    v.startsWith('第') ||
    /^(HD|BD|DVD|VCD|TS|TC|4K|1080|720|蓝光|超清|高清|正片|预告)$/i.test(v)
  );
}

/**
 * Check if a string looks like a vod_id.
 * Examples: "msearch:37450627", "12345", "/index.php/vod/detail/id/186096.html".
 */
function isVodIdLike(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  if (v.startsWith('msearch:')) return true;
  if (/^\d+$/.test(v)) return true;
  if (v.includes('/vod/') || v.includes('/detail/')) return true;
  return false;
}

/**
 * Check if an object has any known obfuscated field name.
 * Used to decide whether to apply the static map (precise) or heuristic.
 */
function hasObfFields(item: any, map: Record<string, string>): boolean {
  if (!item || typeof item !== 'object') return false;
  for (const k of Object.keys(item)) {
    if (map[k]) return true;
  }
  return false;
}

/**
 * Normalize a single list item.
 * Strategy:
 *   1. If item already has standard vod_name/vod_pic/vod_id, return as-is.
 *   2. If item has known obfuscated fields, use the static map (precise).
 *   3. Otherwise, fall back to value-based heuristics.
 */
function normalizeListItem(item: any): any {
  if (!item || typeof item !== 'object') return item;

  // Already has standard fields — no need to normalize
  if (item.vod_name || item.vod_pic || item.vod_id) {
    return item;
  }

  const normalized: any = { ...item };

  // If item has known obfuscated fields, use the static map.
  // This handles itv666 detail/search/list items precisely.
  if (hasObfFields(item, OBF_LIST_ITEM_FIELDS)) {
    for (const [obfKey, stdKey] of Object.entries(OBF_LIST_ITEM_FIELDS)) {
      if (item[obfKey] !== undefined && normalized[stdKey] === undefined) {
        normalized[stdKey] = item[obfKey];
      }
    }
    return normalized;
  }

  // Fallback: value-based heuristics for unknown obfuscation schemes.
  let hasVodName = false;
  for (const [k, v] of Object.entries(item)) {
    if (isUrlLike(v) && !normalized.vod_pic) {
      normalized.vod_pic = v as string;
    } else if (isRemarksLike(v) && !normalized.vod_remarks) {
      normalized.vod_remarks = v as string;
    } else if (isVodIdLike(v) && !normalized.vod_id) {
      normalized.vod_id = v as string;
    } else if (
      typeof v === 'string' &&
      v.length > 0 &&
      v.length < 200 &&
      !hasVodName &&
      !isUrlLike(v) &&
      !isRemarksLike(v) &&
      !isVodIdLike(v)
    ) {
      normalized.vod_name = v;
      hasVodName = true;
    }
  }

  return normalized;
}

/**
 * Check if an object looks like a class/category item: only 2 short string
 * fields, no URL. Used to exclude class arrays from list-array detection.
 */
function isClassStyleItem(item: any): boolean {
  if (!item || typeof item !== 'object') return false;
  const entries = Object.entries(item);
  if (entries.length === 0 || entries.length > 2) return false;
  return entries.every(
    ([, val]) => typeof val === 'string' && val.length < 50 && !isUrlLike(val),
  );
}

/**
 * Find the top-level array of objects that looks like a video list.
 * Two-pass strategy:
 *   1. Prefer arrays whose first item has a URL-like field value (vod_pic).
 *   2. Fall back to arrays whose first item has known obfuscated list-item
 *      fields AND is not a class-style item (only 2 short string fields).
 *
 * The two-pass split is necessary because obfuscated class items contain
 * `oOo0Oo0oO0Oo0O0Oo0` (which maps to `type_name` in class context but
 * `vod_id` in list context). A single-pass scan would return the class
 * array (which appears first in the JSON) instead of the real list array.
 */
function findListArray(obj: any): { key: string; arr: any[] } | null {
  // Pass 1: arrays with URL-like field values.
  for (const [k, v] of Object.entries(obj)) {
    if (!Array.isArray(v) || v.length === 0) continue;
    if (typeof v[0] !== 'object' || v[0] === null) continue;
    const firstItem = v[0];
    if (Object.values(firstItem).some(isUrlLike)) {
      return { key: k, arr: v };
    }
  }
  // Pass 2: arrays with obfuscated list-item fields, excluding class-style.
  // This catches detailContent responses where the single vod_info item has
  // vod_name/vod_id/vod_play_url but no URL (vod_pic) field.
  for (const [k, v] of Object.entries(obj)) {
    if (!Array.isArray(v) || v.length === 0) continue;
    if (typeof v[0] !== 'object' || v[0] === null) continue;
    const firstItem = v[0];
    if (isClassStyleItem(firstItem)) continue;
    if (hasObfFields(firstItem, OBF_LIST_ITEM_FIELDS)) {
      return { key: k, arr: v };
    }
  }
  return null;
}

/**
 * Find the top-level array of objects that looks like a class/category list.
 * Heuristic: the array's items have only short string fields (type_id +
 * type_name), no URL-like values.
 */
function findClassArray(obj: any): { key: string; arr: any[] } | null {
  for (const [k, v] of Object.entries(obj)) {
    if (!Array.isArray(v) || v.length === 0) continue;
    if (typeof v[0] !== 'object' || v[0] === null) continue;

    const firstItem = v[0];
    const values = Object.values(firstItem);
    // All values should be short strings (no URLs, no long strings)
    const allShortStrings = values.every(
      (val) => typeof val === 'string' && val.length < 50 && !isUrlLike(val),
    );
    if (allShortStrings && values.length >= 2) {
      return { key: k, arr: v };
    }
  }
  return null;
}

/**
 * Normalize a class item: {obf_type_id: "1", obf_type_name: "电影"} →
 * {type_id: "1", type_name: "电影"}.
 * Uses the static obfuscated field map when applicable, otherwise falls
 * back to position-based mapping (first string = type_id, second = type_name).
 */
function normalizeClassItem(item: any): any {
  if (!item || typeof item !== 'object') return item;
  if (item.type_id !== undefined || item.type_name !== undefined) return item;

  const normalized: any = { ...item };

  // If item has known obfuscated class fields, use the static map.
  if (hasObfFields(item, OBF_CLASS_ITEM_FIELDS)) {
    for (const [obfKey, stdKey] of Object.entries(OBF_CLASS_ITEM_FIELDS)) {
      if (item[obfKey] !== undefined && normalized[stdKey] === undefined) {
        normalized[stdKey] = item[obfKey];
      }
    }
    return normalized;
  }

  // Fallback: position-based mapping.
  const stringEntries = Object.entries(item).filter(
    ([, v]) => typeof v === 'string',
  );
  if (stringEntries.length >= 1 && normalized.type_id === undefined) {
    normalized.type_id = stringEntries[0][1];
  }
  if (stringEntries.length >= 2 && normalized.type_name === undefined) {
    normalized.type_name = stringEntries[1][1];
  }
  return normalized;
}

/**
 * Check if a response object has standard TVBox field names.
 */
function hasStandardFields(obj: any): boolean {
  return (
    obj &&
    typeof obj === 'object' &&
    (obj.list !== undefined ||
      obj.class !== undefined ||
      obj.filters !== undefined)
  );
}

/**
 * Normalize a categoryContent response.
 * If the response has standard fields, return as-is.
 * Otherwise, find the obfuscated list array and map item fields.
 */
export function normalizeCategoryContentResponse(raw: any): any {
  if (!raw || typeof raw !== 'object') return raw;
  if (hasStandardFields(raw)) return raw;

  const listResult = findListArray(raw);
  if (!listResult) return raw;

  const normalizedList = listResult.arr.map(normalizeListItem);
  const result: any = { ...raw, list: normalizedList };

  // Map common pagination fields if present
  // (obfuscated page/pagecount/total — we leave them as-is since the
  // parser falls back to defaults)

  return result;
}

/**
 * Normalize a homeContent response.
 * If the response has standard fields, return as-is.
 * Otherwise, find obfuscated class array and list array, map fields.
 */
export function normalizeHomeContentResponse(raw: any): any {
  if (!raw || typeof raw !== 'object') return raw;
  if (hasStandardFields(raw)) return raw;

  const result: any = { ...raw };

  // Find class array
  const classResult = findClassArray(raw);
  if (classResult) {
    result.class = classResult.arr.map(normalizeClassItem);
  }

  // Find vod list array (top-level). itv666 homeContent returns both
  // class array and vod list array at top level with obfuscated keys
  // (e.g. Douban returns list under `oOo0Oo0oO0Oo0O0Oo0`).
  const listResult = findListArray(raw);
  if (listResult) {
    result.list = listResult.arr.map(normalizeListItem);
  }

  return result;
}

/**
 * Normalize a searchContent response.
 * Same logic as categoryContent.
 */
export function normalizeSearchContentResponse(raw: any): any {
  return normalizeCategoryContentResponse(raw);
}

/**
 * Normalize a detailContent response.
 * The detail response usually has a single vod_info object with obfuscated
 * fields. Map them by value pattern.
 */
export function normalizeDetailContentResponse(raw: any): any {
  if (!raw || typeof raw !== 'object') return raw;
  if (raw.list && Array.isArray(raw.list)) return raw;

  // detailContent returns {list: [vodInfo]} in standard format
  // Obfuscated format might have the vod info at top level or under a
  // different key
  const result: any = { ...raw };

  // If there's a list array, normalize it
  const listResult = findListArray(raw);
  if (listResult) {
    result.list = listResult.arr.map(normalizeListItem);
  }

  return result;
}
