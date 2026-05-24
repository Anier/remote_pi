import "dotenv/config"
import { Bot, InlineKeyboard } from "grammy"
import { exec } from "node:child_process"
import { promisify } from "node:util"
import { getClient } from "./opencode-client.js"
import { getOrCreateSession, getSession, deleteSession, setSession } from "./session-store.js"
import { streamResponse } from "./stream-handler.js"
import { getUserSettings, setUserModel } from "./user-store.js"

const execAsync = promisify(exec)

const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN не задан в .env")
  process.exit(1)
}

const bot = new Bot(token)

let client = null
function ensureClient() {
  if (!client) {
    try {
      client = getClient()
    } catch (err) {
      console.error("Не удалось создать OpenCode-клиент:", err.message)
      throw err
    }
  }
  return client
}

function getActiveModel(chatId) {
  const userSettings = getUserSettings(chatId)
  const provider = userSettings.provider || process.env.DEFAULT_MODEL_PROVIDER || "opencode"
  const modelId = userSettings.modelId || process.env.DEFAULT_MODEL_ID || "big-pickle"
  return `${provider}/${modelId}`
}

bot.command("start", async (ctx) => {
  const chatId = String(ctx.chat.id)
  const modelStr = getActiveModel(chatId)
  await ctx.reply(
    "🤖 OpenCode Telegram Bot\n\n" +
    "• /code <запрос> — задать вопрос ИИ\n" +
    "• /new [имя] — новый диалог (с опциональным именем)\n" +
    "• /model <provider/model> — сменить модель\n" +
    "• /models — список доступных моделей\n" +
    "• /session — информация о текущей сессии\n" +
    "• /sessions — список всех сессий\n" +
    "• /switch <id> — переключиться на другую сессию\n" +
    "• /help — эта справка\n\n" +
    `Текущая модель: ${modelStr}`
  )
})

bot.command("help", async (ctx) => {
  const chatId = String(ctx.chat.id)
  const modelStr = getActiveModel(chatId)
  await ctx.reply(
    "📋 Команды:\n" +
    "/code <запрос> — отправить запрос\n" +
    "/new [имя] — начать новый диалог (можно задать имя)\n" +
    "/model <provider/model> — сменить модель\n" +
    "/models — список доступных моделей\n" +
    "/session — текущая сессия\n" +
    "/sessions — список всех сессий\n" +
    "/switch <id> — переключиться на другую сессию\n\n" +
    "Ответы приходят токен за токеном, как в TUI.\n" +
    "В конце добавляется ✅ Готово.\n\n" +
    `Текущая модель: ${modelStr}`
  )
})

bot.command("models", async (ctx) => {
  await ctx.reply("⏳ Загружаю список моделей...")
  try {
    const { stdout } = await execAsync("opencode models")
    const models = stdout.trim()
    if (!models) {
      await ctx.reply("Список моделей пуст или недоступен.")
      return
    }
    
    if (models.length > 4000) {
      await ctx.reply(`Доступные модели:\n\n${models.slice(0, 3900)}... (список обрезан)`)
    } else {
      await ctx.reply(`Доступные модели:\n\n${models}`)
    }
  } catch (err) {
    await ctx.reply("❌ Ошибка при получении списка моделей: " + err.message)
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
    provider = "opencode"
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
    const c = ensureClient()
    const sessionId = await getOrCreateSession(c, chatId)
    await streamResponse(chatId, sessionId, prompt, bot)
  } catch (err) {
    console.error("Ошибка в /code:", err.message)
    await ctx.reply(`❌ Ошибка: ${err.message}`).catch(() => {})
  }
})

bot.command("new", async (ctx) => {
  const chatId = String(ctx.chat.id)
  const title = ctx.match?.trim()

  try {
    if (title) {
      const c = ensureClient()
      const session = await c.session.create({
        body: { title: title }
      })
      if (!session?.data?.id) {
        throw new Error("Не удалось создать сессию: нет id в ответе")
      }
      setSession(chatId, session.data.id)
      await ctx.reply(`✅ Начат новый диалог с именем: <b>${title}</b>\n(контекст сброшен)`, { parse_mode: "HTML" })
    } else {
      deleteSession(chatId)
      await ctx.reply("✅ Начат новый диалог (контекст сброшен)")
    }
  } catch (err) {
    await ctx.reply(`❌ Ошибка при создании сессии: ${err.message}`)
  }
})

bot.command("session", async (ctx) => {
  const chatId = String(ctx.chat.id)
  const sess = getSession(chatId)
  if (!sess) {
    await ctx.reply("❌ Нет активной сессии. Отправьте /code")
    return
  }
  try {
    const c = ensureClient()
    const [info, project] = await Promise.all([
      c.session.get({ path: { id: sess.sessionId } }),
      c.project.current()
    ])
    const modelStr = getActiveModel(chatId)
    const pwd = project?.data?.worktree || "Неизвестно"
    await ctx.reply(
      `📋 Сессия: <code>${sess.sessionId}</code>\n` +
      `Создана: ${new Date(sess.createdAt).toLocaleString("ru-RU")}\n` +
      `Сообщений: ${info?.data?.children?.length || 0}\n` +
      `Модель: ${modelStr}\n` +
      `Папка: <code>${pwd}</code>`,
      { parse_mode: "HTML" }
    )
  } catch {
    await ctx.reply("❌ Сессия недоступна. Используйте /new").catch(() => {})
  }
})

bot.command("sessions", async (ctx) => {
  const chatId = String(ctx.chat.id)
  await ctx.reply("⏳ Загружаю список сессий...")
  try {
    const c = ensureClient()
    const res = await c.session.list()
    const sessions = res.data || []
    
    if (sessions.length === 0) {
      return ctx.reply("Список сессий пуст.")
    }

    // Sort by updated time, descending
    sessions.sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))

    let text = "📋 <b>Доступные сессии:</b>\n\n"
    
    // Take top 15 to avoid massive messages
    const topSessions = sessions.slice(0, 15)
    
    for (let i = 0; i < topSessions.length; i++) {
      const s = topSessions[i]
      const ts = s.time?.updated || s.time?.created
      const date = ts ? new Date(ts).toLocaleString("ru-RU") : "Неизвестно"
      const currentIndicator = getSession(chatId)?.sessionId === s.id ? " 🟢 (текущая)" : ""
      
      text += `${i + 1}. <code>${s.id}</code>${currentIndicator}\n`
      text += `📝 Имя: ${s.title || s.slug || "Без имени"}\n`
      text += `📁 Папка: <code>${s.directory || "Неизвестно"}</code>\n`
      text += `⏱ Обновлена: ${date}\n\n`
    }

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
    const c = ensureClient()
    const info = await c.session.get({ path: { id: sessionId } })
    
    if (!info?.data?.id) {
       return ctx.reply("❌ Сессия с таким ID не найдена.")
    }
    
    setSession(chatId, sessionId)
    
    const pwd = info.data.directory || "Неизвестно"
    await ctx.reply(
      `✅ Контекст успешно переключен!\n\n` +
      `📋 Сессия: <code>${sessionId}</code>\n` +
      `📁 Папка: <code>${pwd}</code>`, 
      { parse_mode: "HTML" }
    )
  } catch (err) {
    await ctx.reply(`❌ Ошибка переключения. Возможно, сессия не существует или сервер недоступен.\nДетали: ${err.message}`)
  }
})

bot.catch((err) => {
  console.error("Bot error:", err.message)
})

console.log("🤖 Telegram bot for OpenCode запущен")
console.log(`Сервер: ${process.env.OPENCODE_SERVER_URL || "http://localhost:4096"}`)

bot.start()