import { createOpencodeClient } from "@opencode-ai/sdk"

let client = null

export function getClient() {
  if (client) return client

  const username = process.env.OPENCODE_SERVER_USERNAME || "opencode"
  const password = process.env.OPENCODE_SERVER_PASSWORD

  if (!password) {
    throw new Error(
      "OPENCODE_SERVER_PASSWORD не задан. " +
      "Убедитесь, что opencode serve запущен и переменная установлена в .env или системных переменных."
    )
  }

  const auth = Buffer.from(`${username}:${password}`).toString("base64")

  client = createOpencodeClient({
    baseUrl: process.env.OPENCODE_SERVER_URL || "http://localhost:4096",
    headers: { Authorization: `Basic ${auth}` },
    throwOnError: true
  })
  return client
}
