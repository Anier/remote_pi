import { AuthStorage, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const SESSION_DIR = resolve(__dirname, "..", "data", "sessions")
const MODELS_PATH = resolve(__dirname, "..", "data", "models.json")

// Initialize the shared storage, registry, and manager for the Pi Agent
export const authStorage = AuthStorage.create()
export const modelRegistry = ModelRegistry.create(authStorage, MODELS_PATH)
export const sessionManager = SessionManager.create(process.cwd(), SESSION_DIR)
