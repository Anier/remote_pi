import "dotenv/config"
import { Bot, InlineKeyboard, InputFile } from "grammy"
import { exec } from "node:child_process"
import { promisify } from "node:util"
import { getClient } from "./opencode-client.js"
import { getOrCreateSession, getSession, deleteSession, setSession } from "./session-store.js"
import { streamResponse, activeRequests } from "./stream-handler.js"
import { getUserSettings, setUserModel } from "./user-store.js"

const execAsync = promisify(exec)

const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN не задан в .env")
  process.exit(1)
}

const bot = new Bot(token)

// Middleware для ограничения доступа
const ALLOWED_USERS = (process.env.TELEGRAM_ALLOWED_USERS || "")
  .split(",")
  .map(id => id.trim())
  .filter(id => id.length > 0)

bot.use(async (ctx, next) => {
  const userId = String(ctx.from?.id)
  if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(userId)) {
    console.warn(`Заблокирована попытка доступа от пользователя: ${userId}`)
    await ctx.reply("⛔ У вас нет доступа к этому боту.")
    return
  }
  await next()
})

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

function formatSessionHistory(msgs) {
  let output = ""
  for (const msg of msgs) {
    const role = msg.info?.role === "user" ? "USER" : "ASSISTANT"
    const time = msg.info?.time?.created ? new Date(msg.info.time.created).toLocaleString("ru-RU") : ""
    output += `\n--- ${role} (${time}) ---\n`
    
    if (!msg.parts) continue
    
    for (const part of msg.parts) {
      if (part.type === "text") {
        output += (part.text || "") + "\n"
      } else if (part.type === "reasoning") {
        output += `\n[Рассуждение]\n${part.text}\n`
      } else if (part.type === "tool") {
        const toolName = part.tool || "unknown"
        const status = part.state?.status || ""
        output += `\n[Инструмент: ${toolName}] (${status})\n`
        if (part.state?.input) {
          output += `Аргументы: ${JSON.stringify(part.state.input, null, 2)}\n`
        }
        if (part.state?.output) {
          const out = String(part.state.output)
          output += `Результат: ${out.length > 500 ? out.slice(0, 500) + "..." : out}\n`
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

bot.command("start", async (ctx) => {
  const chatId = String(ctx.chat.id)
  const modelStr = getActiveModel(chatId)
  await ctx.reply(
    "🤖 OpenCode Telegram Bot\n\n" +
    "• /code <запрос> — задать вопрос ИИ\n" +
    "• /stop — остановить генерацию ответа\n" +
    "• /new [имя] — новый диалог (с опциональным именем)\n" +
    "• /model <provider/model> — сменить модель\n" +
    "• /models — список доступных моделей\n" +
    "• /session [id] [-f] — инфо о сессии (добавьте -f для загрузки файла истории)\n" +
    "• /sessions — список всех сессий\n" +
    "• /switch <id> — переключиться на другую сессию\n" +
    "• /projects — список проектов на сервере\n" +
    "• /danger <on|off> — режим авто-подтверждения команд\n" +
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
    "/stop — остановить текущую генерацию\n" +
    "/new [имя] — начать новый диалог (можно задать имя)\n" +
    "/model <provider/model> — сменить модель\n" +
    "/models — список доступных моделей\n" +
    "/session [id] [-f] — инфо о сессии (добавьте -f для скачивания истории файлом)\n" +
    "/sessions — список всех сессий\n" +
    "/switch <id> — переключиться на другую сессию\n" +
    "/projects — список проектов на сервере\n" +
    "/danger <on|off> — включить/выключить авто-подтверждение всех команд (RESTART)\n\n" +
    "Ответы приходят токен за токеном, как в TUI.\n" +
    "В конце добавляется ✅ Готово.\n\n" +
    `Текущая модель: ${modelStr}`
  )
})

bot.command("stop", async (ctx) => {
  const chatId = String(ctx.chat.id)
  const sess = getSession(chatId)
  if (!sess) return ctx.reply("❌ Нет активной сессии.")

  const controller = activeRequests.get(sess.sessionId)
  if (controller) {
    controller.abort()
    await ctx.reply("🛑 Запрос на остановку отправлен.")
  } else {
    await ctx.reply("ℹ️ Сейчас нет активных запросов для этой сессии.")
  }
})

bot.command("danger", async (ctx) => {
  const mode = ctx.match?.trim().toLowerCase()
  const scriptPath = "D:\\www\\ai\\remote_ai\\start-bot.ps1"

  if (mode === "on") {
    await ctx.reply("🚀 Включаю режим авто-подтверждения. Бот и сервер будут перезагружены...")
    exec(`powershell.exe -Command "Start-Process powershell.exe -ArgumentList '-NoProfile', '-File', '${scriptPath}', '-SkipPermissions' -WindowStyle Hidden"`)
  } else if (mode === "off") {
    await ctx.reply("🛡 Выключаю режим авто-подтверждения. Бот и сервер будут перезагружены...")
    exec(`powershell.exe -Command "Start-Process powershell.exe -ArgumentList '-NoProfile', '-File', '${scriptPath}' -WindowStyle Hidden"`)
  } else {
    await ctx.reply("Укажите режим: `/danger on` или `/danger off`\n\nВнимание: это приведет к полной перезагрузке бота и сервера.", { parse_mode: "Markdown" })
  }
})

bot.command("projects", async (ctx) => {
  await ctx.reply("⏳ Загружаю список проектов...")
  try {
    const c = ensureClient()
    const res = await c.project.list()
    const projects = res.data || []
    
    if (projects.length === 0) {
      return ctx.reply("Список проектов пуст.")
    }

    let text = "📁 <b>Доступные проекты:</b>\n\n"
    for (let i = 0; i < projects.length; i++) {
      const p = projects[i]
      if (p.id === "global") continue
      text += `${i + 1}. <b>${p.worktree.split(/[\\/]/).pop()}</b>\n`
      text += `🆔 <code>${p.id}</code>\n`
      text += `📍 <code>${p.worktree}</code>\n\n`
    }

    text += "Чтобы начать работу в проекте, переключитесь на одну из его сессий через /sessions и /switch."
    await ctx.reply(text, { parse_mode: "HTML" })
  } catch (err) {
    await ctx.reply(`❌ Ошибка: ${err.message}`)
  }
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
  const args = ctx.match?.trim().split(/\s+/) || []
  
  let targetSessionId = null
  let sendFile = false

  for (const arg of args) {
    if (arg === "-f") {
      sendFile = true
    } else if (!targetSessionId && arg.length > 0) {
      targetSessionId = arg
    }
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
    const c = ensureClient()
    const [info, msgs, project] = await Promise.all([
      c.session.get({ path: { id: targetSessionId } }),
      c.session.messages({ path: { id: targetSessionId } }),
      c.project.current()
    ])
    
    const modelStr = getActiveModel(chatId)
    const pwd = info?.data?.directory || project?.data?.worktree || "Неизвестно"
    const summary = info?.data?.summary || {}
    const title = info?.data?.title || info?.data?.slug || "Без названия"
    
    // Check if auto-confirm is active on server
    const isDanger = process.env.OPENCODE_SERVER_ARGS?.includes("--dangerously-skip-permissions") || false
    const dangerStatus = isDanger ? "🚀 ON (авто-подтверждение)" : "🛡 OFF (безопасно)"

    await ctx.reply(
      `📋 <b>Инфо о сессии:</b>\n\n` +
      `🆔 <code>${targetSessionId}</code>\n` +
      `📝 <b>Заголовок:</b> ${title}\n` +
      `💬 <b>Сообщений:</b> ${msgs?.data?.length || 0}\n` +
      `🛠 <b>Правки:</b> +${summary.additions || 0} / -${summary.deletions || 0} (${summary.files || 0} файлов)\n` +
      `🤖 <b>Модель:</b> ${modelStr}\n` +
      `📁 <b>Папка:</b> <code>${pwd}</code>\n` +
      `⚡ <b>Режим подтверждений:</b> ${dangerStatus}\n` +
      `🕒 <b>Обновлена:</b> ${new Date(info?.data?.time?.updated || info?.data?.time?.created).toLocaleString("ru-RU")}`,
      { parse_mode: "HTML" }
    )

    if (sendFile && msgs?.data?.length > 0) {
      const historyText = formatSessionHistory(msgs.data)
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
    const c = ensureClient()
    const res = await c.session.list()
    const sessions = res.data || []
    
    if (sessions.length === 0) {
      return ctx.reply("Список сессий пуст.")
    }

    sessions.sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))

    let text = "📋 <b>Доступные сессии:</b>\n\n"
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
