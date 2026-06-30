export interface SubtitleCue {
  startTime: number; // seconds
  endTime: number;
  text: string;
  style?: {
    fontSize?: number;
    color?: string;
    bold?: boolean;
    italic?: boolean;
    position?: string; // top/bottom/middle
  };
}

export class SubtitleEngine {
  private cues: SubtitleCue[] = [];
  private currentIndex: number = 0;
  private fontSize: number = 24;
  private fontColor: string = '#ffffff';
  private fontStyle: string = 'normal';
  private timeDelay: number = 0;

  static parseSrt(content: string): SubtitleCue[] {
    const cues: SubtitleCue[] = [];
    const blocks = content.trim().replace(/\r\n/g, '\n').split(/\n\n+/);

    for (const block of blocks) {
      const lines = block.split('\n');
      if (lines.length < 2) continue;

      // Find the time line (contains "-->")
      let timeLineIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('-->')) {
          timeLineIdx = i;
          break;
        }
      }
      if (timeLineIdx === -1) continue;

      const timeMatch = lines[timeLineIdx].match(
        /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/,
      );
      if (!timeMatch) continue;

      const startTime =
        parseInt(timeMatch[1]) * 3600 +
        parseInt(timeMatch[2]) * 60 +
        parseInt(timeMatch[3]) +
        parseInt(timeMatch[4]) / 1000;
      const endTime =
        parseInt(timeMatch[5]) * 3600 +
        parseInt(timeMatch[6]) * 60 +
        parseInt(timeMatch[7]) +
        parseInt(timeMatch[8]) / 1000;

      const textLines = lines.slice(timeLineIdx + 1);
      const { text, style } = parseHtmlText(textLines.join('\n'));

