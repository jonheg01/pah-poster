// Platform scripts. Each exports { home, loginUrl, isLoggedIn(page), post(page, draft) }.
// draft = { title, paragraphs[], body, source_url, tags[], image_url, email (substack: send email to subscribers?) }
// Scripts are deliberately defensive: wait for the editor, type with the keyboard (works in every rich editor),
// then find the publish control by role/text. Any failure throws; the server screenshots and reports it.
const { shot } = require("./browser");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function typeParagraphs(page, paragraphs, { enterTwice = false } = {}) {
  for (let i = 0; i < paragraphs.length; i++) {
    await page.keyboard.type(paragraphs[i], { delay: 2 });
    if (i < paragraphs.length - 1) { await page.keyboard.press("Enter"); if (enterTwice) await page.keyboard.press("Enter"); }
  }
}
async function clickFirst(page, candidates, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const c of candidates) {
      const loc = typeof c === "string" ? page.locator(c) : c(page);
      try { if (await loc.first().isVisible({ timeout: 300 })) { await loc.first().click(); return c; } } catch {}
    }
    await sleep(400);
  }
  throw new Error("none of the expected controls appeared: " + candidates.map((c) => (typeof c === "string" ? c : "fn")).join(" | "));
}
const signoff = (d) => `\n\nJon Hegreness, REALTOR and Associate Broker, Howe Realty. (623) 826-0888. ${d.source_url || "https://www.previewarizonahomes.com"}`;

