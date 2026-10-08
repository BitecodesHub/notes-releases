// End-to-end smoke test for an INSTALLED Notes build (any OS).
//
//   node scripts/smoke-test.mjs <path-to-Notes-executable> <expected-version> [--pair] [--screenshot]
//
// Launches the app with a throwaway profile and debugging ports, then checks
// it the way a new user meets it: starts, stays up, shows the centred sign-in
// gate, refuses AI use while signed out, reaches the live Bitecodes update
// feed, can start a real sign-in (--pair), can take a screenshot
// (--screenshot), and quits cleanly. Exit code 0 only if every check passed.
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const [exe, expected, ...flags] = process.argv.slice(2)
if (!exe || !expected) {
  console.error("usage: smoke-test.mjs <exe> <version> [--pair] [--screenshot]")
  process.exit(2)
}
const MAIN = 39229
const REND = 39222
const profile = mkdtempSync(join(tmpdir(), "notes-smoke-"))
const results = []
const check = (name, ok, detail = "") => {
  results.push({ name, ok })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// On macOS, never touch the real login keychain from a test run (an existing
// "Notes Safe Storage" item from another build would raise a password prompt).
const extra = process.platform === "darwin" ? ["--use-mock-keychain"] : []
const child = spawn(exe, [`--user-data-dir=${profile}`, `--inspect=127.0.0.1:${MAIN}`, `--remote-debugging-port=${REND}`, ...extra], {
  stdio: ["ignore", "pipe", "pipe"],
})
let output = ""
child.stdout.on("data", (d) => (output += d))
child.stderr.on("data", (d) => (output += d))
let exited = null
child.on("exit", (code, signal) => (exited = { code, signal }))

async function targets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`)
  return r.json()
}
async function evaluate(port, expr, pick = (t) => t[0]) {
  const t = pick(await targets(port))
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((r, j) => {
    ws.onopen = r
    ws.onerror = j
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP timeout")), 60_000)
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data)
      if (d.id !== 1) return
      clearTimeout(timer)
      ws.close()
      if (d.result?.exceptionDetails) reject(new Error(d.result.exceptionDetails.exception?.description ?? "exception"))
      else resolve(d.result?.result?.value)
    }
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }))
  })
}
const main = (expr) => evaluate(MAIN, expr)
const page = (js) =>
  main(`process.mainModule.require("electron").BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(${JSON.stringify(js)})`)

try {
  // 1. Starts and exposes its main process.
  let up = false
  for (let i = 0; i < 90 && !exited; i++) {
    try {
      await targets(MAIN)
      up = true
      break
    } catch {
      await sleep(1000)
    }
  }
  check("app starts", up && !exited, exited ? `exited ${JSON.stringify(exited)}` : "")
  if (!up) throw new Error("app did not start")
  // Wait for the first real paint (up to 60s: Rosetta's first-run translation
  // and cold Windows Defender scans make the first launch slow).
  for (let i = 0; i < 60; i++) {
    const ready = await main(`(() => {
      const w = process.mainModule.require("electron").BrowserWindow.getAllWindows()[0]
      return !!w && w.isVisible()
    })()`).catch(() => false)
    const painted = ready && (await page("document.body.innerText").catch(() => "")).includes("Sign in to Notes")
    if (painted) break
    await sleep(1000)
  }
  await sleep(1500) // let the content-sized window settle

  check("version", (await main(`process.mainModule.require("electron").app.getVersion()`)) === expected, expected)

  const win = await main(`(() => {
    const { BrowserWindow, screen } = process.mainModule.require("electron")
    const w = BrowserWindow.getAllWindows()[0]
    if (!w) return null
    const b = w.getBounds(), a = screen.getDisplayMatching(b).workArea
    return { visible: w.isVisible(), crashed: w.webContents.isCrashed(), url: w.webContents.getURL(),
      dx: (b.x + b.width / 2) - (a.x + a.width / 2), dy: (b.y + b.height / 2) - (a.y + a.height / 2) }
  })()`)
  check("window shown, renderer alive", !!win && win.visible && !win.crashed && /index\.html/.test(win.url), JSON.stringify(win))
  check("sign-in card centred", !!win && Math.abs(win.dx) <= 2 && Math.abs(win.dy) <= 2, win ? `offset ${win.dx},${win.dy}` : "")

  const text = await page("document.body.innerText")
  check("sign-in gate shown", /Sign in to Notes/.test(text) && /Sign in with Bitecodes/.test(text))
  check("Bitecodes logo rendered", (await page(`!!document.querySelector('svg[aria-label="Bitecodes logo"]')`)) === true)

  const status = await page("window.electronAPI.bitecodesStatus().then((s) => s.phase)")
  check("starts signed out", status === "signed-out", status)

  const chat = await page(`new Promise((res) => window.electronAPI.chatStream("hi", { onDone: () => res("ANSWERED"), onError: (e) => res(String(e)) }))`)
  check("AI refused while signed out", /Sign in with Bitecodes/.test(chat), chat)

  const update = await page("window.electronAPI.updateCheck()")
  check("live update feed reachable", !!update && update.checkedAt !== null && update.updateRequired === false, JSON.stringify({ latest: update?.latestVersion, available: update?.updateAvailable }))

  if (flags.includes("--pair")) {
    const pair = await page("window.electronAPI.bitecodesLogin()")
    check("live sign-in starts (code issued)", pair?.phase === "waiting" && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(pair.userCode ?? ""), pair?.phase)
    await page("window.electronAPI.bitecodesCancel()")
  }

  if (flags.includes("--screenshot")) {
    const shot = await page(`window.electronAPI.takeScreenshot().then(() => new Promise((r) => setTimeout(r, 2500))).then(() => window.electronAPI.getScreenshots()).then((s) => s.length).catch((e) => "ERR " + e)`)
    check("screenshot captured", typeof shot === "number" && shot >= 1, String(shot))
  }

  await sleep(10_000)
  const alive = await main(`(() => { const w = process.mainModule.require("electron").BrowserWindow.getAllWindows()[0]; return !!w && !w.webContents.isCrashed() })()`)
  check("still running after 30s, no crash", alive === true && !exited)

  // Quit the way a user does; the process must exit by itself.
  await main(`setTimeout(() => process.mainModule.require("electron").app.quit(), 100); true`).catch(() => {})
  for (let i = 0; i < 30 && !exited; i++) await sleep(500)
  check("quits cleanly", !!exited && (exited.code === 0 || exited.code === null), JSON.stringify(exited))
} catch (error) {
  check("smoke test ran", false, String(error?.message ?? error))
} finally {
  if (!exited) {
    child.kill("SIGKILL")
    await sleep(500)
  }
  const fatal = output.split("\n").filter((l) => /uncaught|fatal|cannot find module|render-process-gone|crash/i.test(l))
  check("no fatal errors in app output", fatal.length === 0, fatal.slice(0, 3).join(" | "))
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {}
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
}
