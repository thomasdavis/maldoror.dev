import { KeyParser, type ParsedKey } from './key-parser.js';
import type { InputMode } from '@maldoror/protocol';

/**
 * Key binding definition
 */
interface KeyBinding {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  action: string;
}

/**
 * Input handler callback type
 */
export type InputCallback = (action: string, event: ParsedKey) => void;

/**
 * Handles terminal input and dispatches actions
 */
export class InputHandler {
  private parser: KeyParser;
  private mode: InputMode = 'game';
  private bindings: Map<InputMode, KeyBinding[]> = new Map();
  private callback: InputCallback | null = null;
  private chatBuffer: string = '';

  constructor() {
    this.parser = new KeyParser();
    this.setupDefaultBindings();
  }

  private setupDefaultBindings(): void {
    // Game mode bindings
    this.bindings.set('game', [
      // Arrow keys for movement (explicit shift: false to not conflict with camera pan)
      { key: 'ArrowUp', shift: false, action: 'move_up' },
      { key: 'ArrowDown', shift: false, action: 'move_down' },
      { key: 'ArrowLeft', shift: false, action: 'move_left' },
      { key: 'ArrowRight', shift: false, action: 'move_right' },
      { key: 'w', action: 'move_up' },
      { key: 'W', action: 'move_up' },
      { key: 's', action: 'move_down' },
      { key: 'S', action: 'move_down' },
      { key: 'a', action: 'move_left' },
      { key: 'A', action: 'move_left' },
      { key: 'd', action: 'move_right' },
      { key: 'D', action: 'move_right' },
      { key: 'Enter', action: 'interact' },
      { key: 'e', action: 'interact' },
      { key: 'i', action: 'toggle_inventory' },
      { key: 'm', action: 'toggle_minimap' },
      { key: '/', action: 'start_chat' },
      { key: 't', action: 'start_chat' },
      { key: 'T', action: 'start_chat' },
      { key: 'Escape', action: 'open_menu' },
      { key: 'r', action: 'regenerate_avatar' },
      // Building placement
      { key: 'b', action: 'place_building' },
      { key: 'B', action: 'place_building' },
      // NPC creation
      { key: 'n', action: 'create_npc' },
      { key: 'N', action: 'create_npc' },
      // Zoom controls
      { key: '+', action: 'zoom_in' },
      { key: '=', action: 'zoom_in' },
      { key: '-', action: 'zoom_out' },
      { key: '_', action: 'zoom_out' },
      // Render mode toggle
      { key: 'v', action: 'cycle_render_mode' },
      { key: 'V', action: 'cycle_render_mode' },
      // Quit
      { key: 'q', action: 'quit' },
      { key: 'Q', action: 'quit' },
      // Player list
      { key: 'Tab', action: 'toggle_players' },
      // Help
      { key: '?', action: 'show_help' },
      // Camera controls
      { key: 'c', action: 'toggle_camera_mode' },
      { key: 'C', action: 'toggle_camera_mode' },
      { key: 'h', action: 'snap_to_player' },
      { key: 'H', action: 'snap_to_player' },
      { key: 'Home', action: 'snap_to_player' },
      // Shift+arrow for camera pan (independent of mode)
      { key: 'ArrowUp', shift: true, action: 'pan_camera_up' },
      { key: 'ArrowDown', shift: true, action: 'pan_camera_down' },
      { key: 'ArrowLeft', shift: true, action: 'pan_camera_left' },
      { key: 'ArrowRight', shift: true, action: 'pan_camera_right' },
      // Camera rotation
      { key: '[', action: 'rotate_camera_ccw' },
      { key: ']', action: 'rotate_camera_cw' },
    ]);

    // Chat mode bindings
    this.bindings.set('chat', [
      { key: 'Enter', action: 'send_message' },
      { key: 'Escape', action: 'cancel_chat' },
      { key: 'Backspace', action: 'delete_char' },
      { key: 'ArrowUp', action: 'chat_history_up' },
      { key: 'ArrowDown', action: 'chat_history_down' },
    ]);

    // Menu mode bindings
    this.bindings.set('menu', [
      { key: 'ArrowUp', action: 'menu_up' },
      { key: 'ArrowDown', action: 'menu_down' },
      { key: 'Enter', action: 'menu_select' },
      { key: 'Escape', action: 'close_menu' },
    ]);

    // Dialog mode bindings
    this.bindings.set('dialog', [
      { key: 'Enter', action: 'dialog_confirm' },
      { key: 'Escape', action: 'dialog_cancel' },
      { key: 'y', action: 'dialog_yes' },
      { key: 'n', action: 'dialog_no' },
    ]);
  }

