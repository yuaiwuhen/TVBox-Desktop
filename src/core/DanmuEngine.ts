export interface DanmuItem {
  text: string;
  time: number; // seconds
  color: string; // hex color
  type: number; // 0=scroll right-to-left, 1=top fixed, 2=bottom fixed
  fontSize: number;
  timestamp: number; // original timestamp
}

export class DanmuEngine {
  private items: DanmuItem[] = [];
  private currentIndex: number = 0;
  private enabled: boolean = false;
  private opacity: number = 0.7;
  private maxOnScreen: number = 30;
  private speed: number = 8; // seconds to scroll across
  private fontSize: number = 24;

  static parseFromJson(content: string): DanmuItem[] {
    const items: DanmuItem[] = [];
    try {
      const data = JSON.parse(content);
      // Normalize the various shapes TVBox barrage APIs return:
      //  - bare array: [{...}]
      //  - { data: [...] }
      //  - dandanplay: { data: { comments: [{ progress, content, color, type, cid, ... }] } }
      //  - dandanplay v2: { comments: [...] } (or { data: [...] } with count)
      //  - bilibili json: { data: [{ time, text, mode, color }] }
      let list: any[] = [];
      if (Array.isArray(data)) {
        list = data;
      } else if (data && typeof data === 'object') {
        const d = data.data;
        if (Array.isArray(d)) {
          list = d;
        } else if (d && Array.isArray(d.comments)) {
          list = d.comments;
        } else if (Array.isArray(data.comments)) {
          list = data.comments;
        } else if (Array.isArray(d && d.danmaku)) {
          list = d.danmaku;
        } else if (Array.isArray(data.danmaku)) {
          list = data.danmaku;
        }
      }
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        // Bilibili JSON uses "mode" (1-3 scroll / 4 bottom / 5 top); the
        // dandanplay JSON uses "type" (1 scroll / 4 bottom / 5 top).
        const rawType = Number(item.type ?? item.mode ?? 0);
        // Bilibili JSON uses "time" (seconds); dandanplay uses "progress"
        // (milliseconds). Normalize both to seconds.
        const timeRaw = Number(item.time ?? item.progress ?? 0);
        const time =
          item.time !== undefined && item.time !== null
            ? timeRaw
            : timeRaw / 1000;
        items.push({
          text: String(item.text || item.content || item.message || ''),
          time,
          color: normalizeColor(String(item.color ?? item.colour ?? '#ffffff')),
          type: normalizeDanmuType(rawType),
          fontSize: Number(item.fontSize ?? item.fontsize ?? item.size ?? 24),
          timestamp: Number(item.timestamp ?? item.midtime ?? 0),
        });
      }
    } catch {
      // Invalid JSON, return empty
    }
    return items;
  }

  static parseFromXml(content: string): DanmuItem[] {
    const items: DanmuItem[] = [];
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(content, 'text/xml');
      const elements = doc.querySelectorAll('d');

      for (const el of elements) {
        const p = el.getAttribute('p') || '';
        const parts = p.split(',');
        if (parts.length < 4) continue;

        const text = (el.textContent || '').trim();
        if (!text) continue;

        items.push({
          text,
          time: parseFloat(parts[0]) || 0,
          // Bilibili XML: mode 1/2/3 = scroll, 4 = bottom, 5 = top.
          // dandanplay XML: type 1 = scroll, 4 = bottom, 5 = top.
          // Normalize to our internal: 0 scroll, 1 top, 2 bottom.
          type: normalizeDanmuType(parseInt(parts[1]) || 0),
          fontSize: parseInt(parts[2]) || 24,
          color: decimalColorToHex(parseInt(parts[3]) || 16777215),
          timestamp: parseInt(parts[4]) || 0,
        });
      }
    } catch {
      // Invalid XML, return empty
    }
    return items;
  }

  static parseFromText(content: string): DanmuItem[] {
    const items: DanmuItem[] = [];
    const lines = content.trim().replace(/\r\n/g, '\n').split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const commaIdx = trimmed.indexOf(',');
      if (commaIdx === -1) continue;

      const secondCommaIdx = trimmed.indexOf(',', commaIdx + 1);

      let time: number;
      let text: string;
      let color: string;

      if (secondCommaIdx !== -1) {
        time = parseFloat(trimmed.slice(0, commaIdx));
        text = trimmed.slice(commaIdx + 1, secondCommaIdx);
        color = normalizeColor(trimmed.slice(secondCommaIdx + 1));
      } else {
        time = parseFloat(trimmed.slice(0, commaIdx));
        text = trimmed.slice(commaIdx + 1);
        color = '#ffffff';
      }

      items.push({
        text,
        time,
        color,
        type: 0,
        fontSize: 24,
        timestamp: 0,
      });
    }

    return items;
  }

  load(content: string): void {
    const trimmed = content.trim();

    // Auto-detect format
    if (trimmed.startsWith('<') || trimmed.startsWith('<?xml')) {
      this.items = DanmuEngine.parseFromXml(trimmed);
    } else if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      this.items = DanmuEngine.parseFromJson(trimmed);
    } else {
      this.items = DanmuEngine.parseFromText(trimmed);
    }

    this.items.sort((a, b) => a.time - b.time);
    this.currentIndex = 0;
  }

  getItemsAtTime(seconds: number, duration: number): DanmuItem[] {
    if (!this.enabled || this.items.length === 0) return [];

    const windowStart = seconds;
    const windowEnd = seconds + 1;
    const result: DanmuItem[] = [];

    // Advance currentIndex if we've seeked forward
    while (
      this.currentIndex > 0 &&
      this.items[this.currentIndex - 1].time >= windowStart
    ) {
      this.currentIndex--;
    }

    let i = this.currentIndex;
    while (i < this.items.length && this.items[i].time < windowEnd) {
      if (this.items[i].time >= windowStart) {
        result.push(this.items[i]);
      }
      i++;
    }

    // Update currentIndex for next call
    this.currentIndex = i;

    // Apply maxOnScreen limit
    if (result.length > this.maxOnScreen) {
      result.length = this.maxOnScreen;
    }

    return result;
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
  }

  setOpacity(v: number): void {
    this.opacity = Math.max(0, Math.min(1, v));
  }

  setSpeed(v: number): void {
    this.speed = Math.max(1, v);
  }

  setFontSize(v: number): void {
    this.fontSize = Math.max(8, v);
  }

  setMaxOnScreen(v: number): void {
    this.maxOnScreen = Math.max(1, v);
  }

  getSpeed(): number {
    return this.speed;
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

// --- Helper functions ---

/**
 * Normalize the barrage type from the various source conventions into our
 * internal representation:
 *   - 0 = scroll (right-to-left)
 *   - 1 = top fixed
 *   - 2 = bottom fixed
 *
 * Bilibili XML/JSON: mode 1/2/3 = scroll, 4 = bottom, 5 = top.
 * dandanplay:        type 1 = scroll, 4 = bottom, 5 = top.
 * Internal renderer: 0 = scroll, 1 = top, 2 = bottom (as used by renderDanmu).
 */
function normalizeDanmuType(type: number): number {
  if (type === 4) return 2; // bottom
  if (type === 5) return 1; // top
  if (type === 1 || type === 2 || type === 3) return 0; // scroll
  // Some sources already use our internal convention
  if (type === 0 || type === 1 || type === 2) return type;
  return 0;
}

function decimalColorToHex(decimal: number): string {
  const hex = decimal.toString(16).padStart(6, '0');
  return `#${hex}`;
}

function normalizeColor(color: string): string {
  if (!color) return '#ffffff';
  const trimmed = color.trim();
  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    if (hex.length === 3) {
      return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
    }
    return trimmed.toLowerCase();
  }
  // Try parsing as decimal number
  const num = parseInt(trimmed);
  if (!isNaN(num) && num > 0) {
    return decimalColorToHex(num);
  }
  // Try named color or return as-is
  return `#${trimmed}`;
}
