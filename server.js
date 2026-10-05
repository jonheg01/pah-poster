// pah-poster: HTTP API the marketing sweep calls to post the manual-lane drafts, plus a noVNC window for Jon's
// one-time login per platform. Auth: x-internal-token header (POSTER_TOKEN) on the API; HTTP basic auth
// (POSTER_VNC_USER / POSTER_VNC_PASSWORD) on /vnc and /open. Never stores credentials; sessions live in the
// persistent Chromium profiles under /data/profiles.
const express = require("express");
const path = require("path");
const fs = require("fs");
const { createProxyMiddleware } = require("http-proxy-middleware");
const { withPage, shot, openForLogin, SHOTS } = require("./browser");
const P = require("./platforms");

const app = express();
app.use(express.json({ limit: "2mb" }));
const TOKEN = process.env.POSTER_TOKEN || "";
const VNC_USER = process.env.POSTER_VNC_USER || "jon";
const VNC_PASS = process.env.POSTER_VNC_PASSWORD || "";
let busy = false;

function apiAuth(req, res, next) { if (!TOKEN || req.get("x-internal-token") !== TOKEN) return res.status(401).json({ error: "unauthorized" }); next(); }
function basicAuth(req, res, next) {
  const h = req.get("authorization") || "";
  const [u, p] = Buffer.from(h.replace(/^Basic\s+/i, ""), "base64").toString().split(":");
  const cookieOk = (req.get("cookie") || "").includes("poster_session=" + sessionCookie());
  if (!cookieOk && (!VNC_PASS || u !== VNC_USER || p !== VNC_PASS)) { res.set("WWW-Authenticate", 'Basic realm="poster"'); return res.status(401).send("login required"); }
  res.cookie ? res.cookie("poster_session", sessionCookie(), { httpOnly: true, sameSite: "lax", secure: true }) : res.set("Set-Cookie", `poster_session=${sessionCookie()}; HttpOnly; SameSite=Lax; Secure; Path=/`);
  next();
}
function sessionCookie() { return require("crypto").createHash("sha256").update("poster:" + VNC_USER + ":" + VNC_PASS).digest("hex").slice(0, 32); }
function splitDraft(body) {
  const lines = String(body || "").replace(/\r/g, "").split("\n");
  const title = (lines.shift() || "").trim();
  const paragraphs = lines.join("\n").split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  return { title, paragraphs };
}

app.get("/health", (_req, res) => res.json({ ok: true, platforms: Object.keys(P), busy }));

// Login state per platform (opens each profile briefly).
app.get("/status", apiAuth, async (req, res) => {
  const out = {};
  const only = req.query.platform ? [String(req.query.platform)] : Object.keys(P);
  for (const k of only) {
    if (!P[k]) { out[k] = { error: "unknown" }; continue; }
    try {
      out[k] = await withPage(k, async (page) => {
        const logged_in = await P[k].isLoggedIn(page);
        if (!req.query.debug) return { logged_in };
        const text = await page.evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 400)).catch(() => "");
        return { logged_in, url: page.url(), title: await page.title().catch(() => ""), text };
      });
    } catch (e) { out[k] = { error: String(e).slice(0, 200) }; }
  }
  res.json(out);
});

// Post one draft. Body: { platform, body (title on first line), source_url, tags, image_url, email }
app.post("/post", apiAuth, async (req, res) => {
  const { platform } = req.body || {};
  const impl = P[platform];
  if (!impl) return res.status(400).json({ error: "unknown platform" });
  if (busy) return res.status(429).json({ error: "busy, retry later" });
  busy = true;
  // Long-form drafts carry the title on line one. Short drafts (reddit, quora, biggerpockets) come with an explicit
  // title from the sweep and the whole body is content.
  const full = String(req.body.body || "");
  const { title, paragraphs } = req.body.title ? { title: req.body.title, paragraphs: full.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean) } : splitDraft(full);
  const draft = { ...req.body, title, paragraphs, body: full };
  try {
    const result = await withPage(platform, async (page) => {
      if (!(await impl.isLoggedIn(page))) return { ok: false, needs_login: true, login_url: impl.loginUrl };
      try { const r = await impl.post(page, draft); return { ok: true, ...r }; }
      catch (e) { const s = await shot(page, platform); return { ok: false, error: String(e).slice(0, 400), screenshot: s, page_url: page.url() }; }
    });
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: String(e).slice(0, 400) }); }
  finally { busy = false; }
});

