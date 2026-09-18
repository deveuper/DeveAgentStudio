import { createEffect, onCleanup } from "solid-js"
import { useSettings } from "./settings"

/**
 * Low power mode (Settings → General): on low-end devices the workbench should
 * poll less often and animate less. The CSS half lives in
 * `packages/ui/src/styles/low-power.css` (keyed on `data-low-power` on <html>);
 * this module is the JS half — it stretches every user-visible polling timer.
 */
export const LOW_POWER_MULTIPLIER = 4

/** Pure period math, so the multiplier is testable without a Solid owner. */
export function lowPowerPeriod(baseMs: number, enabled: boolean) {
  return Math.round(baseMs * (enabled ? LOW_POWER_MULTIPLIER : 1))
}

export function useLowPower() {
  const settings = useSettings()
  const enabled = () => settings.general.lowPowerMode()
  return {
    enabled,
    multiplier: () => (enabled() ? LOW_POWER_MULTIPLIER : 1),
  }
}

/**
 * `setInterval` that stretches its period under low power mode and restarts when
 * the setting changes, so toggling it takes effect immediately.
 */
export function createLowPowerInterval(callback: () => void, baseMs: number) {
  const lowPower = useLowPower()
  createEffect(() => {
    const timer = window.setInterval(callback, lowPowerPeriod(baseMs, lowPower.enabled()))
    onCleanup(() => window.clearInterval(timer))
  })
}
