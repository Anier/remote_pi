import { getClient } from "./opencode-client.js"
import { splitMessage } from "./message-formatter.js"

const THROTTLE_MS = 300
const EVENT_TIMEOUT_MS = 30000

export async function streamResponse(chatId, sessionId, prompt, bot) {
  const client = getClient()
  const provider = process.env.DEFAULT_MODEL_PROVIDER || "opencode"
  const modelId = process.env.DEFAULT_MODEL_ID || "big-pickle"

  const sentMsg = await bot.sendMessage(chatId, "⏳ печатает...")

  let buffer = ""
  let messageId = sentMsg.message_id
  let lastUpdate = 0
  let sseTextReceived = false
  let finished = false

  const abortController = new AbortController()

  const ssePromise = (async () => {
    try {
      const events = await client.event.subscribe()
      for await (const event of events.stream) {
        if (abortController.signal.aborted) break
        const props = event.properties || {}

        if (props.sessionId !== sessionId && props.session_id !== sessionId) continue

        if (event.type === "session.part" && props.part?.type === "text") {
          buffer += props.part.text
          sseTextReceived = true
          const now = Date.now()
          if (now - lastUpdate >= THROTTLE_MS) {
            lastUpdate = now
            await updateTelegram(bot, chatId, messageId, buffer, false)
          }
        }

        if (event.type === "session.continue" || event.type === "session.done") {
          finished = true
          break
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") throw err
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

    const resultText = result.data?.parts
      ?.filter(p => p.type === "text")
      .map(p => p.text)
      .join("\n")

    if (resultText && resultText.length > buffer.length) {
      buffer = resultText
    }
  } catch (err) {
    abortController.abort()
    await ssePromise.catch(() => {})
    await bot.sendMessage(chatId, `❌ Ошибка: ${err.message || err}`)
    return
  }

  const finalText = buffer ? buffer + "\n\n✅ Готово" : "❗ Пустой ответ"
  await updateTelegram(bot, chatId, messageId, finalText, true)
}

async function updateTelegram(bot, chatId, messageId, text, isComplete) {
  const displayText = isComplete ? text : text

  if (displayText.length <= 4000) {
    try {
      await bot.editMessageText(displayText, { chat_id: chatId, message_id: messageId })
    } catch {
    }
    return
  }

  const parts = splitMessage(displayText)
  try {
    await bot.editMessageText(parts[0], { chat_id: chatId, message_id: messageId })
  } catch {
  }
  for (let i = 1; i < parts.length; i++) {
    try {
      await bot.sendMessage(chatId, parts[i])
    } catch {
    }
  }
}