      cues.push({ startTime, endTime, text, style });
    }

    return cues;
  }

  static parseVtt(content: string): SubtitleCue[] {
    const cues: SubtitleCue[] = [];
    let normalized = content.trim().replace(/\r\n/g, '\n');

    // Remove WEBVTT header and any metadata before the first blank line
    const headerEnd = normalized.indexOf('\n\n');
    if (headerEnd !== -1 && normalized.startsWith('WEBVTT')) {
      normalized = normalized.slice(headerEnd + 2);
    }

    const blocks = normalized.split(/\n\n+/);

    for (const block of blocks) {
      const lines = block.split('\n').filter((l) => l.trim() !== '');
      if (lines.length < 1) continue;

      // Find the time line
      let timeLineIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('-->')) {
          timeLineIdx = i;
          break;
        }
      }
      if (timeLineIdx === -1) continue;

      const timeMatch = lines[timeLineIdx].match(
        /(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})/,
      );
      // Also try MM:SS.mmm format
      const timeMatchShort = !timeMatch
        ? lines[timeLineIdx].match(
            /(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2})\.(\d{3})/,
          )
        : null;

      let startTime: number;
      let endTime: number;
      let position: string | undefined;

      if (timeMatch) {
        startTime =
          parseInt(timeMatch[1]) * 3600 +
          parseInt(timeMatch[2]) * 60 +
          parseInt(timeMatch[3]) +
          parseInt(timeMatch[4]) / 1000;
        endTime =
          parseInt(timeMatch[5]) * 3600 +
          parseInt(timeMatch[6]) * 60 +
          parseInt(timeMatch[7]) +
          parseInt(timeMatch[8]) / 1000;
      } else if (timeMatchShort) {
        startTime =
          parseInt(timeMatchShort[1]) * 60 +
          parseInt(timeMatchShort[2]) +
          parseInt(timeMatchShort[3]) / 1000;
        endTime =
          parseInt(timeMatchShort[4]) * 60 +
          parseInt(timeMatchShort[5]) +
          parseInt(timeMatchShort[6]) / 1000;
      } else {
        continue;
      }

      // Parse position/align from time line after the times
      const timeLine = lines[timeLineIdx];
      const posMatch = timeLine.match(/position:(\d+)%/);
      const alignMatch = timeLine.match(/align:(\w+)/);
      if (posMatch || alignMatch) {
        if (alignMatch) {
          const align = alignMatch[1].toLowerCase();
          if (align === 'top' || align === 'left' || align === 'right') {
            position = 'top';
          } else if (align === 'bottom') {
            position = 'bottom';
          } else {
            position = 'middle';
          }
        } else if (posMatch) {
          const posVal = parseInt(posMatch[1]);
          if (posVal < 33) {
            position = 'top';
          } else if (posVal > 66) {
            position = 'bottom';
          } else {
            position = 'middle';
          }
        }
      }

      const textLines = lines.slice(timeLineIdx + 1);
      const { text, style } = parseHtmlText(textLines.join('\n'));

      cues.push({
        startTime,
        endTime,
        text,
        style: { ...style, position },
      });
    }

    return cues;
  }

  static parseAss(content: string): SubtitleCue[] {
    const cues: SubtitleCue[] = [];
    const normalized = content.trim().replace(/\r\n/g, '\n');

    // Parse styles section
    const styles: Record<string, { fontSize?: number; color?: string }> = {};
    const stylesMatch = normalized.match(/\[V4\+? Styles\]([\s\S]*?)(?=\[|$)/);
    if (stylesMatch) {
      const styleLines = stylesMatch[1].split('\n');
      let formatFields: string[] = [];
      for (const line of styleLines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('Format:')) {
          formatFields = trimmed
            .slice(7)
            .split(',')
            .map((s) => s.trim().toLowerCase());
        } else if (trimmed.startsWith('Style:')) {
          const values = trimmed
            .slice(6)
            .split(',')
            .map((s) => s.trim());
          const name = values[0];
          const style: { fontSize?: number; color?: string } = {};
          for (let i = 0; i < formatFields.length && i < values.length; i++) {
            const field = formatFields[i];
            if (field === 'fontsize') {
              style.fontSize = parseInt(values[i]) || undefined;
            } else if (field === 'primarycolour') {
              style.color = assColorToHex(values[i]);
            }
          }
          styles[name] = style;
        }
      }
    }

    // Parse events section
    const eventsMatch = normalized.match(/\[Events\]([\s\S]*?)(?=\[|$)/);
    if (!eventsMatch) return cues;

    const eventLines = eventsMatch[1].split('\n');
    let formatFields: string[] = [];
    for (const line of eventLines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('Format:')) {
        formatFields = trimmed
          .slice(7)
          .split(',')
          .map((s) => s.trim().toLowerCase());
      } else if (trimmed.startsWith('Dialogue:')) {
        const values = trimmed
          .slice(9)
          .split(',')
          .map((s) => s.trim());
        if (values.length < formatFields.length) continue;

        const getField = (name: string): string => {
          const idx = formatFields.indexOf(name);
          return idx >= 0 && idx < values.length ? values[idx] : '';
        };

        const startStr = getField('start');
        const endStr = getField('end');
        const styleName = getField('style');

        const startTime = parseAssTime(startStr);
        const endTime = parseAssTime(endStr);
        if (isNaN(startTime) || isNaN(endTime)) continue;

        // Text field is the last one and may contain commas
        const textIdx = formatFields.indexOf('text');
        let rawText: string;
        if (textIdx >= 0) {
          // Rejoin everything from textIdx onward
          rawText = values.slice(textIdx).join(',');
        } else {
          rawText = values[values.length - 1];
        }

        const { text, bold, italic } = parseAssText(rawText);

        const baseStyle = styles[styleName] || {};
        const cueStyle: SubtitleCue['style'] = {};
        if (baseStyle.fontSize) cueStyle.fontSize = baseStyle.fontSize;
        if (baseStyle.color) cueStyle.color = baseStyle.color;
        if (bold) cueStyle.bold = true;
        if (italic) cueStyle.italic = true;

        cues.push({
          startTime,
          endTime,
          text,
          style: Object.keys(cueStyle).length > 0 ? cueStyle : undefined,
        });
      }
    }

    return cues;
  }

  static autoParse(content: string): SubtitleCue[] {
    const trimmed = content.trim();
    if (trimmed.startsWith('WEBVTT')) {
      return SubtitleEngine.parseVtt(trimmed);
    }
    if (trimmed.includes('[Script Info]')) {
      return SubtitleEngine.parseAss(trimmed);
    }
    return SubtitleEngine.parseSrt(trimmed);
  }

  load(content: string): void {
    this.cues = SubtitleEngine.autoParse(content);
    this.cues.sort((a, b) => a.startTime - b.startTime);
    this.currentIndex = 0;
  }

  getCueAtTime(seconds: number): SubtitleCue | null {
    if (this.cues.length === 0) return null;

    const adjustedTime = seconds - this.timeDelay;

    // Optimization: check around currentIndex for sequential access
    if (this.currentIndex > 0 && this.currentIndex < this.cues.length) {
      const prev = this.cues[this.currentIndex - 1];
      if (adjustedTime >= prev.startTime && adjustedTime <= prev.endTime) {
        this.currentIndex--;
        return this.applyStyle(prev);
      }
    }

    if (this.currentIndex < this.cues.length) {
      const curr = this.cues[this.currentIndex];
      if (adjustedTime >= curr.startTime && adjustedTime <= curr.endTime) {
        return this.applyStyle(curr);
      }
    }

    if (this.currentIndex + 1 < this.cues.length) {
      const next = this.cues[this.currentIndex + 1];
      if (adjustedTime >= next.startTime && adjustedTime <= next.endTime) {
        this.currentIndex++;
        return this.applyStyle(next);
      }
    }

    // Binary search for the cue
    let lo = 0;
    let hi = this.cues.length - 1;
    let found = -1;

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const cue = this.cues[mid];
      if (adjustedTime >= cue.startTime && adjustedTime <= cue.endTime) {
        found = mid;
        break;
      }
      if (adjustedTime < cue.startTime) {
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }

    if (found === -1) return null;

    this.currentIndex = found;
    return this.applyStyle(this.cues[found]);
  }

  setFontSize(size: number): void {
    this.fontSize = size;
  }

  setFontColor(color: string): void {
    this.fontColor = color;
  }

  setDelay(seconds: number): void {
    this.timeDelay = seconds;
  }

  getDelay(): number {
    return this.timeDelay;
  }

  private applyStyle(cue: SubtitleCue): SubtitleCue {
    return {
      ...cue,
      style: {
        fontSize: this.fontSize,
        color: this.fontColor,
        bold: this.fontStyle === 'bold',
        italic: this.fontStyle === 'italic',
        ...cue.style,
      },
    };
  }
}

