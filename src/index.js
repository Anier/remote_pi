import "dotenv/config"
import { Bot, InputFile } from "grammy"
import { dirname, resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync, readFileSync } from "node:fs"
import { getSession, deleteSession, setSession, getOrCreateSessionManager, findSessionFile, SESSION_DIR } from "./session-store.js"
import { streamResponse, abortStream } from "./stream-handler.js"
import { getUserSettings, setUserModel } from "./user-store.js"
import { SessionManager } from "@earendil-works/pi-coding-agent"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, "..")

const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN не задан в .env")
  process.exit(1)
}

const bot = new Bot(token)

const ALLOWED_USERS = (process.env.TELEGRAM_ALLOWED_USERS || "")
  .split(",")
  .map(id => id.trim())
  .filter(id => id.length > 0)
const DEBUG_UPDATES = String(process.env.DEBUG_UPDATES || "").toLowerCase() === "true"

if (ALLOWED_USERS.length === 0) {
  console.warn(
    "⚠️  TELEGRAM_ALLOWED_USERS не задан — бот ОТКРЫТ для всех пользователей.\n" +
    "   Для ограничения доступа укажите user ID через TELEGRAM_ALLOWED_USERS=123,456 в .env."
  )
} else {
  console.log(`🔐 Разрешённые пользователи: ${ALLOWED_USERS.join(", ")}`)
}

bot.use(async (ctx, next) => {
  const chatId = ctx.chat?.id
  const userId = ctx.from?.id
  const text = ctx.message?.text || ctx.update?.message?.text || ""
  if (DEBUG_UPDATES) {
    console.log(`[update] type=${ctx.update?.message ? "message" : Object.keys(ctx.update || {}).join(",")} chat=${chatId} user=${userId} text=${JSON.stringify(text).slice(0, 200)}`)
  } else if (text) {
    console.log(`[update] from=${userId} chat=${chatId}: ${text.slice(0, 120)}`)
  }
  await next()
})

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id != null ? String(ctx.from.id) : null
  if (ALLOWED_USERS.length > 0 && (!userId || !ALLOWED_USERS.includes(userId))) {
    console.warn(`Заблокирована попытка доступа от пользователя: ${userId}`)
    await ctx.reply("⛔ У вас нет доступа к этому боту.").catch((e) => console.error("reply fail:", e.message))
    return
  }
  await next()
})

function formatSessionHistory(msgs) {
  let output = ""
  for (const msg of msgs) {
    const role = msg.role === "user" ? "USER" : "ASSISTANT"
    output += `\n--- ${role} ---\n`
    
    if (msg.role === "user") {
      output += (msg.text || "") + "\n"
    } else if (msg.role === "assistant") {
      for (const part of msg.content || []) {
        if (part.type === "text") output += (part.text || "") + "\n"
        if (part.type === "thinking") output += `\n[Рассуждение]\n${part.text}\n`
        if (part.type === "toolCall") {
          output += `\n[Инструмент: ${part.name}] (${JSON.stringify(part.input, null, 2)})\n`
        }
      }
    }
  }
  return output
}

function getActiveModel(chatId) {
  const userSettings = getUserSettings(chatId)
  const provider = userSettings.provider || process.env.DEFAULT_MODEL_PROVIDER || "opencode"
  const modelId = userSettings.modelId || process.env.DEFAULT_MODEL_ID || "big-pickle"
  return `${provider}/${modelId}`
}

function extractSessionModel(messages) {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role === "assistant" && msg.model) {
      return `${msg.model.provider}/${msg.model.modelId}`
    }
  }
  return null
}

bot.command("start", async (ctx) => {
  const chatId = String(ctx.chat.id)
  const modelStr = getActiveModel(chatId)
  await ctx.reply(
    "🤖 Pi Agent Telegram Bot\n\n" +
    "• /code <запрос> — задать вопрос ИИ\n" +
    "• /stop — остановить генерацию ответа\n" +
    "• /new [имя] — новый диалог\n" +
    "• /model <provider/model> — сменить модель\n" +
    "• /models — список доступных моделей\n" +
    "• /session [id] [-f] — инфо о сессии (добавьте -f для скачивания файла истории)\n" +
    "• /sessions — список всех сессий\n" +
    "• /switch <id> — переключиться на другую сессию\n" +
    "• /projects — инфо о рабочей папке\n" +
    "• /danger — отключено (встроено)\n" +
    "• /help — справка\n\n" +
    `Текущая модель: ${modelStr}`
  )
})

