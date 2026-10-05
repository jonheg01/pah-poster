// One persistent Chromium profile per platform. Headful on the Xvfb display so the noVNC window shows the real
// browser for the one-time login; the same profile (cookies, local storage) is then reused by the posting scripts.
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const ROOT = process.env.PROFILE_ROOT || "/data/profiles";
const SHOTS = "/data/shots";
const contexts = new Map();

async function getContext(platform) {
  if (contexts.has(platform)) {
    const c = contexts.get(platform);
    try { c.pages(); return c; } catch { contexts.delete(platform); }
  }
  const dir = path.join(ROOT, platform);
  fs.mkdirSync(dir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    viewport: { width: 1280, height: 820 },
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--window-size=1280,820"],
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    locale: "en-US",
    timezoneId: "America/Phoenix",
  });
  ctx.on("close", () => contexts.delete(platform));
  contexts.set(platform, ctx);
  return ctx;
}

async function withPage(platform, fn) {
  const ctx = await getContext(platform);
  const page = await ctx.newPage();
  try { return await fn(page, ctx); } finally { try { await page.close(); } catch {} }
}

async function shot(page, name) {
  try {
    fs.mkdirSync(SHOTS, { recursive: true });
    const file = path.join(SHOTS, `${name}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return path.basename(file);
  } catch { return null; }
}

// Bring a window to the front for the login session (noVNC shows the whole display).
async function openForLogin(platform, url) {
  const ctx = await getContext(platform);
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
  await page.bringToFront();
  return true;
}

async function closeAll() { for (const c of contexts.values()) { try { await c.close(); } catch {} } contexts.clear(); }

module.exports = { getContext, withPage, shot, openForLogin, closeAll, SHOTS };