// One-time login: opens the platform's sign-in page in the headful browser; Jon completes it in the /vnc window.
app.get("/open/:platform", basicAuth, async (req, res) => {
  const impl = P[req.params.platform];
  if (!impl) return res.status(404).send("unknown platform");
  // Optional ?url= : a sign-in link from an email (Medium, Substack) opened in that platform's browser profile.
  let url = impl.loginUrl;
  if (req.query.url) {
    try { const u = new URL(String(req.query.url)); if (u.protocol !== "https:") throw new Error("https only"); url = u.toString(); }
    catch (e) { return res.status(400).send("bad url: " + e.message); }
  }
  await openForLogin(req.params.platform, url);
  res.redirect("/vnc/vnc.html?autoconnect=1&resize=scale&path=vnc/websockify");
});

// Screenshot of whatever that platform's browser is showing right now (for diagnosing a stuck login).
app.get("/peek/:platform", basicAuth, async (req, res) => {
  const impl = P[req.params.platform];
  if (!impl) return res.status(404).send("unknown platform");
  try {
    const { getContext } = require("./browser");
    const ctx = await getContext(req.params.platform);
    const pages = ctx.pages().filter((p) => !/^about:blank/.test(p.url()));
    const page = pages[pages.length - 1];
    if (!page) return res.status(404).send("no open page");
    const png = await page.screenshot({ fullPage: false });
    res.set("x-page-url", page.url()).type("png").send(png);
  } catch (e) { res.status(500).send(String(e)); }
});

// Login hub: one link per platform.
app.get("/login", basicAuth, (_req, res) => {
  const rows = Object.keys(P).map((k) => `<li style="margin:10px 0"><a href="/open/${k}"><b>${k}</b></a> <form method="get" action="/open/${k}" style="display:inline;margin-left:12px"><input name="url" placeholder="or paste a sign-in link from your email" size="38"> <button>Open link</button></form></li>`).join("");
  res.send(`<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:system-ui;padding:24px;max-width:760px"><h1>Poster logins</h1><p>Click a platform name. A browser window opens in the next screen; sign in there like you normally would. The session is kept, so this is a one-time step per platform (until the site logs you out).</p><p><b>Medium and Substack sign in by emailed link.</b> Request the link from your normal browser, then paste the link from the email into that platform's box here and click Open link; it opens inside the poster browser and signs it in.</p><ul style="list-style:none;padding:0">${rows}</ul><p><a href="/vnc/vnc.html?autoconnect=1&resize=scale&path=vnc/websockify">Open the browser screen</a></p></body>`);
});

// Screenshots of failures, for debugging from the sweep report.
app.get("/shots/:name", apiAuth, (req, res) => { const f = path.join(SHOTS, path.basename(req.params.name)); if (!fs.existsSync(f)) return res.status(404).end(); res.sendFile(f); });

// noVNC (static + websocket) behind basic auth.
const vncProxy = createProxyMiddleware({ target: "http://127.0.0.1:6080", changeOrigin: true, ws: true, pathRewrite: (p) => p.replace(/^\/vnc(?=\/|$)/, "") || "/" });
app.use("/vnc", basicAuth, vncProxy);

const port = Number(process.env.PORT || 3000);
const server = app.listen(port, () => console.log("pah-poster listening on", port));
server.on("upgrade", (req, socket, head) => {
  // websocket upgrade for noVNC; basic auth is carried by the browser on the same origin after the first prompt
  const h = req.headers["authorization"] || "";
  const [u, p] = Buffer.from(h.replace(/^Basic\s+/i, ""), "base64").toString().split(":");
  const cookieOk = (req.headers["cookie"] || "").includes("poster_session=" + sessionCookie());
  if (!cookieOk && (!VNC_PASS || u !== VNC_USER || p !== VNC_PASS)) { socket.destroy(); return; }
  if (req.url.startsWith("/vnc")) vncProxy.upgrade(req, socket, head);
});
