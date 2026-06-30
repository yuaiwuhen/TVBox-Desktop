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
      const list = Array.isArray(data) ? data : data.data || [];
      for (const item of list) {
        items.push({
          text: String(item.text || item.content || ''),
          time:
            Number(item.time || item.progress || 0) /
            (item.time !== undefined && item.time > 1000 ? 1000 : 1),
          color: normalizeColor(item.color || '#ffffff'),
          type: Number(item.type || 0),
          fontSize: Number(item.fontSize || item.fontsize || 24),
          timestamp: Number(item.timestamp || 0),
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

        const text = el.textContent || '';

        items.push({
          text,
          time: parseFloat(parts[0]) || 0,
          type: parseInt(parts[1]) || 0,
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
