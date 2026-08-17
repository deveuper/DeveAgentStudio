import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import type { Event } from "electron"
import { app, BrowserWindow } from "electron"
import { browserSnapshotRefSelector } from "./computer-use-ref"
import { assertComputerUseKey } from "./computer-use-key"
import { assertComputerUseNavigationUrl, assertPublicComputerUseRequestUrl, parseComputerUseNavigationUrl, parsePublicComputerUseUrl } from "./computer-use-url"

import { Deferred, Effect, Fiber } from "effect"
import contextMenu from "electron-context-menu"

import type { ServerReadyData } from "../preload/types"
import { checkAppExists, resolveAppPath } from "./apps"
import { CHANNEL } from "./constants"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand } from "./ipc"
import { forwardInitializationFailure } from "./initialization"
import { exportDebugLogs, initCrashReporter, initLogging, startNetLog, write as writeLog } from "./logging"
import { parseMarkdown } from "./markdown"
import { createMenu } from "./menu"
import {
  getDefaultServerUrl,
  preferAppEnv,
  setDefaultServerUrl,
  spawnLocalServer,
  type SidecarListener,
} from "./server"
import { setupAutoUpdater, showUpdaterDialog } from "./updater"
import {
  createMainWindow,
  registerRendererProtocol,
  setRelaunchHandler,
  setBackgroundColor,
  setDockIcon,
} from "./windows"
import { createWslServersController } from "./wsl/servers"
import { registerWslIpcHandlers } from "./wsl/ipc"
import { spawnWslSidecar } from "./wsl/sidecar"
import { migrate } from "./migrate"

const APP_NAMES: Record<string, string> = {
  dev: "DeveAgent Studio Dev",
  beta: "DeveAgent Studio Beta",
  prod: "DeveAgent Studio",
}
const APP_IDS: Record<string, string> = {
  dev: "com.deveagent.studio.dev",
  beta: "com.deveagent.studio.beta",
  prod: "com.deveagent.studio",
}
const TEST_ONBOARDING = process.env.OPENCODE_TEST_ONBOARDING === "1"
// ponytail: dated unpacked builds are QA artifacts; isolate them automatically so
// Computer Use cannot accidentally forward validation into an installed build.
const ISOLATED_DEVEAGENT_INSTANCE =
  process.argv.includes("--deveagent-isolated-instance") ||
  (process.platform === "win32" && /[\\/]dist-[^\\/]+[\\/]/i.test(process.execPath))
const jsCallStackFeature = "DocumentPolicyIncludeJSCallStacksInCrashReports"

let logger: ReturnType<typeof initLogging>
let mainWindow: BrowserWindow | null = null
let server: SidecarListener | null = null
const computerBrowserWindows = new Map<string, BrowserWindow>()
const COMPUTER_USE_MAX_BROWSER_SESSIONS = 8

const pendingDeepLinks: string[] = []

function computerUseSessionID(payload: unknown) {
  const sessionID = (payload as { sessionID?: unknown } | null)?.sessionID
  if (typeof sessionID !== "string" || sessionID.trim().length === 0) {
    throw new Error("Computer Use request is missing sessionID")
  }
  return sessionID
}

function computerUseBrowserFor(payload: unknown) {
  const sessionID = computerUseSessionID(payload)
  const browser = computerBrowserWindows.get(sessionID)
  if (!browser || browser.isDestroyed()) {
    computerBrowserWindows.delete(sessionID)
    throw new Error("Browser session is not ready")
  }
  return browser
}

function installComputerUseRequestGuard(browser: BrowserWindow) {
  browser.webContents.session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    void assertPublicComputerUseRequestUrl(details.url)
      .then(() => callback({}))
      .catch(() => callback({ cancel: true }))
  })
}

function createComputerUseBrowser(sessionID: string) {
  if (computerBrowserWindows.size >= COMPUTER_USE_MAX_BROWSER_SESSIONS) {
    throw new Error(`Too many Computer Use browser sessions (maximum ${COMPUTER_USE_MAX_BROWSER_SESSIONS})`)
  }
  const browser = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: `temp:deveagent-computer-use-${randomUUID()}`,
      sandbox: true,
    },
  })
  installComputerUseRequestGuard(browser)
  const preventPrivateNavigation = (event: Electron.Event, target: string) => {
    try {
      parsePublicComputerUseUrl(target)
    } catch {
      event.preventDefault()
    }
  }
  browser.webContents.on("will-navigate", preventPrivateNavigation)
  browser.webContents.on("will-redirect", preventPrivateNavigation)
  browser.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  browser.once("closed", () => {
    if (computerBrowserWindows.get(sessionID) === browser) computerBrowserWindows.delete(sessionID)
  })
  computerBrowserWindows.set(sessionID, browser)
  return browser
}

