/**
 * Parsed key information
 */
export interface ParsedKey {
  type: 'key' | 'mouse' | 'resize' | 'unknown';
  key?: string;
  char?: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  mouse?: {
    button: number;
    x: number;
    y: number;
    action: 'press' | 'release' | 'move';
  };
}

/**
 * Parser for terminal input sequences
 */
export class KeyParser {
  private buffer: Buffer = Buffer.alloc(0);

  /**
   * Parse incoming data and emit key events
   */
  parse(data: Buffer): ParsedKey[] {
    this.buffer = Buffer.concat([this.buffer, data]);
    const events: ParsedKey[] = [];

    while (this.buffer.length > 0) {
      const result = this.parseOne();
      if (result) {
        events.push(result.event);
        this.buffer = this.buffer.subarray(result.consumed);
      } else {
        // Incomplete sequence, wait for more data
        break;
      }
    }

    return events;
  }

  /**
   * Clear buffer
   */
  clear(): void {
    this.buffer = Buffer.alloc(0);
  }

  private parseOne(): { event: ParsedKey; consumed: number } | null {
    const b = this.buffer;

    // ESC sequence
    if (b[0] === 0x1b) {
      return this.parseEscape();
    }

    // Control characters
    if (b[0]! < 32) {
      return this.parseControl();
    }

    // DEL
    if (b[0] === 0x7f) {
      return {
        event: { type: 'key', key: 'Backspace', ctrl: false, alt: false, shift: false, meta: false },
        consumed: 1,
      };
    }

    // Regular character (including UTF-8)
    return this.parseChar();
  }

  private parseEscape(): { event: ParsedKey; consumed: number } | null {
    const b = this.buffer;

    // Need at least 1 byte for bare ESC
    if (b.length === 1) {
      // Could be bare ESC or start of sequence - wait a bit
      // For simplicity, treat as bare ESC
      return {
        event: { type: 'key', key: 'Escape', ctrl: false, alt: false, shift: false, meta: false },
        consumed: 1,
      };
    }

    // ESC [ (CSI sequence)
    if (b[1] === 0x5b) {
      return this.parseCSI();
    }

    // ESC O (SS3 sequence - function keys)
    if (b[1] === 0x4f) {
      return this.parseSS3();
    }

    // Alt + key
    if (b.length >= 2 && b[1]! >= 32 && b[1]! < 127) {
      const char = String.fromCharCode(b[1]!);
      return {
        event: {
          type: 'key',
          key: char,
          char,
          ctrl: false,
          alt: true,
          shift: char !== char.toLowerCase(),
          meta: false,
        },
        consumed: 2,
      };
    }

    // Unknown escape sequence
    return {
      event: { type: 'unknown', ctrl: false, alt: false, shift: false, meta: false },
      consumed: 2,
    };
  }

  private parseCSI(): { event: ParsedKey; consumed: number } | null {
    const b = this.buffer;

    // Find end of CSI sequence (final byte in range 0x40-0x7E)
    let end = 2;
    while (end < b.length && (b[end]! < 0x40 || b[end]! > 0x7e)) {
      end++;
    }

    if (end >= b.length) return null; // Incomplete

    const finalByte = b[end]!;
    const params = b.subarray(2, end).toString();

    // Arrow keys
    const arrowMap: Record<number, string> = {
      0x41: 'ArrowUp',
      0x42: 'ArrowDown',
      0x43: 'ArrowRight',
      0x44: 'ArrowLeft',
    };

    if (arrowMap[finalByte]) {
      const modifiers = this.parseModifiers(params);
      return {
        event: {
          type: 'key',
          key: arrowMap[finalByte],
          ...modifiers,
        },
        consumed: end + 1,
      };
    }

    // Special keys
    const specialMap: Record<string, string> = {
      '1~': 'Home',
      '2~': 'Insert',
      '3~': 'Delete',
      '4~': 'End',
      '5~': 'PageUp',
      '6~': 'PageDown',
      '7~': 'Home',
      '8~': 'End',
    };

    const seq = params + String.fromCharCode(finalByte);
    if (specialMap[seq]) {
      return {
        event: {
          type: 'key',
          key: specialMap[seq],
          ctrl: false,
          alt: false,
          shift: false,
          meta: false,
        },
        consumed: end + 1,
      };
    }

    // Mouse events (SGR mode: ESC [ < Cb ; Cx ; Cy M/m)
    if (b[2] === 0x3c) {
      return this.parseMouseSGR();
    }

    return {
      event: { type: 'unknown', ctrl: false, alt: false, shift: false, meta: false },
      consumed: end + 1,
    };
  }

