import { splitMessage } from "./message-formatter.js"
import { getUserSettings } from "./user-store.js"
import { createAgentSessionForChat } from "./session-store.js"

const THROTTLE_MS = Number(process.env.TELEGRAM_THROTTLE_MS) || 1000

// Map<sessionId, { session: AgentSession }>
export const activeRequests = new Map()

export async function streamResponse(chatId, prompt, bot) {
  const userSettings = getUserSettings(chatId)
  const provider = userSettings.provider || process.env.DEFAULT_MODEL_PROVIDER || undefined
  const modelId = userSettings.modelId || process.env.DEFAULT_MODEL_ID || undefined

  const sentMsg = await bot.api.sendMessage(chatId, "⏳ печатает...")

  let buffer = ""
  let lastRendered = ""
  const messageId = sentMsg.message_id
  let lastUpdate = 0
  let pendingFlush = null
  let isAborted = false

  const safeEdit = (text, opts) => editWithBackoff(bot, chatId, messageId, text, opts)

  let session
  let sessionId = null
  try {
    session = await createAgentSessionForChat(chatId, provider, modelId)
    sessionId = session.sessionId
    activeRequests.set(sessionId, { session })
    
    // Subscribe to events for streaming
    const unsubscribe = session.subscribe((event) => {
      if (isAborted) return
      
      let newText = ""
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        newText = event.assistantMessageEvent.delta
      } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "thinking_delta") {
        newText = event.assistantMessageEvent.delta
      } else if (event.type === "bash_running") {
        newText = `\n[Запуск команды: ${event.command}]\n`
      } else if (event.type === "toolcall_start") {
         newText = `\n[Использование инструмента: ${event.partial?.content[event.contentIndex]?.name}]\n`
      } else if (event.type === "message_end" && event.message?.role === "assistant" && event.message.stopReason === "error") {
        newText = `\n\n❌ Ошибка от ИИ: ${event.message.errorMessage}\n`
      } else if (event.type === "error") {
        newText = `\n\n❌ Внутренняя ошибка: ${event.error}\n`
      }
      
      if (newText) {
        buffer += newText
        const now = Date.now()
        if (now - lastUpdate >= THROTTLE_MS) {
          lastUpdate = now
          if (buffer !== lastRendered) {
            lastRendered = buffer
            safeEdit(buffer).catch(() => {})
          }
        } else if (!pendingFlush) {
          pendingFlush = setTimeout(() => {
            pendingFlush = null
            lastUpdate = Date.now()
            if (buffer !== lastRendered) {
              lastRendered = buffer
              safeEdit(buffer).catch(() => {})
            }
          }, THROTTLE_MS - (now - lastUpdate))
        }
      }
    })

    // Execute prompt
    await session.prompt(prompt)
    unsubscribe()
    
    if (pendingFlush) { clearTimeout(pendingFlush); pendingFlush = null }
  } catch (err) {
    if (pendingFlush) { clearTimeout(pendingFlush); pendingFlush = null }

    const msg = err?.message || String(err)
    if (isAborted || msg.includes("AbortError")) {
      await safeEdit((buffer || "") + "\n\n🛑 <b>Остановлено пользователем.</b>", { parse_mode: "HTML" })
      return
    }

    await bot.api.sendMessage(chatId, `❌ Ошибка: ${msg}`).catch(() => {})
    return
  } finally {
    activeRequests.delete(sessionId)
  }

  const finalText = buffer ? buffer + "\n\n✅ Готово" : "❗ Пустой ответ (или выполнены только действия)"
  await safeEdit(finalText)
}

export function abortStream(sessionId) {
  const req = activeRequests.get(sessionId)
  if (req?.session) {
    req.session.abort()
    return true
  }
  return false
}

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
      try { await send(text) } catch { }
      return
    }
  }
}
