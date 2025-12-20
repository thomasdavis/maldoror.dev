import type { InputMode } from '@maldoror/protocol';
import { KeyParser, type ParsedKey } from '../input/key-parser.js';
import { ComponentManager } from './component-manager.js';

/**
 * Key binding definition
 */
export interface KeyBinding {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  action: string;
}

/**
 * Action handler callback type
 */
export type ActionHandler = (action: string, event: ParsedKey) => void;

/**
 * InputRouter routes input through the component system.
 *
 * The key design decision: Components handle their own input first.
 * If no component handles the input, it falls back to the action handler.
 * Input mode is derived from ComponentManager's focus state, not managed separately.
 *
 * This fixes the ? ESC ? bug because mode and overlay state can't desync.
 */
export class InputRouter {
  private parser: KeyParser;
  private componentManager: ComponentManager;
  private fallbackHandler: ActionHandler | null = null;
  private chatBuffer: string = '';
  private gameBindings: KeyBinding[];

  constructor(componentManager: ComponentManager) {
    this.parser = new KeyParser();
    this.componentManager = componentManager;
    this.gameBindings = this.createGameBindings();
  }

  /**
   * Create default game mode key bindings.
   */
  private createGameBindings(): KeyBinding[] {
    return [
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
      // Road placement (replaces regenerate_avatar)
      { key: 'r', action: 'place_road' },
      { key: 'R', shift: true, action: 'remove_road' },
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
      // Shift+arrow for camera pan
      { key: 'ArrowUp', shift: true, action: 'pan_camera_up' },
      { key: 'ArrowDown', shift: true, action: 'pan_camera_down' },
      { key: 'ArrowLeft', shift: true, action: 'pan_camera_left' },
      { key: 'ArrowRight', shift: true, action: 'pan_camera_right' },
      // Camera rotation
      { key: '[', action: 'rotate_camera_ccw' },
      { key: ']', action: 'rotate_camera_cw' },
    ];
  }

  /**
   * Set the fallback handler for unhandled input.
   * This is typically the game's main action handler.
   */
  setFallbackHandler(handler: ActionHandler): void {
    this.fallbackHandler = handler;
  }

  /**
   * Process incoming input data.
   */
  process(data: Buffer): void {
    const events = this.parser.parse(data);

    for (const event of events) {
      this.handleEvent(event);
    }
  }

  private handleEvent(event: ParsedKey): void {
    // First, try to route through component system
    const handled = this.componentManager.handleInput(event);

    if (handled) {
      return; // Component consumed the event
    }

    // If no component handled it, use fallback handler
    if (event.type === 'key') {
      this.dispatchKeyToFallback(event);
    } else if (event.type === 'mouse') {
      this.dispatchMouseToFallback(event);
    }
  }

  private dispatchKeyToFallback(event: ParsedKey): void {
    const mode = this.componentManager.getInputMode();

    // Only handle game mode input in the router
    // Other modes are handled by focused components
    if (mode !== 'game') {
      return;
    }

    // Find matching binding
    const binding = this.findBinding(event);

    if (binding) {
      // Handle chat mode transitions internally
      if (binding.action === 'start_chat') {
        this.chatBuffer = '';
      }

      this.fallbackHandler?.(binding.action, event);
    }
  }

  private dispatchMouseToFallback(event: ParsedKey): void {
    if (event.mouse?.action === 'press') {
      this.fallbackHandler?.('mouse_click', event);
    }
  }

  private findBinding(event: ParsedKey): KeyBinding | undefined {
    // Find matching binding - prefer more specific bindings
    const exactMatch = this.gameBindings.find(
      (b) =>
        b.key === event.key &&
        b.ctrl === event.ctrl &&
        b.alt === event.alt &&
        b.shift === event.shift
    );

    const wildcardMatch = this.gameBindings.find(
      (b) =>
        b.key === event.key &&
        (b.ctrl === undefined || b.ctrl === event.ctrl) &&
        (b.alt === undefined || b.alt === event.alt) &&
        (b.shift === undefined || b.shift === event.shift)
    );

    return exactMatch || wildcardMatch;
  }

  /**
   * Get current input mode (derived from component focus state).
   */
  getMode(): InputMode {
    return this.componentManager.getInputMode();
  }

  /**
   * Get current chat buffer.
   */
  getChatBuffer(): string {
    return this.chatBuffer;
  }

  /**
   * Set chat buffer.
   */
  setChatBuffer(buffer: string): void {
    this.chatBuffer = buffer;
  }

  /**
   * Clear chat buffer.
   */
  clearChatBuffer(): void {
    this.chatBuffer = '';
  }

  /**
   * Add a custom binding.
   */
  addBinding(binding: KeyBinding): void {
    this.gameBindings.push(binding);
  }

  /**
   * Remove bindings by action name.
   */
  removeBinding(action: string): void {
    this.gameBindings = this.gameBindings.filter((b) => b.action !== action);
  }

  /**
   * Clear the key parser buffer.
   */
  clearParserBuffer(): void {
    this.parser.clear();
  }
}
