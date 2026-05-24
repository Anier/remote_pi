import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const STORE_PATH = resolve(__dirname, "..", "data", "users.json")

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

export function getUserSettings(chatId) {
  const store = load()
  return store[chatId] || {}
}

export function setUserModel(chatId, provider, modelId) {
  const store = load()
  if (!store[chatId]) store[chatId] = {}
  store[chatId].provider = provider
  store[chatId].modelId = modelId
  save()
}