bot.command("help", async (ctx) => {
  const chatId = String(ctx.chat.id)
  const modelStr = getActiveModel(chatId)
  await ctx.reply(
    "📋 Команды:\n" +
    "/code <запрос> — отправить запрос\n" +
    "/stop — остановить текущую генерацию\n" +
    "/new [имя] — начать новый диалог\n" +
    "/model <provider/model> — сменить модель\n" +
    "/models — список доступных моделей\n" +
    "/session [id] [-f] — инфо о сессии (добавьте -f для скачивания)\n" +
    "/sessions — список всех сессий\n" +
    "/switch <id> — переключиться на другую сессию\n" +
    "/projects — инфо о текущей папке проекта\n\n" +
    `Текущая модель: ${modelStr}`
  )
})

bot.command("stop", async (ctx) => {
  const chatId = String(ctx.chat.id)
  const sess = getSession(chatId)
  if (!sess) return ctx.reply("❌ Нет активной сессии.")

  const stopped = abortStream(sess.sessionId)
  if (stopped) {
    await ctx.reply("🛑 Запрос на остановку отправлен.")
  } else {
    await ctx.reply("ℹ️ Сейчас нет активных запросов для этой сессии.")
  }
})

bot.command("danger", async (ctx) => {
  await ctx.reply("⚠️ Эта команда отключена. Pi Agent встроен напрямую в бота и управляет правами автоматически.")
})

bot.command("projects", async (ctx) => {
  await ctx.reply(`📁 <b>Текущая рабочая папка (проект):</b>\n\n<code>${process.cwd()}</code>`, { parse_mode: "HTML" })
})

bot.command("models", async (ctx) => {
  await ctx.reply("⏳ Загружаю список моделей...")
  try {
    const modelsPath = join(PROJECT_ROOT, "data", "models.json")
    if (!existsSync(modelsPath)) {
      await ctx.reply("❌ Файл data/models.json не найден.")
      return
    }
    const raw = readFileSync(modelsPath, "utf-8")
    const config = JSON.parse(raw)

    const providers = config.providers || {}
    const entries = Object.entries(providers)
    if (entries.length === 0) {
      await ctx.reply("Список моделей пуст.")
      return
    }

    let text = "📋 <b>Локальные модели (data/models.json):</b>\n\n"
    let isTruncated = false

    for (const [provider, providerConfig] of entries) {
      if (text.length > 3500) {
        isTruncated = true
        break
      }
      text += `🔹 <b>${provider}:</b>\n`
      for (const model of providerConfig.models || []) {
        const line = `  <code>${provider}/${model.id}</code>\n`
        if (text.length + line.length > 3800) {
          isTruncated = true
          break
        }
        text += line
      }
      text += "\n"
      if (isTruncated) break
    }

    if (isTruncated) {
      text += "\n... (список обрезан)"
    }

    await ctx.reply(text, { parse_mode: "HTML" })
  } catch (err) {
    await ctx.reply("❌ Ошибка при чтении data/models.json: " + err.message)
  }
})

bot.command("model", async (ctx) => {
  const chatId = String(ctx.chat.id)
  const prompt = ctx.match?.trim()

  if (!prompt) {
    const modelStr = getActiveModel(chatId)
    await ctx.reply(`Текущая модель: ${modelStr}\n\nЧтобы изменить, укажите модель после /model, например:\n/model opencode/gpt-5`)
    return
  }

  const parts = prompt.split('/')
  let provider, modelId
  
  if (parts.length >= 2) {
    provider = parts[0]
    modelId = parts.slice(1).join('/')
  } else {
    provider = "opencode" // Default provider
    modelId = prompt
  }

  setUserModel(chatId, provider, modelId)
  await ctx.reply(`✅ Модель успешно изменена на: ${provider}/${modelId}`)
})