function useEnvProxy() {
  try {
    // Electron 41.2 runs Node 24.14.1; latest @types/node@24 is 24.12.2.
    ;(http as any).setGlobalProxyFromEnv()
  } catch (error) {
    logger.warn("failed to load proxy environment", error)
  }
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  pendingDeepLinks.push(...urls)
  if (mainWindow) sendDeepLinks(mainWindow, urls)
}

async function killSidecar() {
  if (!server) return
  const current = server
  server = null
  await current.stop()
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

const main = Effect.gen(function* () {
  contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

  // on macOS apps run in `/` which can cause issues with ripgrep
  try {
    process.chdir(homedir())
  } catch {}

  process.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI = "true"

  const appId = app.isPackaged ? APP_IDS[CHANNEL] : "com.deveagent.studio.dev"
  const onboardingTestRoot = ((): string | undefined => {
    if (!TEST_ONBOARDING && !ISOLATED_DEVEAGENT_INSTANCE) return

    // ponytail: a disposable profile lets QA open a fresh package without forwarding to a user's live Electron instance.
    const override = ISOLATED_DEVEAGENT_INSTANCE ? process.env.DEVEAGENT_E2E_ROOT?.trim() : undefined
    const root = override ? resolve(override) : join(tmpdir(), `${TEST_ONBOARDING ? "deveagent-onboarding" : "deveagent-isolated"}-${randomUUID()}`)
    rmSync(root, { recursive: true, force: true })
    ;["data", "config", "cache", "state", "desktop", "session"].forEach((dir) =>
      mkdirSync(join(root, dir), { recursive: true }),
    )
    process.env.OPENCODE_DB = ":memory:"
    process.env.XDG_DATA_HOME = join(root, "data")
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.XDG_CACHE_HOME = join(root, "cache")
    process.env.XDG_STATE_HOME = join(root, "state")
    return root
  })()
  app.setName(ISOLATED_DEVEAGENT_INSTANCE ? `${APP_NAMES[CHANNEL] ?? "DeveAgent Studio Dev"} Isolated` : app.isPackaged ? APP_NAMES[CHANNEL] : "DeveAgent Studio Dev")
  app.setAppUserModelId(ISOLATED_DEVEAGENT_INSTANCE ? `${appId}.isolated.${randomUUID()}` : appId)
  app.setPath(
    "userData",
    onboardingTestRoot ? join(onboardingTestRoot, "desktop") : join(app.getPath("appData"), appId),
  )
  if (onboardingTestRoot) app.setPath("sessionData", join(onboardingTestRoot, "session"))
  logger = initLogging()
  initCrashReporter()

  const wslServers = createWslServersController(
    app.getVersion(),
    async (distro) => {
      logger.log("spawning wsl sidecar", { distro })
      return spawnWslSidecar(distro, {
        onLine: (line) => logger.log("wsl sidecar", { distro, stream: line.stream, text: line.text }),
      })
    },
    {
      logger: {
        log: (message, meta) => logger.log(message, meta),
        error: (message, meta) => logger.error(message, meta),
      },
    },
  )
  const stopSidecars = async () => {
    await killSidecar()
    wslServers.stopAll()
  }
  const relaunch = () => {
    void stopSidecars().finally(() => {
      app.relaunch()
      app.exit(0)
    })
  }

  try {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  } catch (error) {
    logger.warn("failed to load system certificates", error)
  }

  logger.log("app starting", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    onboardingTest: Boolean(onboardingTestRoot),
  })

  ensureLoopbackNoProxy()
  useEnvProxy()
  // Low-resource mode for older hardware (2015 MacBook Pro, Steam Deck):
  // cap the renderer heap and disable GPU compositing when requested.
  if (process.argv.includes("--deveagent-low-memory") || process.env.DEVEAGENT_LOW_MEMORY === "1") {
    app.commandLine.appendSwitch("js-flags", "--max-old-space-size=3072")
    app.commandLine.appendSwitch("disable-gpu")
    app.commandLine.appendSwitch("disable-gpu-compositing")
  }
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  const features = app.commandLine.getSwitchValue("enable-features")
  app.commandLine.appendSwitch("enable-features", features ? `${jsCallStackFeature},${features}` : jsCallStackFeature)
  if (!app.isPackaged) app.commandLine.appendSwitch("remote-debugging-port", "9222")

  if (!ISOLATED_DEVEAGENT_INSTANCE && !app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  preferAppEnv(app.getPath("userData"))

  if (!ISOLATED_DEVEAGENT_INSTANCE) app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("deveagent://"))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      emitDeepLinks(urls)
    }
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url })
    emitDeepLinks([url])
  })

  app.on("before-quit", () => {
    void stopSidecars()
  })

  app.on("will-quit", () => {
    void stopSidecars()
  })

  app.on("child-process-gone", (_event, details) => {
    writeLog("utility", "child process gone", { details }, "error")
  })

  app.on("render-process-gone", (_event, webContents, details) => {
    writeLog("window", "app render process gone", { url: webContents.getURL(), details }, "error")
  })

  setRelaunchHandler(() => {
    relaunch()
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void stopSidecars().finally(() => app.exit(0))
    })
  }

  const serverReady = Deferred.makeUnsafe<ServerReadyData, unknown>()

  yield* Effect.promise(() => app.whenReady())

  // Isolated QA instances must stay disposable. Migrating the user's global
  // Electron store here would rehydrate old projects, sessions, and dashboard
  // preferences into what should be a clean EXE smoke profile.
  if (!TEST_ONBOARDING && !ISOLATED_DEVEAGENT_INSTANCE) migrate()
  if (!ISOLATED_DEVEAGENT_INSTANCE) app.setAsDefaultProtocolClient("deveagent")
  registerRendererProtocol()
  setDockIcon()
  const updater = setupAutoUpdater(stopSidecars)
  registerIpcHandlers({
    killSidecar: () => killSidecar(),
    relaunch,
    awaitInitialization: Effect.fnUntraced(
      function* () {
        logger.log("awaiting server ready")
        const res = yield* Deferred.await(serverReady)
        logger.log("server ready", { url: res.url })
        return res
      },
      (e) => Effect.runPromise(e),
    ),
    consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
    getDefaultServerUrl: () => getDefaultServerUrl(),
    setDefaultServerUrl: (url) => setDefaultServerUrl(url),
    getDisplayBackend: async () => null,
    setDisplayBackend: async () => undefined,
    parseMarkdown: async (markdown) => parseMarkdown(markdown),
    checkAppExists: (appName) => checkAppExists(appName),
    resolveAppPath: async (appName) => resolveAppPath(appName),
    updater,
    showUpdater: () => showUpdaterDialog(updater, true),
    setBackgroundColor: (color) => setBackgroundColor(color),
    exportDebugLogs: () => exportDebugLogs(),
    recordFatalRendererError: (error) => writeLog("renderer", "fatal renderer error", { ...error }, "error"),
  })
  registerWslIpcHandlers(wslServers)
  void updater.start()
  const updateTimer = setInterval(() => void updater.check(), 10 * 60 * 1000)
  updateTimer.unref()
  app.once("will-quit", () => clearInterval(updateTimer))
  yield* Effect.promise(() => startNetLog()).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to start net log", error)
      }),
    ),
  )

  const port = yield* Effect.gen(function* () {
    const fromEnv = process.env.OPENCODE_PORT
    if (fromEnv) {
      const parsed = Number.parseInt(fromEnv, 10)
      if (!Number.isNaN(parsed)) return parsed
    }

    const res = yield* Deferred.make<number, unknown>()
    const server = createServer()
    server.on("error", (e) => Deferred.failSync(res, () => e))
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        Deferred.failSync(res, () => new Error("Failed to get port"))
        return
      }
      const port = address.port
      server.close(() => Effect.runSync(Deferred.succeed(res, port)))
    })

    return yield* Deferred.await(res)
  })
  const hostname = "127.0.0.1"
  const url = `http://${hostname}:${port}`
  const password = randomUUID()

  const loadingTask = yield* Effect.gen(function* () {
    logger.log("sidecar connection started", { url })

    ensureLoopbackNoProxy()
    useEnvProxy()

    logger.log("spawning sidecar", { url })
    const { listener, health } = yield* Effect.promise(() =>
      spawnLocalServer(hostname, port, password, {
        userDataPath: app.getPath("userData"),
        databasePath: onboardingTestRoot ? join(onboardingTestRoot, "data", "deveagent.sqlite") : undefined,
        onStdout: (message) => writeLog("server", "stdout", { message }),
        onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
        onExit: (code) => writeLog("utility", "sidecar exited", { code }, "warn"),
        onHostRequest: async (action, payload) => {
          if (action.startsWith("browser.") || action.startsWith("desktop.")) computerUseSessionID(payload)
          if (action === "browser.navigate") {
            const url = typeof (payload as { url?: unknown })?.url === "string" ? (payload as { url: string }).url : ""
            const sessionID = computerUseSessionID(payload)
            await assertComputerUseNavigationUrl(url)
            const computerBrowserWindow = computerBrowserWindows.get(sessionID) ?? createComputerUseBrowser(sessionID)
            await Promise.race([
              computerBrowserWindow.loadURL(url),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Browser navigation timed out")), 15_000)),
            ])
            const currentUrl = computerBrowserWindow.webContents.getURL()
            await assertComputerUseNavigationUrl(currentUrl)
            const text = await computerBrowserWindow.webContents.executeJavaScript("document.body?.innerText || ''", true)
            return { url: currentUrl, text: String(text).slice(0, 10_000) }
          }
          if (action === "browser.back" || action === "browser.reload") {
            const computerBrowserWindow = computerUseBrowserFor(payload)
            if (action === "browser.back") computerBrowserWindow.webContents.goBack()
            else computerBrowserWindow.webContents.reload()
            await new Promise((resolve) => setTimeout(resolve, 150))
            const url = computerBrowserWindow.webContents.getURL()
            await assertComputerUseNavigationUrl(url)
            const text = await computerBrowserWindow.webContents.executeJavaScript("document.body?.innerText || ''", true)
            return { url, text: String(text).slice(0, 10_000), action }
          }
          if (action === "browser.snapshot") {
            const computerBrowserWindow = computerUseBrowserFor(payload)
            const snapshot = await computerBrowserWindow.webContents.executeJavaScript(
              `(function(){
                const visible = (element) => {
                  const rect = element.getBoundingClientRect()
                  const style = getComputedStyle(element)
                  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"
                }
                const elements = Array.from(document.querySelectorAll("a,button,input,textarea,select,[role='button'],[contenteditable='true']"))
                  .filter(visible)
                  .slice(0, 200)
                  .map((element, index) => {
                    const ref = String(index + 1)
                    element.setAttribute("data-deveagent-ref", ref)
                    return {
                      ref,
                      tag: element.tagName.toLowerCase(),
                      role: element.getAttribute("role") || undefined,
                      type: element.getAttribute("type") || undefined,
                      text: String(element.innerText || element.getAttribute("aria-label") || element.getAttribute("placeholder") || element.getAttribute("value") || "").trim().slice(0, 240),
                      disabled: Boolean(element.disabled),
                    }
                  })
                return {
                  url: location.href,
                  title: document.title,
                  text: String(document.body?.innerText || "").slice(0, 10000),
                  elements,
                }
              })()`,
              true,
            )
            return snapshot
          }
          if (action === "desktop.click") {
            if (!mainWindow || mainWindow.isDestroyed()) throw new Error("Desktop window is not ready")
            const input = payload as { x?: unknown; y?: unknown }
            const x = typeof input?.x === "number" ? input.x : NaN
            const y = typeof input?.y === "number" ? input.y : NaN
            const bounds = mainWindow.getContentBounds()
            if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) {
              throw new Error("Click coordinates are outside the current app window")
            }
            await mainWindow.webContents.sendInputEvent({ type: "mouseDown", x: Math.floor(x), y: Math.floor(y), button: "left", clickCount: 1 })
            await mainWindow.webContents.sendInputEvent({ type: "mouseUp", x: Math.floor(x), y: Math.floor(y), button: "left", clickCount: 1 })
            return { ok: true, x: Math.floor(x), y: Math.floor(y) }
          }
          if (action === "desktop.key") {
            if (!mainWindow || mainWindow.isDestroyed()) throw new Error("Desktop window is not ready")
            const key = assertComputerUseKey((payload as { key?: unknown })?.key)
            await mainWindow.webContents.sendInputEvent({ type: "keyDown", keyCode: key })
            await mainWindow.webContents.sendInputEvent({ type: "keyUp", keyCode: key })
            return { ok: true, key }
          }
          if (action === "desktop.scroll") {
            if (!mainWindow || mainWindow.isDestroyed()) throw new Error("Desktop window is not ready")
            const deltaY = typeof (payload as { deltaY?: unknown })?.deltaY === "number" ? (payload as { deltaY: number }).deltaY : 0
            if (!Number.isFinite(deltaY) || deltaY === 0 || Math.abs(deltaY) > 1000) throw new Error("Scroll delta must be between -1000 and 1000")
            const bounds = mainWindow.getContentBounds()
            await mainWindow.webContents.sendInputEvent({ type: "mouseWheel", x: Math.floor(bounds.width / 2), y: Math.floor(bounds.height / 2), deltaX: 0, deltaY })
            return { ok: true, deltaY }
          }
          if (action === "browser.click" || action === "browser.type" || action === "browser.key" || action === "browser.scroll" || action === "browser.wait") {
            const computerBrowserWindow = computerUseBrowserFor(payload)
            const input = payload as { ref?: unknown; selector?: unknown; text?: unknown }
            if (action === "browser.scroll") {
              const delta = typeof (input as { deltaY?: unknown })?.deltaY === "number" ? (input as { deltaY: number }).deltaY : 0
              if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 1000) throw new Error("Scroll delta must be between -1000 and 1000")
              const bounds = computerBrowserWindow.getContentBounds()
              await computerBrowserWindow.webContents.sendInputEvent({
                type: "mouseWheel",
                x: Math.floor(bounds.width / 2),
                y: Math.floor(bounds.height / 2),
                deltaX: 0,
                deltaY: delta,
              })
              return { ok: true, action, deltaY: delta }
            }
            if (action === "browser.key") {
              const key = assertComputerUseKey(input?.text)
              await computerBrowserWindow.webContents.sendInputEvent({ type: "keyDown", keyCode: key })
              await computerBrowserWindow.webContents.sendInputEvent({ type: "keyUp", keyCode: key })
              return { ok: true, action, key }
            }
            const ref = typeof input?.ref === "string" ? input.ref : ""
            const selector = ref
              ? browserSnapshotRefSelector(ref)
              : typeof input?.selector === "string"
                ? input.selector.slice(0, 500)
                : ""
            if (!selector || selector.includes("javascript:")) throw new Error("A CSS selector is required")
            const text = typeof input?.text === "string" ? input.text.slice(0, 10_000) : ""
            if (action === "browser.wait") {
              const timeout = Math.min(10_000, Math.max(250, Number((input as { timeoutMs?: unknown })?.timeoutMs) || 5_000))
              const script = `(async function(){const end=Date.now()+${timeout};while(Date.now()<end){if(document.querySelector(${JSON.stringify(selector)}))return true;await new Promise(r=>setTimeout(r,100));}return false})()`
              const found = await computerBrowserWindow.webContents.executeJavaScript(script, true)
              if (!found) throw new Error("Element did not appear before timeout")
              return { ok: true, action, selector, timeoutMs: timeout }
            }
            const script = action === "browser.click"
              ? `(function(){const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Element not found');e.click();return true})()`
              : `(function(){const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Element not found');e.focus();if(e.isContentEditable){e.textContent=${JSON.stringify(text)}}else{const proto=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;if(!setter)throw new Error('Element does not accept text');setter.call(e,${JSON.stringify(text)})}e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(text)}}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`
            await computerBrowserWindow.webContents.executeJavaScript(script, true)
            return { ok: true, action, selector }
          }
          if (action === "browser.screenshot") {
            const computerBrowserWindow = computerUseBrowserFor(payload)
            const output = join(tmpdir(), `deveagent-browser-${randomUUID()}.png`)
            const image = await computerBrowserWindow.webContents.capturePage()
            await writeFile(output, image.toPNG())
            return { path: output, target: "browser" }
          }
          if (action !== "desktop.screenshot") throw new Error(`Unsupported desktop host action: ${action}`)
          if (!mainWindow || mainWindow.isDestroyed()) throw new Error("Desktop window is not ready")
          const output = join(tmpdir(), `deveagent-desktop-${randomUUID()}.png`)
          await writeFile(output, (await mainWindow.webContents.capturePage()).toPNG())
          return { path: output }
        },
      }),
    )
    server = listener
    yield* Deferred.succeed(serverReady, {
      url,
      username: "deveagent",
      password,
    })

    if (process.platform === "win32") {
      void wslServers.initialize().catch((error) => logger.error("wsl server initialization failed", error))
    }

    yield* Effect.promise(() => health.wait).pipe(
      Effect.timeout("30 seconds"),
      Effect.catch((e) =>
        Effect.sync(() => {
          logger.error("sidecar health check failed", e.toString())
        }),
      ),
    )

    logger.log("loading task finished")
  }).pipe(forwardInitializationFailure(serverReady), Effect.forkChild)

  yield* Fiber.await(loadingTask)

  mainWindow = createMainWindow()
  if (mainWindow) {
    createMenu({
      trigger: (id) => {
        const win = BrowserWindow.getFocusedWindow() ?? mainWindow
        if (win) sendMenuCommand(win, id)
      },
      checkForUpdates: () => {
        void showUpdaterDialog(updater, true)
      },
      relaunch: () => {
        relaunch()
      },
    })
  }
})

Effect.runFork(main)
