const DEFAULT_WIDTH = 1440
const DEFAULT_HEIGHT = 900
const WINDOW_MARGIN = 32

export function defaultWindowSize(workArea: { width: number; height: number }) {
  const availableWidth = Math.max(1, workArea.width - WINDOW_MARGIN)
  const availableHeight = Math.max(1, workArea.height - WINDOW_MARGIN)
  const scale = Math.min(1, availableWidth / DEFAULT_WIDTH, availableHeight / DEFAULT_HEIGHT)

  return {
    width: Math.floor(DEFAULT_WIDTH * scale),
    height: Math.floor(DEFAULT_HEIGHT * scale),
  }
}
