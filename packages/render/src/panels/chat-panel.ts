import { Panel, type GameState, type PanelConfig } from './panel.js';

interface ChatMessage {
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
}

/**
 * Chat panel - displays messages and input
 */
export class ChatPanel extends Panel {
  private messages: ChatMessage[] = [];
  private scrollOffset: number = 0;
  private inputBuffer: string = '';
  private inputActive: boolean = false;
  private maxMessages: number = 100;

  constructor(bounds: PanelConfig['bounds']) {
    super({
      id: 'chat',
      bounds,
      zIndex: 3, // UI layer
    });
  }

  /**
   * Add a message to the chat
   */
  addMessage(message: ChatMessage): void {
    this.messages.push(message);
    if (this.messages.length > this.maxMessages) {
      this.messages.shift();
    }
    // Auto-scroll to bottom
    this.scrollOffset = Math.max(0, this.messages.length - (this.bounds.height - 3));
    this.needsRedraw = true;
  }

  /**
   * Set the input buffer text
   */
  setInputBuffer(text: string): void {
    this.inputBuffer = text;
    this.needsRedraw = true;
  }

  /**
   * Set input active state
   */
  setInputActive(active: boolean): void {
    this.inputActive = active;
    this.needsRedraw = true;
  }

  /**
   * Get current input buffer
   */
  getInputBuffer(): string {
    return this.inputBuffer;
  }

  /**
   * Clear input buffer
   */
  clearInput(): void {
    this.inputBuffer = '';
    this.needsRedraw = true;
  }

  render(_state: GameState): void {
    // Clear buffer
    this.buffer.fillRect(
      { x: 0, y: 0, width: this.bounds.width, height: this.bounds.height },
      { char: ' ', bg: { type: 'rgb', value: [15, 15, 20] } }
    );

    // Draw border
    this.drawBorder('Chat');

    // Draw messages (leave 1 row for input)
    const messageAreaHeight = this.bounds.height - 3; // -2 for border, -1 for input
    const visibleMessages = this.messages.slice(
      this.scrollOffset,
      this.scrollOffset + messageAreaHeight
    );

    for (let i = 0; i < visibleMessages.length; i++) {
      const msg = visibleMessages[i];
      if (msg) {
        this.renderMessage(1, i + 1, msg);
      }
    }

    // Draw input line
    this.renderInputLine();

    this.needsRedraw = false;
  }

  private renderMessage(x: number, y: number, message: ChatMessage): void {
    const maxWidth = this.bounds.width - 2;
    const prefix = `${message.senderName}: `;

    // Render sender name in color
    const nameColor = this.getNameColor(message.senderName);
    for (let i = 0; i < prefix.length && x + i < maxWidth; i++) {
      const char = prefix[i];
      if (char !== undefined) {
        this.buffer.setCell(x + i, y, {
          char,
          fg: nameColor,
          attrs: {
            bold: true,
            dim: false,
            italic: false,
            underline: false,
            blink: false,
            inverse: false,
            strikethrough: false,
          },
        });
      }
    }

    // Render message text
    const textStart = x + prefix.length;
    for (let i = 0; i < message.text.length && textStart + i < maxWidth; i++) {
      const char = message.text[i];
      if (char !== undefined) {
        this.buffer.setCell(textStart + i, y, {
          char,
          fg: { type: 'rgb', value: [200, 200, 200] },
        });
      }
    }
  }

  private renderInputLine(): void {
    const y = this.bounds.height - 2;
    const prompt = this.inputActive ? '> ' : '  ';

    // Draw separator
    for (let x = 1; x < this.bounds.width - 1; x++) {
      this.buffer.setCell(x, y - 1, { char: '─' });
    }

    // Render prompt
    for (let i = 0; i < prompt.length; i++) {
      const char = prompt[i];
      if (char !== undefined) {
        this.buffer.setCell(1 + i, y, {
          char,
          fg: this.inputActive
            ? { type: 'rgb', value: [100, 255, 100] }
            : { type: 'rgb', value: [100, 100, 100] },
        });
      }
    }

    // Render input buffer (scroll if too long)
    const maxInput = this.bounds.width - 4;
    const visibleInput = this.inputBuffer.slice(-maxInput);
    for (let i = 0; i < visibleInput.length; i++) {
      const char = visibleInput[i];
      if (char !== undefined) {
        this.buffer.setCell(1 + prompt.length + i, y, {
          char,
          fg: { type: 'rgb', value: [255, 255, 255] },
        });
      }
    }

    // Render cursor when active
    if (this.inputActive) {
      const cursorX = 1 + prompt.length + visibleInput.length;
      if (cursorX < this.bounds.width - 1) {
        this.buffer.setCell(cursorX, y, {
          char: '█',
          fg: { type: 'rgb', value: [100, 255, 100] },
          attrs: {
            bold: false,
            dim: false,
            italic: false,
            underline: false,
            blink: true,
            inverse: false,
            strikethrough: false,
          },
        });
      }
    }
  }

  /**
   * Generate a consistent color for a username
   */
  private getNameColor(name: string): { type: 'rgb'; value: [number, number, number] } {
    // Simple hash-based color generation
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }

    // Generate pastel-ish colors
    const h = Math.abs(hash) % 360;
    const s = 60 + (Math.abs(hash >> 8) % 30);
    const l = 60 + (Math.abs(hash >> 16) % 20);

    // HSL to RGB conversion
    const rgb = this.hslToRgb(h, s, l);
    return { type: 'rgb', value: rgb };
  }

  private hslToRgb(h: number, s: number, l: number): [number, number, number] {
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    };
    return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
  }

  /**
   * Scroll up
   */
  scrollUp(lines: number = 1): void {
    this.scrollOffset = Math.max(0, this.scrollOffset - lines);
    this.needsRedraw = true;
  }

  /**
   * Scroll down
   */
  scrollDown(lines: number = 1): void {
    const maxScroll = Math.max(0, this.messages.length - (this.bounds.height - 3));
    this.scrollOffset = Math.min(maxScroll, this.scrollOffset + lines);
    this.needsRedraw = true;
  }
}
