// A stand-in Bitecodes server for end-to-end tests of an INSTALLED Notes build.
// Implements the desktop API the app uses (sign-in, account, assistant SSE,
// transcription, sign-out, update feed) and records every request so a test
// can assert what the app actually sent. Never used in production.
import http from "node:http"

export function startMockBitecodes(port, { version = "0.0.0" } = {}) {
  const log = []
  let revoked = false
  const TOKEN = "bcd_mock_token_for_tests"
  const origin = `http://127.0.0.1:${port}`

  const json = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" })
    res.end(JSON.stringify(body))
  }
  const authed = (req) => req.headers.authorization === `Bearer ${TOKEN}` && !revoked

  const server = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (d) => (raw += d))
    req.on("end", () => {
      const url = new URL(req.url, origin)
      let body = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {}
      log.push({
        method: req.method,
        path: url.pathname,
        client: req.headers["x-notes-client"] ?? null,
        kind: body.kind ?? null,
        images: Array.isArray(body.images) ? body.images.length : 0,
        mimeType: body.mimeType ?? null,
        audioBytes: typeof body.audio === "string" ? Buffer.from(body.audio, "base64").length : 0,
        prompt: typeof body.prompt === "string" ? body.prompt.slice(0, 200) : null,
      })
      const p = url.pathname
      if (p === "/api/v1/desktop/pair" && req.method === "POST") {
        revoked = false
        return json(res, 200, {
          ok: true,
          deviceCode: "dvc_mock",
          userCode: "MQCK-2345",
          verificationUrl: `${origin}/app/desktop`,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          interval: 1,
        })
      }
      if (p === "/api/v1/desktop/pair/poll") return json(res, 200, { ok: true, status: "approved", token: TOKEN })
      if (p === "/api/v1/desktop/me") {
        return authed(req)
          ? json(res, 200, { ok: true, user: { name: "QA", email: "qa@example.test" }, device: { label: "Notes" }, assistant: { available: true } })
          : json(res, 401, { ok: false, code: "UNAUTHORIZED" })
      }
      if (p === "/api/v1/desktop/logout") {
        revoked = true
        return json(res, 200, { ok: true })
      }
      if (p === "/api/v1/desktop/version") {
        return json(res, 200, { ok: true, latestVersion: version, minimumVersion: null, notes: null, updateAvailable: false, updateRequired: false, downloadUrl: null })
      }
      if (p === "/api/v1/desktop/transcribe") {
        if (!authed(req)) return json(res, 401, { ok: false, code: "UNAUTHORIZED", message: "Sign in to Bitecodes again." })
        return json(res, 200, { ok: true, text: "hello from the mock transcriber" })
      }
      if (p === "/api/v1/desktop/assistant") {
        if (!authed(req)) return json(res, 401, { ok: false, code: "UNAUTHORIZED", message: "Sign in to Bitecodes again." })
        const n = Array.isArray(body.images) ? body.images.length : 0
        const answer = n
          ? `MOCK-ANSWER: I can see ${n} screenshot(s). def solve(): return 42`
          : `MOCK-ANSWER: chat works. Transcript summary ok.`
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" })
        const parts = answer.match(/.{1,12}/g)
        let i = 0
        const tick = () => {
          if (i < parts.length) {
            res.write(`event: token\ndata: ${JSON.stringify({ delta: parts[i++] })}\n\n`)
            setTimeout(tick, 15)
          } else {
            res.write(`event: done\ndata: ${JSON.stringify({ usage: { promptTokens: 10, completionTokens: 10 } })}\n\n`)
            res.end()
          }
        }
        return tick()
      }
      json(res, 404, { ok: false, code: "NOT_FOUND" })
    })
  })
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () => resolve({ origin, log, close: () => server.close() }))
  )
}
