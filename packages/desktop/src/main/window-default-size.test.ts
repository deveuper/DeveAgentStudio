import { expect, test } from "bun:test"
import { defaultWindowSize } from "./window-default-size"

test("keeps the initial window inside a small display while preserving its aspect ratio", () => {
  const size = defaultWindowSize({ width: 1280, height: 800 })

  expect(size.width).toBeLessThanOrEqual(1248)
  expect(size.height).toBeLessThanOrEqual(768)
  expect(size.width / size.height).toBeCloseTo(1440 / 900)
})

test("keeps the preferred desktop size when the display has room", () => {
  expect(defaultWindowSize({ width: 1920, height: 1080 })).toEqual({ width: 1440, height: 900 })
})
