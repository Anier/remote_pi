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
  if (existing?.sessionId) {
    try {
      const info = await client.session.get({ path: { id: existing.sessionId } })
      if (info?.data?.id) {
        return existing.sessionId
      }
      // Сервер ответил, но сессии нет — создаём новую ниже.
    } catch (err) {
      const status = err?.status ?? err?.response?.status
      const msg = err?.message || String(err)
      // 404 / not found = сессия удалена. Любую другую ошибку (сеть, 5xx, 401)
      // пробрасываем наверх, иначе мы потеряем контекст при временном сбое сервера.
      const isNotFound = status === 404 || /not[ _]?found|no such session/i.test(msg)
      if (!isNotFound) {
        console.error("Не удалось проверить существующую сессию:", msg)
        throw err
      }
    }
  }

  const session = await client.session.create({
    body: { title: `Telegram-${chatId}` }
  })

  if (!session?.data?.id) {
    throw new Error("Не удалось создать сессию: нет id в ответе")
  }

  setSession(chatId, session.data.id)
  return session.data.id
}
