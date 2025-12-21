// Component system (new)
export * from './components/index.js';

// Brand colors (always dark theme)
export * from './brand.js';

// ANSI utilities
export { ANSIBuilder } from './ansi/builder.js';
export * from './ansi/codes.js';
export * from './ansi/colors.js';

// Buffer system
export { ScreenBuffer } from './buffer/screen-buffer.js';
export { createCell, cellsEqual, cloneCell } from './buffer/cell.js';

// Panel system
export { Panel, type PanelConfig } from './panels/panel.js';
export { ViewportPanel } from './panels/viewport-panel.js';
export { ChatPanel } from './panels/chat-panel.js';
export { StatsPanel } from './panels/stats-panel.js';

// Layout
export { LayoutManager, type LayoutConfig } from './layout/layout-manager.js';

// Renderer
export { TUIRenderer } from './renderer/tui-renderer.js';

// Input
export { KeyParser, type ParsedKey } from './input/key-parser.js';
export { InputHandler } from './input/input-handler.js';

// Pixel rendering
export {
  bgColor,
  fgColor,
  renderPixel,
  renderPixelRow,
  renderPixelGrid,
  renderPixelGridString,
  renderHalfBlockRow,
  renderHalfBlockGrid,
  renderBrailleGrid,
  compositeGrids,
  createEmptyGrid,
  createSolidGrid,
  extractRegion,
  scaleGrid,
  downsampleGrid,
} from './pixel/pixel-renderer.js';

export {
  ViewportRenderer,
  MOVEMENT_REMAP,
  type ViewportConfig,
  type WorldDataProvider,
  type CameraRotation,
} from './pixel/viewport-renderer.js';

export {
  PixelGameRenderer,
  setBuildVersion,
  getBuildVersion,
  type PixelGameRendererConfig,
  type GameWorldAdapter,
  type RenderMode,
} from './pixel/pixel-game-renderer.js';

// Transport (backpressure handling)
export { OutputPump, type OutputPumpMetrics } from './transport/index.js';