  private parseSS3(): { event: ParsedKey; consumed: number } | null {
    const b = this.buffer;
    if (b.length < 3) return null;

    const functionKeys: Record<number, string> = {
      0x50: 'F1',
      0x51: 'F2',
      0x52: 'F3',
      0x53: 'F4',
    };

    if (functionKeys[b[2]!]) {
      return {
        event: {
          type: 'key',
          key: functionKeys[b[2]!],
          ctrl: false,
          alt: false,
          shift: false,
          meta: false,
        },
        consumed: 3,
      };
    }

    return {
      event: { type: 'unknown', ctrl: false, alt: false, shift: false, meta: false },
      consumed: 3,
    };
  }

  private parseMouseSGR(): { event: ParsedKey; consumed: number } | null {
    const str = this.buffer.toString();
    const match = str.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);

    if (!match) return null;

    const button = parseInt(match[1]!, 10);
    const x = parseInt(match[2]!, 10) - 1;
    const y = parseInt(match[3]!, 10) - 1;
    const action = match[4] === 'M' ? 'press' : 'release';

    return {
      event: {
        type: 'mouse',
        ctrl: (button & 16) !== 0,
        alt: (button & 8) !== 0,
        shift: (button & 4) !== 0,
        meta: false,
        mouse: {
          button: button & 3,
          x,
          y,
          action: action as 'press' | 'release',
        },
      },
      consumed: match[0].length,
    };
  }

  private parseControl(): { event: ParsedKey; consumed: number } {
    const b = this.buffer[0]!;

    const controlMap: Record<number, string> = {
      0x00: 'Ctrl-Space',
      0x01: 'Ctrl-A',
      0x02: 'Ctrl-B',
      0x03: 'Ctrl-C',
      0x04: 'Ctrl-D',
      0x05: 'Ctrl-E',
      0x06: 'Ctrl-F',
      0x07: 'Ctrl-G',
      0x08: 'Backspace',
      0x09: 'Tab',
      0x0a: 'Enter',
      0x0b: 'Ctrl-K',
      0x0c: 'Ctrl-L',
      0x0d: 'Enter',
      0x0e: 'Ctrl-N',
      0x0f: 'Ctrl-O',
      0x10: 'Ctrl-P',
      0x11: 'Ctrl-Q',
      0x12: 'Ctrl-R',
      0x13: 'Ctrl-S',
      0x14: 'Ctrl-T',
      0x15: 'Ctrl-U',
      0x16: 'Ctrl-V',
      0x17: 'Ctrl-W',
      0x18: 'Ctrl-X',
      0x19: 'Ctrl-Y',
      0x1a: 'Ctrl-Z',
      0x1b: 'Escape',
    };

    const key = controlMap[b] || `Ctrl-${String.fromCharCode(b + 64)}`;
    const isCtrl = b < 27 && b !== 0x09 && b !== 0x0a && b !== 0x0d;

    return {
      event: {
        type: 'key',
        key,
        ctrl: isCtrl,
        alt: false,
        shift: false,
        meta: false,
      },
      consumed: 1,
    };
  }

  private parseChar(): { event: ParsedKey; consumed: number } | null {
    const b = this.buffer;
    let charLen = 1;

    // Determine UTF-8 character length
    if ((b[0]! & 0xe0) === 0xc0) charLen = 2;
    else if ((b[0]! & 0xf0) === 0xe0) charLen = 3;
    else if ((b[0]! & 0xf8) === 0xf0) charLen = 4;

    if (b.length < charLen) return null;

    const char = b.subarray(0, charLen).toString('utf8');

    return {
      event: {
        type: 'key',
        key: char,
        char,
        ctrl: false,
        alt: false,
        shift: char !== char.toLowerCase(),
        meta: false,
      },
      consumed: charLen,
    };
  }

  private parseModifiers(params: string): { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean } {
    const parts = params.split(';');
    if (parts.length < 2) {
      return { ctrl: false, alt: false, shift: false, meta: false };
    }

    const mod = parseInt(parts[1]!, 10) - 1;
    return {
      shift: (mod & 1) !== 0,
      alt: (mod & 2) !== 0,
      ctrl: (mod & 4) !== 0,
      meta: (mod & 8) !== 0,
    };
  }
}
