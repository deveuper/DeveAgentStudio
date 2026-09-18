const ALLOWED_COMPUTER_USE_KEYS = new Set(["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"])

export function assertComputerUseKey(value: unknown) {
  if (typeof value !== "string" || !ALLOWED_COMPUTER_USE_KEYS.has(value)) {
    throw new Error("Unsupported computer-use key")
  }
  return value
}
