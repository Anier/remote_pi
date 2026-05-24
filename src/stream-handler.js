import { getClient } from "./opencode-client.js"
import { splitMessage } from "./message-formatter.js"

const THROTTLE_MS = 300
const SSE_TIMEOUT_MS = 120000

export async function streamResponse(chatId, sessionId, prompt, bot) {
  const client = getClient()
  const provider = process.env.DEFAULT_MODEL_PROVIDER || "opencode"
  const modelId = process.env.DEFAULT_MODEL_ID || "big-pickle"

  const sentMsg = await bot.api.sendMessage(chatId, "⏳ печатает...")

  let buffer = ""
  let messageId = sentMsg.message_id
  let lastUpdate = 0

  const abortController = new AbortController()

  const ssePromise = (async () => {
    try {
      const events = await client.event.subscribe()
      const sseTimeout = setTimeout(() => abortController.abort(), SSE_TIMEOUT_MS)

      try {
        for await (const event of events.stream) {
          if (abortController.signal.aborted) break
          const props = event.properties || {}

          const evSessionId = props.sessionId || props.session_id
          if (evSessionId && evSessionId !== sessionId) continue

          if (event.type === "session.part" && props.part?.type === "text") {
            buffer += props.part.text
            const now = Date.now()
            if (now - lastUpdate >= THROTTLE_MS) {
              lastUpdate = now
              try {
                await updateTelegram(bot, chatId, messageId, buffer)
              } catch {}
            }
          }

          if (event.type === "session.continue" || event.type === "session.done") {
            break
          }
        }
      } finally {
        clearTimeout(sseTimeout)
      }
    } catch (err) {
      if (err.name !== "AbortError") {
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
      }
    })

    abortController.abort()
    await ssePromise.catch(() => {})

    const resultText = result?.data?.parts
      ?.filter(p => p.type === "text")
      .map(p => p.text)
      .join("\n")

    if (resultText && resultText.length > buffer.length) {
      buffer = resultText
    }
  } catch (err) {
    abortController.abort()
    await ssePromise.catch(() => {})

    const msg = err?.message || String(err)

    if (msg.includes("401") || msg.includes("Unauthorized")) {
      await bot.api.sendMessage(chatId,
        "❌ Ошибка авторизации (401).\n\n" +
        "Пароль сервера не совпадает. Перезапустите opencode serve и обновите .env"
      ).catch(() => {})
      return
    }

    await bot.api.sendMessage(chatId, `❌ Ошибка: ${msg}`).catch(() => {})
    return
  }

  const finalText = buffer ? buffer + "\n\n✅ Готово" : "❗ Пустой ответ"
  await updateTelegram(bot, chatId, messageId, finalText)
}

async function updateTelegram(bot, chatId, messageId, text) {
  if (text.length <= 4000) {
    try {
      await bot.api.editMessageText(chatId, messageId, text)
    } catch {}
    return
  }

  const parts = splitMessage(text)
  try {
    await bot.api.editMessageText(chatId, messageId, parts[0])
  } catch {}
  for (let i = 1; i < parts.length; i++) {
    try {
      await bot.api.sendMessage(chatId, parts[i])
    } catch {}
  }
}
