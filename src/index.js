import "dotenv/config"
import { Bot } from "grammy"
import { getClient } from "./opencode-client.js"
import { getOrCreateSession, getSession, deleteSession } from "./session-store.js"
import { streamResponse } from "./stream-handler.js"

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

bot.command("start", async (ctx) => {
  await ctx.reply(
    "🤖 OpenCode Telegram Bot\n\n" +
    "• /code <запрос> — задать вопрос ИИ\n" +
    "• /new — новый диалог (сброс контекста)\n" +
    "• /session — информация о сессии\n" +
    "• /help — эта справка\n\n" +
    "Модель: Big Pickle (бесплатно, OpenCode Zen)"
  )
})

bot.command("help", async (ctx) => {
  await ctx.reply(
    "📋 Команды:\n" +
    "/code <запрос> — отправить запрос\n" +
    "/new — начать новый диалог\n" +
    "/session — текущая сессия\n\n" +
    "Ответы приходят токен за токеном, как в TUI.\n" +
    "В конце добавляется ✅ Готово."
  )
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
  deleteSession(chatId)
  await ctx.reply("✅ Начат новый диалог (контекст сброшен)")
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
    const info = await c.session.get({ path: { id: sess.sessionId } })
    await ctx.reply(
      `📋 Сессия: <code>${sess.sessionId}</code>\n` +
      `Создана: ${new Date(sess.createdAt).toLocaleString("ru-RU")}\n` +
      `Сообщений: ${info?.data?.children?.length || 0}`,
      { parse_mode: "HTML" }
    )
  } catch {
    await ctx.reply("❌ Сессия недоступна. Используйте /new").catch(() => {})
  }
})

bot.catch((err) => {
  console.error("Bot error:", err.message)
})

console.log("🤖 Telegram bot for OpenCode запущен")
console.log(`Модель: ${process.env.DEFAULT_MODEL_PROVIDER}/${process.env.DEFAULT_MODEL_ID}`)
console.log(`Сервер: ${process.env.OPENCODE_SERVER_URL}`)

bot.start()
