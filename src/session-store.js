import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs"
import { dirname, resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { SessionManager, createAgentSession } from "@earendil-works/pi-coding-agent"
import { authStorage, modelRegistry } from "./pi-client.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const STORE_PATH = resolve(__dirname, "..", "data", "sessions.json")
export const SESSION_DIR = resolve(__dirname, "..", "data", "sessions")

let cache = null

function load() {
  if (cache) return cache
  try {
    const raw = readFileSync(STORE_PATH, "utf-8")
    cache = JSON.parse(raw)
  } catch {
    cache = {}
  }
  return cache
}

function save() {
  const dir = dirname(STORE_PATH)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(STORE_PATH, JSON.stringify(cache, null, 2))
}

export function findSessionFile(sessionId) {
  try {
    const files = readdirSync(SESSION_DIR)
    const found = files.find(f => f.includes(sessionId))
    if (found) return join(SESSION_DIR, found)
  } catch {}
  return null
}

const managerCache = new Map()

export function getSession(chatId) {
  const store = load()
  return store[chatId] || null
}

export function setSession(chatId, sessionId, sessionFile, cwd) {
  const store = load()
  store[chatId] = { sessionId, sessionFile, cwd, createdAt: new Date().toISOString() }
  save()
}

export function deleteSession(chatId) {
  managerCache.delete(chatId)
  const store = load()
  delete store[chatId]
  save()
}

export async function getOrCreateSessionManager(chatId, newCwd = null) {
  if (managerCache.has(chatId)) {
    return managerCache.get(chatId)
  }

  const existing = getSession(chatId)
  
  if (existing?.sessionFile) {
    try {
      const manager = SessionManager.open(existing.sessionFile, SESSION_DIR, existing.cwd)
      managerCache.set(chatId, manager)
      return manager
    } catch {}
  }

  if (existing?.sessionId) {
    const file = findSessionFile(existing.sessionId)
    if (file) {
      const manager = SessionManager.open(file, SESSION_DIR, existing.cwd)
      managerCache.set(chatId, manager)
      return manager
    }
  }

  const cwd = newCwd || existing?.cwd || process.cwd()
  const manager = SessionManager.create(cwd, SESSION_DIR)
  setSession(chatId, manager.getSessionId(), manager.getSessionFile(), cwd)
  managerCache.set(chatId, manager)
  return manager
}

export async function createAgentSessionForChat(chatId, provider, modelId) {
  const sessionManager = await getOrCreateSessionManager(chatId)
  
  let model = undefined
  if (provider && modelId) {
     model = modelRegistry.find(provider, modelId)
  }

  const { session } = await createAgentSession({
    sessionManager,
    authStorage,
    modelRegistry,
    model,
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"]
  })
  
  return session
}
