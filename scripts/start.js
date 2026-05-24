#!/usr/bin/env node
// Кросс-платформенный супервизор: запускает opencode serve + Telegram-бота
// и переподнимает связку, когда бот пишет режим в data/danger.flag.
//
// Флаги:
//   --no-serve         не запускать opencode serve (только бот)
//   --skip-permissions запустить сервер с --dangerously-skip-permissions
//
// Переменные окружения (примеры):
//   OPENCODE_PORT=4096
//   OPENCODE_HOST=127.0.0.1

import { spawn, execFile } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import net from "node:net"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, "..")
const DATA_DIR = resolve(PROJECT_ROOT, "data")
const FLAG_PATH = resolve(DATA_DIR, "danger.flag")

const args = new Set(process.argv.slice(2))
let skipPermissions = args.has("--skip-permissions") || args.has("-SkipPermissions")
const noServe = args.has("--no-serve") || args.has("-NoServe")

const PORT = Number(process.env.OPENCODE_PORT) || 4096
const HOST = process.env.OPENCODE_HOST || "127.0.0.1"
const IS_WIN = process.platform === "win32"
const OPENCODE_BIN = process.env.OPENCODE_BIN || (IS_WIN ? "opencode.cmd" : "opencode")

let serveProc = null
let botProc = null
let shuttingDown = false

mkdirSync(DATA_DIR, { recursive: true })

function log(...a) { console.log("[start]", ...a) }
function logErr(...a) { console.error("[start]", ...a) }

function waitForPort(host, port, timeoutMs = 20000) {
  const start = Date.now()
  return new Promise((resolveP, rejectP) => {
    const tryOnce = () => {
      const sock = net.createConnection({ host, port })
      sock.once("connect", () => { sock.destroy(); resolveP() })
      sock.once("error", () => {
        sock.destroy()
        if (Date.now() - start > timeoutMs) return rejectP(new Error(`Сервер ${host}:${port} не поднялся за ${timeoutMs} мс`))
        setTimeout(tryOnce, 300)
      })
    }
    tryOnce()
  })
}

function isPortFree(host, port, timeoutMs = 600) {
  return new Promise((resolveP) => {
    const sock = net.createConnection({ host, port })
    const done = (free) => { sock.destroy(); resolveP(free) }
    sock.once("connect", () => done(false))
    sock.once("error", () => done(true))
    setTimeout(() => done(true), timeoutMs).unref()
  })
}

function execp(cmd, args) {
  return new Promise(r => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout, stderr) => {
      r({ err, stdout: String(stdout || ""), stderr: String(stderr || "") })
    })
  })
}

async function findPidsOnPort(port) {
  const pids = new Set()
  if (IS_WIN) {
    const { stdout } = await execp("netstat", ["-ano", "-p", "tcp"])
    for (const line of stdout.split(/\r?\n/)) {
      // TCP    127.0.0.1:4096    0.0.0.0:0    LISTENING    1234
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i)
      if (m && Number(m[1]) === port) pids.add(Number(m[2]))
    }
  } else {
    let { stdout } = await execp("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"])
    if (!stdout.trim()) {
      // Фолбэк через fuser, если lsof отсутствует.
      const f = await execp("fuser", [`${port}/tcp`])
      stdout = f.stdout
    }
    for (const p of stdout.split(/\s+/)) {
      const n = Number(p)
      if (Number.isFinite(n) && n > 0) pids.add(n)
    }
  }
  return [...pids]
}

async function killPid(pid) {
  if (IS_WIN) {
    await execp("taskkill", ["/PID", String(pid), "/F"])
  } else {
    try { process.kill(pid, "SIGTERM") } catch {}
    // Контрольный SIGKILL через короткую задержку, если процесс ещё жив.
    await new Promise(r => setTimeout(r, 700))
    try { process.kill(pid, 0); process.kill(pid, "SIGKILL") } catch {}
  }
}

async function freePort(host, port) {
  if (await isPortFree(host, port)) return
  log(`Порт ${port} занят — пытаюсь освободить...`)
  let pids = []
  try { pids = await findPidsOnPort(port) } catch (e) { logErr("Не удалось получить список PID:", e.message) }
  for (const pid of pids) {
    log(`Останавливаю процесс PID=${pid} на порту ${port}`)
    try { await killPid(pid) } catch (e) { logErr(`taskkill/kill PID=${pid}:`, e.message) }
  }
  // Ждём, пока порт реально освободится.
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await isPortFree(host, port)) {
      log(`Порт ${port} освобождён.`)
      return
    }
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error(`Не удалось освободить порт ${port} за 5 сек`)
}

