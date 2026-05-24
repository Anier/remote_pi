import "dotenv/config"
import TelegramBot from "node-telegram-bot-api"
import { getClient } from "./opencode-client.js"
import { getOrCreateSession, getSession, setSession, deleteSession } from "./session-store.js"
import { streamResponse } from "./stream-handler.js"

const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN не задан в .env")
  process.exit(1)
}

const bot = new TelegramBot(token, { polling: true })
const client = getClient()

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    "🤖 OpenCode Telegram Bot\n\n" +
    "• /code <запрос> — задать вопрос ИИ\n" +
    "• /new — новый диалог (сброс контекста)\n" +
    "• /session — информация о сессии\n" +
    "• /help — эта справка\n\n" +
    "Модель: Big Pickle (бесплатно, OpenCode Zen)"
  )
})

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    "📋 Команды:\n" +
    "/code <запрос> — отправить запрос\n" +
    "/new — начать новый диалог\n" +
    "/session — текущая сессия\n\n" +
    "Ответы приходят токен за токеном, как в TUI.\n" +
    "В конце добавляется ✅ Готово."
  )
})

bot.onText(/\/code (.+)/, async (msg, match) => {
  const chatId = String(msg.chat.id)
  const prompt = match[1].trim()
  if (!prompt) {
    await bot.sendMessage(chatId, "Укажите запрос после /code")
    return
  }
  try {
    const sessionId = await getOrCreateSession(client, chatId)
    await streamResponse(chatId, sessionId, prompt, bot)
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Ошибка: ${err.message || err}`)
  }
})

bot.onText(/\/new/, async (msg) => {
  const chatId = String(msg.chat.id)
  deleteSession(chatId)
  await bot.sendMessage(chatId, "✅ Начат новый диалог (контекст сброшен)")
})

bot.onText(/\/session/, async (msg) => {
  const chatId = String(msg.chat.id)
  const sess = getSession(chatId)
  if (!sess) {
    await bot.sendMessage(chatId, "❌ Нет активной сессии. Отправьте /code")
    return
  }
  try {
    const info = await client.session.get({ path: { id: sess.sessionId } })
    await bot.sendMessage(chatId,
      `📋 Сессия: \`${sess.sessionId}\`\n` +
      `Создана: ${new Date(sess.createdAt).toLocaleString("ru-RU")}\n` +
      `Сообщений: ${info.children?.length || 0}`
    )
  } catch {
    await bot.sendMessage(chatId, "❌ Сессия недоступна. Используйте /new")
  }
})

bot.on("polling_error", (err) => {
  console.error("Polling error:", err.message)
})

console.log("🤖 Telegram bot for OpenCode запущен")
console.log(`Модель: ${process.env.DEFAULT_MODEL_PROVIDER}/${process.env.DEFAULT_MODEL_ID}`)
console.log(`Сервер: ${process.env.OPENCODE_SERVER_URL}`)
