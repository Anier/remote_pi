import { getClient } from "./opencode-client.js"
import { splitMessage } from "./message-formatter.js"
import { getUserSettings } from "./user-store.js"

// Telegram rate-limits editMessageText до ~1/сек на чат. 1000 мс — безопасный дефолт.
const THROTTLE_MS = Number(process.env.TELEGRAM_THROTTLE_MS) || 1000
// «Скользящий» idle-таймаут SSE: закрываем подписку, если событий нет N мс.
// Основной HTTP-запрос session.prompt при этом продолжает работать.
const SSE_IDLE_TIMEOUT_MS = Number(process.env.SSE_IDLE_TIMEOUT_MS) || 5 * 60 * 1000

// Map<sessionId, { promptController, sseController }>
export const activeRequests = new Map()

export async function streamResponse(chatId, sessionId, prompt, bot) {
  const client = getClient()
  const userSettings = getUserSettings(chatId)
  const provider = userSettings.provider || process.env.DEFAULT_MODEL_PROVIDER || "opencode"
  const modelId = userSettings.modelId || process.env.DEFAULT_MODEL_ID || "big-pickle"

  const sentMsg = await bot.api.sendMessage(chatId, "⏳ печатает...")

  let buffer = ""
  let lastRendered = ""
  const messageId = sentMsg.message_id
  let lastUpdate = 0
  let pendingFlush = null

  const promptController = new AbortController()
  const sseController = new AbortController()
  activeRequests.set(sessionId, { promptController, sseController })

  let idleTimer = null
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => sseController.abort(), SSE_IDLE_TIMEOUT_MS)
  }
  resetIdleTimer()

  const safeEdit = (text, opts) => editWithBackoff(bot, chatId, messageId, text, opts)

  const ssePromise = (async () => {
    try {
      const events = await client.event.subscribe()
      try {
        for await (const event of events.stream) {
          if (sseController.signal.aborted) break
          resetIdleTimer()

          const props = event.properties || {}
          const evSessionId = props.sessionId || props.session_id
          if (evSessionId && evSessionId !== sessionId) continue

          if (event.type === "session.part" && props.part?.type === "text") {
            buffer += props.part.text
            const now = Date.now()
            if (now - lastUpdate >= THROTTLE_MS) {
              lastUpdate = now
              if (buffer !== lastRendered) {
                lastRendered = buffer
                await safeEdit(buffer)
              }
            } else if (!pendingFlush) {
              pendingFlush = setTimeout(async () => {
                pendingFlush = null
                lastUpdate = Date.now()
                if (buffer !== lastRendered) {
                  lastRendered = buffer
                  await safeEdit(buffer)
                }
              }, THROTTLE_MS - (now - lastUpdate))
            }
          }

          if (event.type === "permission.updated") {
            const perm = props || {}
            if (perm.state === "pending") {
              await bot.api.sendMessage(chatId,
                `🔐 <b>Запрос разрешения:</b>\n\n` +
                `📝 <b>${perm.title || "Без названия"}</b>\n` +
                `${perm.description || ""}\n\n` +
                `<i>Бот ожидает подтверждения на сервере. Если вы запустили сервер с флагом -SkipPermissions, это сообщение можно игнорировать.</i>`,
                { parse_mode: "HTML" }
              ).catch(() => {})
            }
          }

          if (event.type === "session.continue" || event.type === "session.done") {
            break
          }
        }
      } finally {
        if (idleTimer) clearTimeout(idleTimer)
      }
    } catch (err) {
      if (err?.name !== "AbortError") {
        console.error("SSE error:", err.message)
      }
    }
  })()

  try {
    const result = await client.session.prompt({
      path: { id: sessionId },
      body: {
        model: { providerID: provider, modelID: modelId },
        parts: [{ type: "text", text: prompt }]
      },
      signal: promptController.signal
    })

    sseController.abort()
    if (pendingFlush) { clearTimeout(pendingFlush); pendingFlush = null }
    await ssePromise.catch(() => {})

    const resultText = result?.data?.parts
      ?.filter(p => p.type === "text")
      .map(p => p.text)
      .join("\n")

    if (resultText && resultText.length > buffer.length) {
      buffer = resultText
    }
  } catch (err) {
    sseController.abort()
    if (pendingFlush) { clearTimeout(pendingFlush); pendingFlush = null }
    await ssePromise.catch(() => {})

    const msg = err?.message || String(err)

    if (err?.name === "AbortError" || promptController.signal.aborted) {
      await safeEdit((buffer || "") + "\n\n🛑 <b>Остановлено пользователем.</b>", { parse_mode: "HTML" })
      return
    }

    if (msg.includes("401") || msg.includes("Unauthorized")) {
      await bot.api.sendMessage(chatId,
        "❌ Ошибка авторизации (401).\n\n" +
        "Пароль сервера не совпадает. Перезапустите opencode serve и обновите .env"
      ).catch(() => {})
      return
    }

    await bot.api.sendMessage(chatId, `❌ Ошибка: ${msg}`).catch(() => {})
    return
  } finally {
    activeRequests.delete(sessionId)
  }

  const finalText = buffer ? buffer + "\n\n✅ Готово" : "❗ Пустой ответ"
  await safeEdit(finalText)
}

// Редактирование сообщения с обработкой Telegram 429 (Too Many Requests).
async function editWithBackoff(bot, chatId, messageId, text, opts = {}) {
  const send = async (t) => {
    if (t.length <= 4000) {
      await bot.api.editMessageText(chatId, messageId, t, opts)
      return
    }
    const parts = splitMessage(t)
    await bot.api.editMessageText(chatId, messageId, parts[0], opts)
    for (let i = 1; i < parts.length; i++) {
      await bot.api.sendMessage(chatId, parts[i], opts)
    }
  }

  try {
    await send(text)
  } catch (err) {
    const description = err?.description || err?.message || ""
    if (/message is not modified/i.test(description)) return

    const retryAfter = err?.parameters?.retry_after
    const isTooMany = err?.error_code === 429 || /Too Many Requests/i.test(description)
    if (isTooMany && retryAfter) {
      await new Promise(r => setTimeout(r, retryAfter * 1000 + 200))
      try { await send(text) } catch { /* следующая итерация перезапишет */ }
      return
    }
    // Прочие ошибки игнорируем — Telegram получит свежий текст следующим апдейтом.
  }
}
