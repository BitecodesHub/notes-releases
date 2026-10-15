// Full-feature end-to-end test of an INSTALLED Notes build, signed in.
//
//   node scripts/feature-test.mjs <path-to-Notes-executable> <expected-version>
//
// Runs a stand-in Bitecodes server on 127.0.0.1 and points the installed app at
// it, then uses every feature the way a person does: browser sign-in flow,
// streamed chat, screenshot capture + screenshot analysis, voice recording
// transcription, global shortcuts, window movement / hide / show, content
// protection, settings round-trip, update check, sign-out. It asserts both what
// the app shows and what it actually sent to the server. Exit 0 only if every
// check passed.
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const { startMockBitecodes } = await import(pathToFileURL(join(here, "mock-bitecodes.mjs")).href)

const [exe, expected] = process.argv.slice(2)
if (!exe || !expected) {
  console.error("usage: feature-test.mjs <exe> <version>")
  process.exit(2)
}
const MAIN = 39239
const MOCK_PORT = 47123
const profile = mkdtempSync(join(tmpdir(), "notes-features-"))
const results = []
const check = (name, ok, detail = "") => {
  results.push({ name, ok })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 20_000, step = 500) => {
  const end = Date.now() + ms
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch {}
    if (Date.now() > end) return null
    await sleep(step)
  }
}

const mock = await startMockBitecodes(MOCK_PORT, { version: expected })
const extra = process.platform === "darwin" ? ["--use-mock-keychain"] : []
const child = spawn(exe, [`--user-data-dir=${profile}`, `--inspect=127.0.0.1:${MAIN}`, ...extra], { stdio: ["ignore", "pipe", "pipe"] })
let output = ""
child.stdout.on("data", (d) => (output += d))
child.stderr.on("data", (d) => (output += d))
let exited = null
child.on("exit", (code, signal) => (exited = { code, signal }))

async function evaluate(expr) {
  const t = (await (await fetch(`http://127.0.0.1:${MAIN}/json/list`)).json())[0]
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP timeout")), 120_000)
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
const main = (expr) => evaluate(expr)
const win = (expr) => main(`(() => { const w = process.mainModule.require("electron").BrowserWindow.getAllWindows()[0]; return (${expr}) })()`)
const page = (js) =>
  main(`process.mainModule.require("electron").BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(${JSON.stringify(js)})`)
const sent = (path) => mock.log.filter((r) => r.path === path)

// A 1-second 16 kHz mono WAV (a tone) — content does not matter to the mock.
function wavBase64() {
  const rate = 16000, n = rate, buf = Buffer.alloc(44 + n * 2)
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8)
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2)
  return buf.toString("base64")
}