// --- Helper functions ---

function parseHtmlText(raw: string): {
  text: string;
  style: SubtitleCue['style'];
} {
  const style: SubtitleCue['style'] = {};
  let text = raw;

  // Extract font color
  const fontColorMatch = text.match(
    /<font\s+color=["']?(#[0-9a-fA-F]{3,6}|[\w]+)["']?>/i,
  );
  if (fontColorMatch) {
    style.color = fontColorMatch[1];
  }

  // Detect bold/italic from tags
  if (/<b[\s>]/i.test(text)) style.bold = true;
  if (/<i[\s>]/i.test(text)) style.italic = true;

  // Strip all HTML tags
  text = text.replace(/<[^>]+>/g, '');

  return {
    text: text.trim(),
    style: Object.keys(style).length > 0 ? style : undefined,
  };
}

function parseAssTime(timeStr: string): number {
  // Format: H:MM:SS.cc
  const match = timeStr.match(/(\d+):(\d{2}):(\d{2})\.(\d{2})/);
  if (!match) return NaN;
  return (
    parseInt(match[1]) * 3600 +
    parseInt(match[2]) * 60 +
    parseInt(match[3]) +
    parseInt(match[4]) / 100
  );
}

function assColorToHex(assColor: string): string {
  // ASS color format: &H00BBGGRR or &HAABBGGRR
  const match = assColor.match(/&H([0-9A-Fa-f]{6,8})/);
  if (!match) return '#ffffff';

  const hex = match[1];
  // Skip alpha byte if present (last 2 hex digits of the 8-char form are alpha)
  const colorPart = hex.length === 8 ? hex.slice(2) : hex;
  if (colorPart.length !== 6) return '#ffffff';

  const b = colorPart.slice(0, 2);
  const g = colorPart.slice(2, 4);
  const r = colorPart.slice(4, 6);
  return `#${r}${g}${b}`;
}

function parseAssText(raw: string): {
  text: string;
  bold: boolean;
  italic: boolean;
} {
  let bold = false;
  let italic = false;

  // Strip override tags {\...}
  let text = raw.replace(/\{[^}]*\}/g, '');

  // Check for bold/italic from override tags before stripping
  const overrideMatch = raw.match(/\{[^}]*\}/g);
  if (overrideMatch) {
    for (const tag of overrideMatch) {
      if (/\\b1/.test(tag)) bold = true;
      if (/\\i1/.test(tag)) italic = true;
    }
  }

  // Handle \N as newline
  text = text.replace(/\\N/g, '\n');

  return { text: text.trim(), bold, italic };
}
