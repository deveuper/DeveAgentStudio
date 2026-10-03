import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const modelsUrl = process.env.OPENCODE_MODELS_URL || "https://models.dev"
const modelsPath = process.env.MODELS_DEV_API_JSON

async function loadModelsData() {
  if (modelsPath) return Bun.file(modelsPath).text()

  try {
    const response = await fetch(`${modelsUrl}/api.json`, {
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    // `await` matters: returning the bare promise lets a body-read timeout
    // reject AFTER this try/catch has exited, so the abort escaped as an
    // uncaught TimeoutError and failed the build instead of falling back to the
    // empty snapshot. That is why packaging failed intermittently whenever
    // models.dev was slow.
    const body = await response.text()
    console.log("Loaded models.dev snapshot")
    return body
  } catch (error) {
    // The runtime has its own cache and online enrichment path. Keep offline
    // packaging possible without inventing a provider or model catalogue.
    console.warn(
      `Unable to load models.dev during build; using an empty embedded snapshot: ${error instanceof Error ? error.message : String(error)}`,
    )
    return "{}"
  }
}

export const modelsData = await loadModelsData()