// Находит и убивает старые экземпляры бота (node, выполняющие src/index.js).
async function killStaleBots() {
  const myPid = process.pid
  if (IS_WIN) {
    // wmic устарел, но всё ещё доступен. Альтернатива — PowerShell Get-CimInstance.
    const { stdout } = await execp("wmic", ["process", "where", "name='node.exe'", "get", "ProcessId,CommandLine", "/format:csv"])
    for (const line of stdout.split(/\r?\n/)) {
      if (!/src[\\/]index\.js/.test(line)) continue
      const parts = line.split(",")
      const pid = Number(parts[parts.length - 1])
      if (Number.isFinite(pid) && pid !== myPid) {
        log(`Останавливаю старый процесс бота PID=${pid}`)
        try { await killPid(pid) } catch {}
      }
    }
  } else {
    const { stdout } = await execp("pgrep", ["-f", "src/index.js"])
    for (const p of stdout.split(/\s+/)) {
      const pid = Number(p)
      if (Number.isFinite(pid) && pid > 0 && pid !== myPid) {
        log(`Останавливаю старый процесс бота PID=${pid}`)
        try { await killPid(pid) } catch {}
      }
    }
  }
}

async function startServe() {
  if (noServe) {
    log("Пропускаю запуск opencode serve (--no-serve).")
    return
  }

  // Preflight: убиваем старый opencode serve на порту и зомби-процессы бота.
  await freePort(HOST, PORT)

  const serveArgs = ["serve", "--port", String(PORT), "--hostname", HOST]
  if (skipPermissions) {
    log("🚀 Режим авто-подтверждения: --dangerously-skip-permissions")
    serveArgs.push("--dangerously-skip-permissions")
    process.env.OPENCODE_SERVER_ARGS = "--dangerously-skip-permissions"
  } else {
    process.env.OPENCODE_SERVER_ARGS = ""
  }

  log(`Запускаю ${OPENCODE_BIN} ${serveArgs.join(" ")}`)
  serveProc = spawn(OPENCODE_BIN, serveArgs, {
    stdio: ["ignore", "inherit", "inherit"],
    shell: IS_WIN,
    env: process.env,
  })
  serveProc.on("exit", (code, signal) => {
    if (shuttingDown) return
    logErr(`opencode serve завершился (code=${code} signal=${signal}). Бот тоже будет остановлен.`)
    stopBot()
  })

  await waitForPort(HOST, PORT)
  log(`✅ opencode serve поднялся на ${HOST}:${PORT}`)
}

function startBot() {
  log("Запускаю Telegram-бота...")
  const env = { ...process.env, OPENCODE_SUPERVISOR_PID: String(process.pid) }
  botProc = spawn(process.execPath, [resolve(PROJECT_ROOT, "src", "index.js")], {
    stdio: "inherit",
    env,
  })
  botProc.on("exit", async (code, signal) => {
    if (shuttingDown) return
    log(`Бот завершился (code=${code} signal=${signal}).`)

    if (existsSync(FLAG_PATH)) {
      const mode = readFileSync(FLAG_PATH, "utf-8").trim()
      try { rmSync(FLAG_PATH) } catch {}
      skipPermissions = mode === "on"
      log(`Получен флаг /danger ${mode} — перезапускаю связку.`)
      await stopServe()
      try { await startServe() } catch (e) { logErr(e.message); shutdown(1); return }
      startBot()
      return
    }

    // Бот сам упал — выходим, чтобы внешний менеджер процессов мог разобраться.
    shutdown(code ?? 1)
  })
}

function stopBot() {
  if (botProc && !botProc.killed) {
    try { botProc.kill("SIGTERM") } catch {}
    setTimeout(() => { try { botProc?.kill("SIGKILL") } catch {} }, 3000).unref()
  }
}

async function stopServe() {
  if (!serveProc || serveProc.killed) return
  try { serveProc.kill("SIGTERM") } catch {}
  await new Promise(r => {
    const t = setTimeout(() => { try { serveProc.kill("SIGKILL") } catch {}; r() }, 4000)
    serveProc.once("exit", () => { clearTimeout(t); r() })
  })
}

async function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  log("Завершаю работу супервизора...")
  stopBot()
  await stopServe()
  process.exit(code)
}

process.on("SIGINT", () => shutdown(0))
process.on("SIGTERM", () => shutdown(0))

try {
  await killStaleBots().catch(e => logErr("Не удалось проверить старые процессы бота:", e.message))
  await startServe()
  startBot()
} catch (err) {
  logErr("Не удалось запустить:", err.message)
  shutdown(1)
}
