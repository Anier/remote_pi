# Pi Agent Telegram Bot

[Читать на русском языке (README_RU.md)](./README_RU.md)

A Telegram bot for interacting with the [Pi Coding Agent](https://pi.dev). This bot allows you to chat with an AI agent, execute terminal commands, and edit files directly through Telegram.

## Features

- 🤖 **Embedded Agent:** No separate server required; runs directly using the Pi SDK.
- 💬 **Response Streaming:** Text is delivered progressively, similar to a TUI experience, with built-in API error handling.
- 📁 **Session Context:** Chat history and tool states are persisted to disk.
- 🛠 **Tool Support:** The agent can read files, execute bash commands, and propose file edits.
- 🔐 **Security:** Access restricted by a whitelist of Telegram User IDs.

## Installation

1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file based on `.env-example` and fill in the required values.
4. Configure your available models in `data/models.json`.

## Model Configuration (`data/models.json`)

Each bot deployment uses its own unique local model file. To add an OpenAI-compatible server, use the following format:

```json
{
  "providers": {
    "my-custom-provider": {
      "name": "Local AI",
      "baseUrl": "http://your-endpoint:port/v1",
      "api": "openai-responses",
      "apiKey": "any-string-or-key",
      "models": [
        {
          "id": "model-id-on-server",
          "name": "Display Name"
        }
      ]
    }
  }
}
```

**Important Notes:**
- `api`: Use `openai-completions` for Chat Completions API, or `openai-responses` for OpenAI Responses API.
- `apiKey`: **Required field**. Even if your server doesn't require authentication, the Pi SDK will ignore the provider if this field is missing.

## Launch

```bash
npm run start:bot
```

## Bot Commands

- `/code <request>` — Send a request to the agent.
- `/stop` — Stop current generation or tool execution.
- `/new [path_to_folder] [session_name]` — Start a new dialogue. You can optionally specify the working directory and session title.
- `/model <provider/model>` — Change the model for the current user.
- `/models` — List all available models (grouped by provider).
- `/session [id] [-f]` — Get session info (add `-f` to download history as a file).
- `/sessions` — List the most recent sessions.
- `/switch <id>` — Switch to an existing session by its ID.
- `/projects` — Show the bot's current working directory.
- `/help` — Help with commands.

## Data Storage & Behavior

- **Persistence Delay:** Session files in `data/sessions/` are physically created on disk only after the assistant sends its **first response**. Until then, data (CWD, title) is kept in the bot's memory.
- `data/sessions.json` — Mapping of Chat ID -> Session ID.
- `data/users.json` — User settings (selected model).
- `data/models.json` — Model registry specific to this project instance.
