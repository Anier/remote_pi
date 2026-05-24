import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const STORE_PATH = resolve(__dirname, "..", "data", "sessions.json")

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

export function getSession(chatId) {
  const store = load()
  return store[chatId] || null
}

export function setSession(chatId, sessionId) {
  const store = load()
  store[chatId] = { sessionId, createdAt: new Date().toISOString() }
  save()
}

export function deleteSession(chatId) {
  const store = load()
  delete store[chatId]
  save()
}

export async function getOrCreateSession(client, chatId) {
  const existing = getSession(chatId)
  if (existing) {
    try {
      await client.session.get({ path: { id: existing.sessionId } })
      return existing.sessionId
    } catch {
    }
  }
  const session = await client.session.create({
    body: { title: `Telegram-${chatId}` }
  })
  setSession(chatId, session.id)
  return session.id
}
