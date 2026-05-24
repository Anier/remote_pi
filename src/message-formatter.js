const MAX_LEN = 4000

export function splitMessage(text) {
  if (!text || text.length <= MAX_LEN) return [text || "❗ Пустой ответ"]

  const parts = []
  let remaining = text

  while (remaining.length > 0) {
    let chunk = remaining.slice(0, MAX_LEN)

    const lastNewline = chunk.lastIndexOf("\n")
    const lastSpace = chunk.lastIndexOf(" ")
    const splitAt = lastNewline > MAX_LEN * 0.5 ? lastNewline
      : lastSpace > MAX_LEN * 0.5 ? lastSpace
      : MAX_LEN

    chunk = remaining.slice(0, splitAt)
    parts.push(chunk)
    remaining = remaining.slice(splitAt).trim()
  }

  return parts.map((p, i) => `[${i + 1}/${parts.length}]\n${p}`)
}

export function formatErrorMessage(err) {
  return `❌ Ошибка: ${err.message || String(err)}`
}
