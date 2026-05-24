# 🤖 Telegram Bot для OpenCode

**OpenCode Telegram Bot** — это прослойка между Telegram и AI-агентом OpenCode, позволяющая отправлять запросы и получать ответы от ИИ прямо в Telegram.

Ответы приходят **токен за токеном** — сообщение в Telegram обновляется в реальном времени по мере генерации текста, как в режиме TUI (терминальный интерфейс) OpenCode.

---

## 📋 Содержание

- [Архитектура](#архитектура)
- [Требования](#требования)
- [Структура проекта](#структура-проекта)
- [Установка и настройка](#установка-и-настройка)
- [Описание компонентов](#описание-компонентов)
- [Команды Telegram-бота](#команды-telegram-бота)
- [Запуск](#запуск)
- [Поток обработки запроса](#поток-обработки-запроса)
- [Безопасность](#безопасность)
- [Устранение неполадок](#устранение-неполадок)
- [Дополнительные возможности](#дополнительные-возможности)

---

## Архитектура

```
┌─────────────────┐     Telegram Bot API      ┌──────────────────────┐
│  Telegram User   │ ◄──────────────────────► │  Node.js Bot         │
│  (@your_bot)     │     (polling)             │  (src/index.js)      │
└─────────────────┘                            └──────────┬───────────┘
                                                           │ HTTP (REST)
                                                           │ Basic Auth
                                                           ▼
                                                  ┌─────────────────┐
                                                  │ opencode serve   │
                                                  │ localhost:4096   │
                                                  ├─────────────────┤
                                                  │ AI Model:        │
                                                  │ Big Pickle       │
                                                  │ (OpenCode Zen)   │
                                                  └─────────────────┘
```

Бот работает в связке из двух процессов:

1. **OpenCode Server** (`opencode serve`) — HTTP-сервер, предоставляющий API к AI-моделям
2. **Telegram Bot** (`node src/index.js`) — связывает Telegram с OpenCode

Оба процесса запускаются локально на одном компьютере. Сервер OpenCode доступен только через localhost (не выставляется наружу), а Telegram Bot использует long polling для получения сообщений.

---

## Требования

| Компонент | Версия |
|-----------|--------|
| **Node.js** | ≥ 18 (текущая: 22.22.2) |
| **npm** | ≥ 9 (текущая: 11.12.1) |
| **OpenCode** | ≥ 1.14 (текущая: 1.14.40) |
| **OS** | Windows (PowerShell 5.1) |

### Зависимости npm

| Пакет | Версия | Назначение |
|-------|--------|-----------|
| `@opencode-ai/sdk` | ^1.15.10 | Type-safe клиент к HTTP API OpenCode |
| `grammy` | ^1.43.0 | Telegram Bot API (long polling, ESM-native) |
| `dotenv` | ^17.4.2 | Загрузка переменных из `.env` |

### API-ключи

| Сервис | Назначение |
|--------|-----------|
| **OpenCode Zen** | API-ключ для модели Big Pickle (бесплатно) |
| **Telegram Bot Token** | Токен от [@BotFather](https://t.me/BotFather) |

---

## Структура проекта

```
D:\www\ai\remote_ai\
├── src\                          # Исходный код бота
│   ├── index.js                  # Точка входа, обработчики команд Telegram
│   ├── opencode-client.js        # Инициализация SDK-клиента OpenCode
│   ├── session-store.js          # Управление сессиями (JSON-файл)
│   ├── stream-handler.js         # Потоковая передача ответов через SSE
│   └── message-formatter.js      # Форматирование и разбивка сообщений
├── data\                         # Данные (в .gitignore)
│   └── sessions.json             # Маппинг chatId → sessionId
├── node_modules\                  # Зависимости (в .gitignore)
├── .env                          # Переменные окружения (в .gitignore)
├── .gitignore
├── package.json
├── package-lock.json
├── start-bot.ps1                 # PowerShell-скрипт для запуска
└── README.md
```

---

## Установка и настройка

### 1. Клонирование / создание проекта

```powershell
cd D:\www\ai\remote_ai
npm init -y
```

### 2. Установка зависимостей

```powershell
npm install @opencode-ai/sdk grammy dotenv
```

### 3. Настройка `.env`

Создайте файл `.env` в корне проекта:

```env
TELEGRAM_BOT_TOKEN=ваш_токен_от_BotFather
OPENCODE_SERVER_URL=http://localhost:4096
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=ваш_пароль
DEFAULT_MODEL_PROVIDER=opencode
DEFAULT_MODEL_ID=big-pickle
```

| Переменная | Описание |
|------------|----------|
| `TELEGRAM_BOT_TOKEN` | Токен Telegram-бота, полученный от [@BotFather](https://t.me/BotFather) |
| `OPENCODE_SERVER_URL` | Адрес OpenCode-сервера (по умолчанию `http://localhost:4096`) |
| `OPENCODE_SERVER_USERNAME` | Имя пользователя для Basic Auth (по умолчанию `opencode`) |
| `OPENCODE_SERVER_PASSWORD` | Пароль для Basic Auth (соответствует `OPENCODE_SERVER_PASSWORD`) |
| `DEFAULT_MODEL_PROVIDER` | Провайдер модели (`opencode` для OpenCode Zen) |
| `DEFAULT_MODEL_ID` | ID модели (`big-pickle` — бесплатно) |

### 4. Подключение OpenCode Zen

Модель `opencode/big-pickle` требует аутентификации через OpenCode Zen.

#### Способ A — через TUI:
```powershell
opencode
# В TUI: /connect → OpenCode Zen → вставить API-ключ
```

#### Способ B — напрямую в auth.json:

API-ключ Zen должен присутствовать в файле `%LOCALAPPDATA%\opencode\auth.json`:

```json
{
  "opencode": {
    "type": "api",
    "key": "ваш_ключ_от_opencode.ai/auth"
  }
}
```

#### Проверка:
```powershell
opencode auth list
# Должен отображаться "opencode" в списке
opencode models opencode
# Должен показывать opencode/big-pickle
```

---

## Описание компонентов

### `src/index.js` — Точка входа

Главный файл бота. Использует библиотеку **grammy** (ESM-native, без устаревших зависимостей). Выполняет:

- Загрузку переменных окружения из `.env`
- Инициализацию Telegram-бота с long polling (`bot.start()`)
- Регистрацию команд (`/start`, `/help`, `/code`, `/new`, `/session`)
- Ленивую инициализацию OpenCode-клиента (`ensureClient()`)
- Обработку ошибок через `bot.catch()`

```javascript
// Основная логика команды /code:
// 1. Получить chatId из сообщения
// 2. Найти существующую сессию или создать новую
// 3. Запустить потоковую передачу ответа
// 4. В случае ошибки — отправить сообщение об ошибке
```

### `src/opencode-client.js` — SDK-клиент

Создаёт и кэширует экземпляр SDK-клиента для подключения к OpenCode-серверу.

- Использует Basic Auth (username + password из `.env`)
- Ленивая инициализация — клиент создаётся при первом вызове `getClient()`
- Единый экземпляр на всё время работы бота (синглтон)

### `src/session-store.js` — Хранилище сессий

Управляет маппингом между Telegram `chatId` и OpenCode `sessionId`.

Данные хранятся в файле `data/sessions.json` в формате:

```json
{
  "123456789": {
    "sessionId": "abc-def-ghi",
    "createdAt": "2026-05-24T12:00:00.000Z"
  }
}
```

**Функции:**

| Функция | Описание |
|---------|----------|
| `getSession(chatId)` | Получить сохранённую сессию для чата |
| `setSession(chatId, sessionId)` | Сохранить сессию для чата |
| `deleteSession(chatId)` | Удалить сессию (сброс контекста) |
| `getOrCreateSession(client, chatId)` | Получить существующую или создать новую |

**Особенности:**
- При каждом вызове проверяет, существует ли сессия на сервере (через `client.session.get()`)
- Если сессия была удалена на сервере — автоматически создаёт новую
- Данные сохраняются на диск — маппинг не теряется при перезапуске бота

### `src/stream-handler.js` — Потоковый обработчик

Самый важный компонент. Обеспечивает получение ответа **токен за токеном**.

**Алгоритм:**

```
1. Отправить в Telegram сообщение "⏳ печатает..."
2. Подписаться на SSE-поток событий (/event)
3. Запустить session.prompt() (блокирующий запрос к AI)
4. Параллельно обрабатывать SSE-события:
   - Событие "session.part" с текстом → добавить к буферу
   - Каждые 300 мс → обновлять сообщение в Telegram
   - Событие "session.continue" или "session.done" → завершить SSE
5. Когда prompt() завершится:
   - Остановить SSE-подписку
   - Если SSE дал меньше текста, чем prompt() — взять полный ответ
   - Отправить финальный текст с пометкой "✅ Готово"
```

**Throttling:** сообщение в Telegram обновляется не чаще 1 раза в 300 мс, чтобы избежать rate limit'ов Telegram API.

**SSE Timeout:** при отсутствии событий более 120 секунд подписка прерывается принудительно.

**Обработка длинных ответов:** при превышении 4000 символов первая часть обновляется через `editMessageText`, остальные отправляются через `sendMessage`.

**Обработка ошибок:** при ошибке 401 (Unauthorized) пользователю отправляется инструкция по перезапуску сервера и обновлению пароля.

### `src/message-formatter.js` — Форматирование сообщений

**`splitMessage(text)`** — разбивает длинный текст на части по 4000 символов:

- Ищет точку разрыва по переносу строки или пробелу (чтобы не разрывать слова)
- Если подходящий символ не найден в первой половине блока — режет по границе 4000
- Добавляет нумерацию частей: `[1/3]`, `[2/3]`, `[3/3]`

**`formatErrorMessage(err)`** — форматирует ошибку для отправки в Telegram (экспортируется для внешнего использования, в текущей версии бота не задействована).

### `start-bot.ps1` — Скрипт запуска

PowerShell-скрипт, который:

1. Автоматически останавливает предыдущие экземпляры бота (`node src/index.js`) и сервера (порт 4096), если они запущены
2. Если не запущен — запускает сервер в фоне
3. Переходит в директорию проекта
4. Запускает бота (`node src/index.js`)

**Флаг `-NoServe`:** пропускает остановку и запуск сервера (если он уже запущен отдельно):

```powershell
.\start-bot.ps1 -NoServe
```

---

## Команды Telegram-бота

| Команда | Описание | Пример |
|---------|----------|--------|
| `/start` | Приветствие и список команд | `/start` |
| `/help` | Справка по командам | `/help` |
| `/code <запрос>` | Отправить запрос AI-модели | `/code Напиши функцию сортировки на Python` |
| `/new` | Сбросить контекст (новая сессия) | `/new` |
| `/session` | Информация о текущей сессии | `/session` |

### Особенности работы `/code`

- **Потоковый вывод:** ответ появляется постепенно, токен за токеном
- **Маркер завершения:** в конце добавляется `✅ Готово`
- **Разбивка:** ответы длиннее 4000 символов разбиваются на части с нумерацией `[1/N]`
- **Контекст:** диалог сохраняется между запросами (до команды `/new`)

---

## Запуск

### Способ 1: PowerShell-скрипт (рекомендуется)

Запускает сервер (если не запущен) и бота:

```powershell
.\start-bot.ps1
```

Если сервер уже запущен:

```powershell
.\start-bot.ps1 -NoServe
```

### Способ 2: Два терминала

**Терминал 1 — сервер OpenCode:**

```powershell
npm run serve
```

Или напрямую:

```powershell
opencode serve --port 4096 --hostname 127.0.0.1
```

**Терминал 2 — бот:**

```powershell
npm start
```

Или напрямую:

```powershell
node src/index.js
```

### Проверка запуска

После запуска бот выведет в консоль:

```
🤖 Telegram bot for OpenCode запущен
Модель: opencode/big-pickle
Сервер: http://localhost:4096
```

После этого бот доступен в Telegram.

---

## Поток обработки запроса

```
Telegram: /code "напиши hello world на Python"
    │
    ▼
1. session-store: найти/создать сессию для chatId
    │
    ▼
2. Telegram: "⏳ печатает..." (bot.sendMessage)
    │
    ▼
3. SDK: client.session.prompt() ───► opencode serve
    │                                    │
    │  ── SSE /event ───────────────────►│
    │                                    │
    │  event: session.part {text: "Вот"} │
    │  ◄──── Telegram: editMessageText   │
    │                                    │
    │  event: session.part {text: " "}   │
    │  ◄──── Telegram: editMessageText   │
    │                                    │
    │  event: session.part {text: "ваш"} │
    │  ◄──── Telegram: editMessageText   │
    │        ...                         │
    │                                    │
    │  event: session.continue           │
    │  ◄──── прерываем SSE               │
    │                                    │
    ◄──── prompt() возвращает ответ ────│
    │
    ▼
4. Telegram: полный ответ + "✅ Готово"
```

---

## Безопасность

### Защита сервера OpenCode

- **Basic Auth:** сервер OpenCode защищён паролем (`OPENCODE_SERVER_PASSWORD`)
- **Локальный доступ:** сервер слушает `127.0.0.1` (только локальные подключения)
- Telegram-бот обращается к серверу через localhost — внешний доступ к API отсутствует

### Защита данных

- `.env` с токенами — в `.gitignore` (не попадает в репозиторий)
- `data/` с сессиями — в `.gitignore`
- `node_modules/` — в `.gitignore`

### Telegram Bot Token

Токен Telegram-бота хранится только в `.env`. Не публикуйте его в открытом доступе.

---

## Устранение неполадок

### Проблема: бот не отвечает

**Причина:** сервер OpenCode не запущен или недоступен.

**Решение:**
```powershell
# Проверить, запущен ли сервер
netstat -an | Select-String "4096"

# Запустить сервер
npm run serve
```

### Проблема: ошибка аутентификации OpenCode Zen

**Причина:** API-ключ OpenCode Zen не добавлен или недействителен.

**Решение:**
```powershell
# Проверить список провайдеров
opencode auth list

# Если opencode отсутствует — добавить
opencode auth login --provider opencode --method api
```

### Проблема: сообщение не обновляется в Telegram

**Причина:** Telegram rate limit (слишком частые обновления).

**Решение:** Это штатное поведение. Бот имеет throttle 300 мс. SSE-события могут приходить чаще, но Telegram-сообщение обновляется с ограничением.

### Проблема: ошибка "SESSION_NOT_FOUND"

**Причина:** Сессия была удалена на сервере (например, после перезапуска).

**Решение:** Отправьте `/new` для создания новой сессии.

### Проблема: ESM import ошибки

**Причина:** В `package.json` должен быть `"type": "module"`.

**Решение:**
```json
{
  "type": "module"
}
```

---

## Дополнительные возможности

### Смена модели

Измените переменные в `.env`:

```env
DEFAULT_MODEL_PROVIDER=omni
DEFAULT_MODEL_ID=cx/gpt-5.3-codex
```

Для использования бесплатных альтернатив:

```env
DEFAULT_MODEL_PROVIDER=opencode
DEFAULT_MODEL_ID=deepseek-v4-flash-free    # Альтернативная бесплатная модель
```

### Автозапуск при входе в систему (Windows)

Создайте задачу в Планировщике задач Windows:

1. Откройте `taskschd.msc`
2. Создайте задачу с триггером "При входе в систему"
3. Действие: запуск `powershell.exe -File D:\www\ai\remote_ai\start-bot.ps1 -NoServe`

Или используйте `nssm` для создания службы Windows:

```powershell
nssm install OpenCodeBot "C:\Program Files\nodejs\node.exe" "D:\www\ai\remote_ai\src\index.js"
nssm start OpenCodeBot
```

### Добавление новых команд

Для добавления новой команды в файл `src/index.js`:

```javascript
bot.onText(/\/mycommand (.+)/, async (msg, match) => {
  const chatId = String(msg.chat.id)
  const args = match[1]
  // ваша логика
  await bot.sendMessage(chatId, "Результат")
})
```

### Отладка SSE-событий

Если модель поддерживает другие типы SSE-событий, добавьте логирование в `stream-handler.js`:

```javascript
// В цикле обработки SSE:
console.log("SSE event:", event.type, JSON.stringify(props))
```

---

## Лицензия

Проект распространяется как часть конфигурации OpenCode. Все права на OpenCode принадлежат [Anomaly](https://anoma.ly).
