import { createOpencodeClient } from "@opencode-ai/sdk"

let client = null

export function getClient() {
  if (client) return client
  const auth = Buffer.from(
    `${process.env.OPENCODE_SERVER_USERNAME}:${process.env.OPENCODE_SERVER_PASSWORD}`
  ).toString("base64")
  client = createOpencodeClient({
    baseUrl: process.env.OPENCODE_SERVER_URL,
    headers: { Authorization: `Basic ${auth}` }
  })
  return client
}