try {
  const up = await until(async () => (await fetch(`http://127.0.0.1:${MAIN}/json/list`)).ok, 90_000, 1000)
  check("app starts", !!up && !exited)
  if (!up) throw new Error("app did not start")
  await until(async () => (await page("document.body.innerText")).includes("Sign in to Notes"), 60_000, 1000)
  check("version", (await main(`process.mainModule.require("electron").app.getVersion()`)) === expected, expected)

  // --- Settings round-trip + point the app at the stand-in server ----------
  await page(`window.electronAPI.setSettings({ ai: { providers: { bitecodes: { endpoint: "${mock.origin}" } } } })`)
  const ep = await page(`window.electronAPI.getSettings().then((s) => s.ai.providers.bitecodes.endpoint)`)
  check("settings save and read back", ep === mock.origin, ep)

  // --- Sign in through the real flow ----------------------------------------
  const login = await page("window.electronAPI.bitecodesLogin()")
  check("sign-in starts (code shown)", login?.phase === "waiting" && !!login.userCode, login?.userCode)
  const signedIn = await until(async () => (await page("window.electronAPI.bitecodesStatus().then((s) => s.phase)")) === "signed-in", 30_000, 1000)
  check("signs in after approval", !!signedIn)
  const gateGone = await until(async () => !(await page("document.body.innerText")).includes("Sign in to Notes"), 15_000)
  check("app unlocks after sign-in", !!gateGone)

  // --- Chat ------------------------------------------------------------------
  const chat = await page(`new Promise((res) => { let o = ""; window.electronAPI.chatStream("Say hi", { onToken: (t) => (o += t), onDone: () => res(o), onError: (e) => res("ERROR " + e) }) })`)
  check("chat streams an answer", /MOCK-ANSWER: chat works/.test(chat ?? ""), String(chat).slice(0, 80))
  const chatReq = sent("/api/v1/desktop/assistant").at(-1)
  check("chat request: kind + app build sent", chatReq?.kind === "chat" && new RegExp(`Notes/${expected.replace(/\./g, "\\.")}`).test(chatReq?.client ?? ""), JSON.stringify({ kind: chatReq?.kind, client: chatReq?.client }))

  // --- Screenshot capture + analysis -----------------------------------------
  const shots = await page(`window.electronAPI.takeScreenshot().then(() => new Promise((r) => setTimeout(r, 2500))).then(() => window.electronAPI.getScreenshots()).then((s) => s.length)`)
  check("screenshot captured", typeof shots === "number" && shots >= 1, String(shots))
  const analysis = await page(`new Promise((res) => {
    let last = ""; const off = window.electronAPI.onScreenshotAnalysisStream((d) => { last = JSON.stringify(d); if (last.includes("def solve")) { off(); res(last) } })
    window.electronAPI.processScreenshotWithChoice("answer").catch((e) => res("ERROR " + e))
    setTimeout(() => res(last || "TIMEOUT"), 90000)
  })`)
  check("screenshot analysis streams the answer", /MOCK-ANSWER: I can see 1 screenshot/.test(analysis ?? ""), String(analysis).slice(0, 100))
  const shotReq = sent("/api/v1/desktop/assistant").find((r) => r.images > 0)
  check("screenshot sent as an image", !!shotReq && shotReq.kind === "screenshot", JSON.stringify({ kind: shotReq?.kind, images: shotReq?.images }))

  // --- Voice ------------------------------------------------------------------
  const voice = await page(`window.electronAPI.analyzeAudioFromBase64("${wavBase64()}", "audio/wav").then((r) => r.text).catch((e) => "ERROR " + e)`)
  check("voice recording transcribed", /hello from the mock transcriber/.test(voice ?? ""), String(voice).slice(0, 90))
  const voiceReq = sent("/api/v1/desktop/transcribe").at(-1)
  check("voice sent to Bitecodes", voiceReq?.mimeType === "audio/wav" && voiceReq.audioBytes > 30000, JSON.stringify(voiceReq ?? {}))

  // --- Global shortcuts ---------------------------------------------------------
  const sc = await page("window.electronAPI.getShortcuts()")
  const states = Object.entries(sc?.status ?? {})
  const bad = states.filter(([, s]) => s === "os-conflict" || s === "duplicate")
  check("global shortcuts registered", states.length > 0 && bad.length === 0, bad.length ? JSON.stringify(bad) : `${states.filter(([, s]) => s === "active").length} active`)

  // --- Window controls ------------------------------------------------------------
  const x0 = await win("w.getBounds().x")
  await page("window.electronAPI.moveWindowRight()")
  await sleep(500)
  const x1 = await win("w.getBounds().x")
  check("move window shortcut moves it", typeof x0 === "number" && x1 > x0, `${x0} → ${x1}`)
  await main(`(() => { const r = process.mainModule.require; const m = r(r("path").join(r("electron").app.getAppPath(), "dist-electron", "main.js")); m.AppState.getInstance().toggleMainWindow(); return true })()`)
  const hidden = await until(async () => (await win("w.isVisible()")) === false, 5000, 250)
  await main(`(() => { const r = process.mainModule.require; const m = r(r("path").join(r("electron").app.getAppPath(), "dist-electron", "main.js")); m.AppState.getInstance().toggleMainWindow(); return true })()`)
  const shown = await until(async () => (await win("w.isVisible()")) === true, 5000, 250)
  check("hide / show window", !!hidden && !!shown)
  const prot = await page("window.electronAPI.getSettings().then((s) => s.window.contentProtection)")
  check("content protection setting on", prot === true, String(prot))

  // --- Update check -----------------------------------------------------------------
  const upd = await page("window.electronAPI.updateCheck()")
  check("update check runs", upd?.checkedAt != null && upd.updateRequired === false, JSON.stringify({ latest: upd?.latestVersion }))

  // --- Sign out ------------------------------------------------------------------
  await page("window.electronAPI.bitecodesLogout()")
  await sleep(1000)
  const after = await page(`new Promise((res) => window.electronAPI.chatStream("hi", { onDone: () => res("ANSWERED"), onError: (e) => res(String(e)) }))`)
  check("sign out locks AI again", /Sign in with Bitecodes/.test(after ?? ""), String(after).slice(0, 60))
  check("sign out revokes on the server", sent("/api/v1/desktop/logout").length >= 1)

  const alive = await win("!!w && !w.webContents.isCrashed()")
  check("no crash during the run", alive === true && !exited)
  await main(`setTimeout(() => process.mainModule.require("electron").app.quit(), 100); true`).catch(() => {})
  await until(async () => !!exited, 15_000, 500)
  check("quits cleanly", !!exited && (exited.code === 0 || exited.code === null), JSON.stringify(exited))
} catch (error) {
  check("feature test ran", false, String(error?.message ?? error))
} finally {
  if (!exited) {
    child.kill("SIGKILL")
    await sleep(500)
  }
  mock.close()
  const fatal = output.split("\n").filter((l) => /uncaught|fatal|cannot find module|render-process-gone/i.test(l))
  check("no fatal errors in app output", fatal.length === 0, fatal.slice(0, 3).join(" | "))
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {}
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} feature checks passed`)
  process.exit(failed ? 1 : 0)
}