bot.command("code", async (ctx) => {
  const chatId = String(ctx.chat.id)
  const prompt = ctx.match?.trim()

  if (!prompt) {
    await ctx.reply("Укажите запрос после /code. Пример:\n/code Привет!")
    return
  }

  try {
    await streamResponse(chatId, prompt, bot)
  } catch (err) {
    console.error("Ошибка в /code:", err.message)
    await ctx.reply(`❌ Ошибка: ${err.message}`).catch(() => {})
  }
})

bot.command("new", async (ctx) => {
  const chatId = String(ctx.chat.id)
  const args = ctx.match?.trim() || ""

  let cwd = null
  let title = `Telegram-${chatId}`

  // Попытка распарсить: /new <cwd> <title>
  // Простая эвристика: если начинается с буквы диска или /, это путь.
  const parts = args.split(/\s+/)
  if (parts.length > 0 && (parts[0].match(/^[a-zA-Z]:[\\/]/) || parts[0].startsWith("/") || parts[0].startsWith("."))) {
    cwd = parts[0]
    if (parts.length > 1) {
      title = parts.slice(1).join(" ")
    }
  } else if (args) {
    title = args
  }

  try {
    deleteSession(chatId)
    // Передаем новый CWD при создании менеджера
    const manager = await getOrCreateSessionManager(chatId, cwd)
    manager.appendSessionInfo(title)
    
    // Принудительно сохраняем сессию в кеш и в файл-хранилище, чтобы не потерять путь
    setSession(chatId, manager.getSessionId(), manager.getSessionFile(), manager.getCwd())

    await ctx.reply(`✅ Начат новый диалог с именем: <b>${title}</b>\n📁 Папка: <code>${manager.getCwd()}</code>\n(контекст сброшен)`, { parse_mode: "HTML" })
  } catch (err) {
    await ctx.reply(`❌ Ошибка при создании сессии: ${err.message}`)
  }
})

bot.command("session", async (ctx) => {
  const chatId = String(ctx.chat.id)
  const args = ctx.match?.trim().split(/\s+/) || []
  
  let targetSessionId = null
  let sendFile = false

  for (const arg of args) {
    if (arg === "-f") sendFile = true
    else if (!targetSessionId && arg.length > 0) targetSessionId = arg
  }

  if (!targetSessionId) {
    const sess = getSession(chatId)
    targetSessionId = sess?.sessionId
  }

  if (!targetSessionId) {
    await ctx.reply("❌ Нет активной сессии. Отправьте /code или укажите ID: /session <id>")
    return
  }

  try {
    let sessionFile = findSessionFile(targetSessionId)
    const existing = getSession(chatId)
    
    if (!sessionFile && existing?.sessionId === targetSessionId && existing?.sessionFile) {
      sessionFile = existing.sessionFile
    }

    if (!sessionFile || !existsSync(sessionFile)) {
      if (!sessionFile) {
        await ctx.reply("❌ Сессия не найдена на диске.")
        return
      }
    }

    // Если это текущая сессия, забираем менеджер из кеша, чтобы показать актуальное имя (даже если оно не сохранено)
    let m;
    if (targetSessionId === existing?.sessionId) {
      m = await getOrCreateSessionManager(chatId)
    } else {
      m = SessionManager.open(sessionFile, SESSION_DIR)
    }
    
    const context = m.buildSessionContext()
    const msgs = context.messages || []
    
    const userModelStr = getActiveModel(chatId)
    const sessionModelStr = extractSessionModel(msgs)
    const pwd = m.getCwd() || process.cwd()
    const title = m.getSessionName() || targetSessionId

    const modelLine = sessionModelStr && sessionModelStr !== userModelStr
      ? `🤖 <b>Модель пользователя:</b> ${userModelStr}\n` +
        `🧠 <b>Модель последнего ответа:</b> ${sessionModelStr}\n`
      : `🤖 <b>Модель:</b> ${userModelStr}\n`

    await ctx.reply(
      `📋 <b>Инфо о сессии:</b>\n\n` +
      `🆔 <code>${targetSessionId}</code>\n` +
      `📝 <b>Заголовок:</b> ${title}\n` +
      `💬 <b>Сообщений:</b> ${msgs.length}\n` +
      modelLine +
      `📁 <b>Папка:</b> <code>${pwd}</code>\n`,
      { parse_mode: "HTML" }
    )

    if (sendFile && msgs.length > 0) {
      const historyText = formatSessionHistory(msgs)
      const fileName = `history-${targetSessionId.slice(-8)}.md`
      await ctx.replyWithDocument(new InputFile(Buffer.from(historyText), fileName), {
        caption: `📄 История сессии ${targetSessionId}`
      })
    }
  } catch (err) {
    console.error("Session info error:", err.message)
    await ctx.reply(`❌ Ошибка получения информации о сессии: ${err.message}`).catch(() => {})
  }
})

