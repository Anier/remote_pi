const MAX_LEN = 4000

export function splitMessage(text) {
  if (!text || text.length <= MAX_LEN) return [text || "❗ Пустой ответ"]

  const parts = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LEN) {
      parts.push(remaining)
      break
    }

    const window = remaining.slice(0, MAX_LEN)
    const lastNewline = window.lastIndexOf("\n")
    const lastSpace = window.lastIndexOf(" ")

    let splitAt = lastNewline > MAX_LEN * 0.5 ? lastNewline
      : lastSpace > MAX_LEN * 0.5 ? lastSpace
      : MAX_LEN
    if (splitAt <= 0) splitAt = MAX_LEN

    parts.push(remaining.slice(0, splitAt))

    const rest = remaining.slice(splitAt)
    const trimmed = rest.trimStart()
    // Защита от зацикливания: гарантируем, что remaining уменьшается.
    remaining = trimmed.length < rest.length ? trimmed : rest
  }

  return parts.map((p, i) => `[${i + 1}/${parts.length}]\n${p}`)
}

export function formatErrorMessage(err) {
  return `❌ Ошибка: ${err.message || String(err)}`
}