  /**
   * Set callback for actions
   */
  onAction(callback: InputCallback): void {
    this.callback = callback;
  }

  /**
   * Process incoming input data
   */
  process(data: Buffer): void {
    const events = this.parser.parse(data);

    for (const event of events) {
      this.handleEvent(event);
    }
  }

  private handleEvent(event: ParsedKey): void {
    if (event.type === 'key') {
      this.handleKeyEvent(event);
    } else if (event.type === 'mouse') {
      this.handleMouseEvent(event);
    }
  }

  private handleKeyEvent(event: ParsedKey): void {
    const modeBindings = this.bindings.get(this.mode) || [];

    // Find matching binding - prefer more specific bindings (with explicit modifiers)
    // First try exact modifier match, then fallback to wildcard (undefined) modifiers
    const exactMatch = modeBindings.find(
      (b) =>
        b.key === event.key &&
        b.ctrl === event.ctrl &&
        b.alt === event.alt &&
        b.shift === event.shift
    );

    const wildcardMatch = modeBindings.find(
      (b) =>
        b.key === event.key &&
        (b.ctrl === undefined || b.ctrl === event.ctrl) &&
        (b.alt === undefined || b.alt === event.alt) &&
        (b.shift === undefined || b.shift === event.shift)
    );

    const binding = exactMatch || wildcardMatch;

    if (binding) {
      this.dispatch(binding.action, event);
    } else if (this.mode === 'chat' && event.char && event.char.length === 1) {
      // Typing in chat mode
      this.chatBuffer += event.char;
      this.dispatch('chat_input', event);
    }
  }

  private handleMouseEvent(event: ParsedKey): void {
    // Future: click-to-move, UI interaction
    if (event.mouse?.action === 'press') {
      this.dispatch('mouse_click', event);
    }
  }

  private dispatch(action: string, event: ParsedKey): void {
    // Handle some actions internally
    switch (action) {
      case 'start_chat':
        this.mode = 'chat';
        this.chatBuffer = '';
        break;
      case 'cancel_chat':
        this.mode = 'game';
        this.chatBuffer = '';
        break;
      case 'send_message':
        this.mode = 'game';
        break;
      case 'open_menu':
        if (this.mode === 'game') {
          this.mode = 'menu';
        }
        break;
      case 'close_menu':
        this.mode = 'game';
        break;
      case 'delete_char':
        this.chatBuffer = this.chatBuffer.slice(0, -1);
        break;
    }

    // Call external callback
    if (this.callback) {
      this.callback(action, event);
    }
  }

  /**
   * Get current input mode
   */
  getMode(): InputMode {
    return this.mode;
  }

  /**
   * Set input mode
   */
  setMode(mode: InputMode): void {
    this.mode = mode;
  }

  /**
   * Get current chat buffer
   */
  getChatBuffer(): string {
    return this.chatBuffer;
  }

  /**
   * Clear chat buffer
   */
  clearChatBuffer(): void {
    this.chatBuffer = '';
  }

  /**
   * Add custom binding
   */
  addBinding(mode: InputMode, binding: KeyBinding): void {
    const modeBindings = this.bindings.get(mode) || [];
    modeBindings.push(binding);
    this.bindings.set(mode, modeBindings);
  }

  /**
   * Remove binding by action name
   */
  removeBinding(mode: InputMode, action: string): void {
    const modeBindings = this.bindings.get(mode) || [];
    const filtered = modeBindings.filter((b) => b.action !== action);
    this.bindings.set(mode, filtered);
  }
}