bot.command("sessions", async (ctx) => {
  const chatId = String(ctx.chat.id)
  await ctx.reply("⏳ Загружаю список сессий...")
  try {
    const sessions = await SessionManager.list(process.cwd(), SESSION_DIR)
    
    if (!sessions || sessions.length === 0) {
      return ctx.reply("Список сессий пуст (сессии сохраняются только после первого ответа бота).")
    }

    const LIMIT = 15
    const currentSessionId = getSession(chatId)?.sessionId || null
    let topSessions = sessions.slice(0, LIMIT)

    if (currentSessionId && !topSessions.some(s => s.id === currentSessionId)) {
      const current = sessions.find(s => s.id === currentSessionId)
      if (current) topSessions = [current, ...topSessions].slice(0, LIMIT)
    }

    let text = `📋 <b>Доступные сессии</b> (показано ${topSessions.length} из ${sessions.length}):\n\n`

    topSessions.forEach((s, i) => {
      const currentIndicator = currentSessionId === s.id ? " 🟢 (текущая)" : ""
      text += `${i + 1}. <code>${s.id}</code>${currentIndicator}\n`
      text += `📝 Имя: ${s.name || "Без имени"}\n`
      text += `📁 Папка: <code>${s.cwd || "Неизвестно"}</code>\n\n`
    })

    text += "Чтобы переключиться на нужную сессию, введите:\n<code>/switch &lt;ID_СЕССИИ&gt;</code>"
    await ctx.reply(text, { parse_mode: "HTML" })
  } catch (err) {
    await ctx.reply(`❌ Ошибка: ${err.message}`)
  }
})

bot.command("switch", async (ctx) => {
  const chatId = String(ctx.chat.id)
  const sessionId = ctx.match?.trim()

  if (!sessionId) {
    return ctx.reply("Укажите ID сессии. Пример:\n/switch ses_12345...\n\nСписок сессий можно получить командой /sessions")
  }

  try {
    const sessionFile = findSessionFile(sessionId)
    if (!sessionFile || !existsSync(sessionFile)) {
       return ctx.reply("❌ Сессия с таким ID не найдена.")
    }
    
    // Передаем и ID, и точный путь к файлу в память
    setSession(chatId, sessionId, sessionFile)
    const m = SessionManager.open(sessionFile, SESSION_DIR)
    
    const pwd = m.getCwd() || "Неизвестно"
    await ctx.reply(
      `✅ Контекст успешно переключен!\n\n` +
      `📋 Сессия: <code>${sessionId}</code>\n` +
      `📁 Папка: <code>${pwd}</code>`, 
      { parse_mode: "HTML" }
    )
  } catch (err) {
    await ctx.reply(`❌ Ошибка переключения. Детали: ${err.message}`)
  }
})

bot.catch((err) => {
  console.error("Bot error:", err.error?.message || err.message || err)
  if (err.error?.stack) console.error(err.error.stack)
})

console.log("🤖 Telegram bot for Pi Agent запущен")
console.log("⏳ Запускаю long polling (ожидаю сообщения)...")

bot.start({
  onStart: (botInfo) => {
    console.log(`✅ Long polling запущен. Бот: @${botInfo.username} (id=${botInfo.id})`)
  },
}).catch((err) => {
  console.error("❌ Не удалось запустить long polling:", err.message)
  process.exit(1)
})