// ---------- Medium: import the PAH post (keeps the canonical link), then publish with tags ----------
const medium = {
  home: "https://medium.com/me/stories/drafts",
  loginUrl: "https://medium.com/m/signin",
  async isLoggedIn(page) { await page.goto("https://medium.com/me/settings", { waitUntil: "networkidle", timeout: 45000 }).catch(() => null); await sleep(2000); const t = await page.evaluate(() => document.body?.innerText || ""); return /medium\.com\/me\//.test(page.url()) && !/Sign in with email|Welcome back|Create one/.test(t); },
  async post(page, d) {
    if (!d.source_url) throw new Error("medium needs source_url (the PAH post) for import");
    await page.goto("https://medium.com/p/import", { waitUntil: "domcontentloaded" });
    await sleep(2000);
    const input = page.locator('input[type="url"], input[placeholder*="http"], input[name="url"]').first();
    await input.waitFor({ timeout: 20000 });
    await input.fill(d.source_url);
    await clickFirst(page, ['button:has-text("Import")']);
    await page.waitForURL(/medium\.com\/p\/[a-z0-9]+\/edit/, { timeout: 60000 });
    await sleep(3000);
    await clickFirst(page, ['button:has-text("Publish")', '[data-action="show-prepublish"]'], 30000);
    await sleep(2500);
    const tagBox = page.locator('[data-testid="publishTopicsInput"], input[placeholder*="topic"], input[placeholder*="Add a topic"]').first();
    if (await tagBox.count()) { for (const t of (d.tags || []).slice(0, 5)) { await tagBox.click(); await page.keyboard.type(t); await page.keyboard.press("Enter"); await sleep(400); } }
    await clickFirst(page, ['button:has-text("Publish now")', '[data-testid="publishConfirmButton"]', 'button:has-text("Publish")'], 20000);
    await sleep(5000);
    const url = page.url().replace(/\?.*$/, "");
    if (!/medium\.com\/@|medium\.com\/p\//.test(url) && !(await page.locator('text=/published|Your story is live/i').count())) throw new Error("publish not confirmed at " + url);
    return { url };
  },
};

// ---------- Substack: new post in the publication editor ----------
const substack = {
  home: "https://substack.com/home",
  loginUrl: "https://substack.com/sign-in",
  async isLoggedIn(page) { await page.goto("https://substack.com/settings", { waitUntil: "domcontentloaded" }); await sleep(3000); return /substack\.com\/settings/.test(page.url()) && !(await page.locator('input[type="email"]').count()); },
  async post(page, d) {
    const pub = process.env.SUBSTACK_PUBLICATION; // e.g. jonhegreness.substack.com (without https)
    if (!pub) throw new Error("SUBSTACK_PUBLICATION env not set");
    await page.goto(`https://${pub}/publish/post?type=newsletter`, { waitUntil: "domcontentloaded" });
    await sleep(4000);
    const title = page.locator('textarea[placeholder*="Title"], [data-testid="post-title"], input[placeholder*="Title"]').first();
    await title.waitFor({ timeout: 30000 });
    await title.fill(d.title);
    const sub = page.locator('textarea[placeholder*="subtitle"], [placeholder*="Subtitle"]').first();
    if (await sub.count()) await sub.fill((d.paragraphs[0] || "").slice(0, 140));
    const body = page.locator('.ProseMirror, [contenteditable="true"]').last();
    await body.click();
    await typeParagraphs(page, d.paragraphs.concat([signoff(d).trim()]));
    await sleep(1000);
    await clickFirst(page, ['button:has-text("Continue")', 'button:has-text("Publish")'], 20000);
    await sleep(2500);
    // Web only by default: turn off email delivery when the toggle exists, unless d.email is true.
    if (!d.email) {
      const emailToggle = page.locator('label:has-text("Send via email") input, label:has-text("email") input[type="checkbox"]').first();
      if (await emailToggle.count() && await emailToggle.isChecked().catch(() => false)) await emailToggle.click();
    }
    await clickFirst(page, ['button:has-text("Send to everyone now")', 'button:has-text("Publish now")', 'button:has-text("Publish")'], 20000);
    await sleep(6000);
    const link = await page.locator('a[href*="' + pub + '/p/"]').first().getAttribute("href").catch(() => null);
    return { url: link || page.url() };
  },
};

// ---------- LinkedIn: personal post from the feed composer ----------
const linkedin = {
  home: "https://www.linkedin.com/feed/",
  loginUrl: "https://www.linkedin.com/login",
  async isLoggedIn(page) { await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" }); await sleep(3500); return /linkedin\.com\/feed/.test(page.url()) && !(await page.locator('input#session_key, input[name="session_key"]').count()); },
  async post(page, d) {
    await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
    await sleep(3000);
    await clickFirst(page, ['button:has-text("Start a post")', '[aria-label*="Start a post"]'], 20000);
    const box = page.locator('.ql-editor[contenteditable="true"], div[role="textbox"][contenteditable="true"]').first();
    await box.waitFor({ timeout: 20000 });
    await box.click();
    await typeParagraphs(page, [d.body.trim(), `${d.source_url || "https://www.previewarizonahomes.com"}`]);
    await sleep(2500);
    await clickFirst(page, ['button.share-actions__primary-action', 'button:has-text("Post")'], 20000);
    await sleep(5000);
    return { url: "https://www.linkedin.com/in/me/recent-activity/all/" };
  },
};

// ---------- ActiveRain: blog post ----------
const activerain = {
  home: "https://activerain.com/",
  loginUrl: "https://activerain.com/login",
  async isLoggedIn(page) { await page.goto("https://activerain.com/blogs/new", { waitUntil: "domcontentloaded" }); await sleep(3000); const t = await page.evaluate(() => document.body?.innerText || ""); return /activerain\.com\/blogs\/new/.test(page.url()) && !/\bLog In\b/.test(t) && !(await page.locator('input[type="password"]').count()); },
  async post(page, d) {
    await page.goto("https://activerain.com/blogs/new", { waitUntil: "domcontentloaded" });
    await sleep(3000);
    const title = page.locator('input[name*="title"], #blog_title, input[placeholder*="Title"]').first();
    await title.waitFor({ timeout: 30000 });
    await title.fill(d.title);
    const frame = page.frameLocator('iframe[id*="ifr"], iframe.cke_wysiwyg_frame, iframe[title*="Rich Text"]').first();
    const editor = frame.locator("body");
    if (await editor.count().catch(() => 0)) { await editor.click(); await typeParagraphs(page, d.paragraphs.concat([signoff(d).trim()]), { enterTwice: false }); }
    else { const ce = page.locator('[contenteditable="true"], textarea[name*="body"], textarea[name*="content"]').first(); await ce.click(); await typeParagraphs(page, d.paragraphs.concat([signoff(d).trim()])); }
    await sleep(1000);
    await clickFirst(page, ['button:has-text("Publish")', 'input[type="submit"][value*="Publish"]', 'a:has-text("Publish")'], 20000);
    await sleep(5000);
    return { url: page.url() };
  },
};

// ---------- BiggerPockets: forum post in a chosen forum ----------
const biggerpockets = {
  home: "https://www.biggerpockets.com/forums",
  loginUrl: "https://www.biggerpockets.com/login",
  async isLoggedIn(page) { await page.goto("https://www.biggerpockets.com/forums", { waitUntil: "domcontentloaded" }); await sleep(3000); const t = await page.evaluate(() => document.body?.innerText || ""); return !/login|signup/.test(page.url()) && !/\bLog in\b/.test(t) && !/\bJoin free\b/.test(t); },
  async post(page, d) {
    const forum = process.env.BP_FORUM_URL || "https://www.biggerpockets.com/forums/88"; // default: a general discussion forum; set BP_FORUM_URL to the right one
    await page.goto(forum, { waitUntil: "domcontentloaded" });
    await sleep(3000);
    await clickFirst(page, ['a:has-text("New Post")', 'a:has-text("Start a discussion")', 'button:has-text("New Post")', 'a[href*="/forums/"][href*="/new"]'], 20000);
    const title = page.locator('input[name*="title"], input[placeholder*="Title"]').first();
    await title.waitFor({ timeout: 30000 });
    await title.fill(d.title);
    const body = page.locator('[contenteditable="true"], textarea[name*="body"]').first();
    await body.click();
    await typeParagraphs(page, d.paragraphs.concat([signoff(d).trim()]));
    await sleep(1000);
    await clickFirst(page, ['button:has-text("Post")', 'button:has-text("Publish")', 'input[type="submit"]'], 20000);
    await sleep(5000);
    return { url: page.url() };
  },
};

// ---------- Quora: a post on Jon's profile (Spaces need a URL in QUORA_SPACE_URL) ----------
const quora = {
  home: "https://www.quora.com/",
  loginUrl: "https://www.quora.com/",
  async isLoggedIn(page) { await page.goto("https://www.quora.com/", { waitUntil: "domcontentloaded" }); await sleep(3000); return !(await page.locator('input[type="password"]').count()) && (await page.locator('button:has-text("Add question"), [aria-label*="Add question"]').count()) > 0; },
  async post(page, d) {
    await page.goto(process.env.QUORA_SPACE_URL || "https://www.quora.com/", { waitUntil: "domcontentloaded" });
    await sleep(3000);
    await clickFirst(page, ['button:has-text("Add question")', '[aria-label*="Add question"]', 'div:has-text("What do you want to ask or share?")'], 20000);
    await sleep(1500);
    await clickFirst(page, ['button:has-text("Create Post")', 'div[role="button"]:has-text("Create Post")'], 15000);
    await sleep(1500);
    const box = page.locator('[contenteditable="true"]').last();
    await box.click();
    await typeParagraphs(page, [d.title].concat(d.paragraphs, [signoff(d).trim()]));
    await sleep(1000);
    await clickFirst(page, ['button:has-text("Post")'], 15000);
    await sleep(5000);
    return { url: page.url() };
  },
};

// ---------- Reddit: text post to the configured subreddit (REDDIT_SUBREDDIT, default u_profile) ----------
const reddit = {
  home: "https://www.reddit.com/",
  loginUrl: "https://www.reddit.com/login/",
  async isLoggedIn(page) { await page.goto("https://www.reddit.com/settings/", { waitUntil: "domcontentloaded" }); await sleep(3500); const t = await page.evaluate(() => document.body?.innerText || ""); return /reddit\.com\/settings/.test(page.url()) && !/blocked by network security/i.test(t) && !/\bLog In\b/.test(t) && !(await page.locator('input[name="password"]').count()); },
  async post(page, d) {
    const sub = process.env.REDDIT_SUBREDDIT || "u_" + (process.env.REDDIT_USERNAME || "");
    if (!sub || sub === "u_") throw new Error("set REDDIT_SUBREDDIT or REDDIT_USERNAME");
    await page.goto(`https://www.reddit.com/r/${sub}/submit?type=TEXT`, { waitUntil: "domcontentloaded" });
    await sleep(4000);
    const title = page.locator('textarea[name="title"], [data-testid="post-title"] textarea, faceplate-textarea-input[name="title"] textarea, input[name="title"]').first();
    await title.waitFor({ timeout: 30000 });
    await title.fill(d.title.slice(0, 300));
    const body = page.locator('[data-testid="post-body"] [contenteditable="true"], shreddit-composer [contenteditable="true"], [contenteditable="true"]').last();
    await body.click();
    await typeParagraphs(page, d.paragraphs.concat([d.reddit_signoff || signoff(d).trim()]), { enterTwice: true });
    await sleep(1000);
    await clickFirst(page, ['button:has-text("Post")', '#submit-post-button', 'button[type="submit"]:has-text("Post")'], 20000);
    await page.waitForURL(/\/comments\//, { timeout: 30000 });
    return { url: page.url() };
  },
};

module.exports = { medium, substack, linkedin, activerain, biggerpockets, quora, reddit };
