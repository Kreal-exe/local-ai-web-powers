// Page reader that runs inside the LM Studio plugin process (no separate service, no Node install).
//   extract(url): YouTube transcript | PDF text | browser-rendered page
//   render(url):  headless Chromium (JavaScript, lazy content) + Defuddle main-content extraction
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dns from "node:dns";
import net from "node:net";
import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const MAX_TEXT = 400_000;
const IDLE_CLOSE_MS = 90_000; // close Chromium when idle so the LLM gets the RAM back
const MAX_PARALLEL = 3;

// Keep heavy packages out of LM Studio's esbuild bundle: load them at runtime from node_modules.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const req: Any = typeof require === "function" ? require : (0, eval)("require");
const importEsm: Any = new Function("s", "return import(s)");

export type Page = { ok: boolean; kind: string; url: string; title: string; description: string; text: string; links: Any[]; images?: string[]; published?: string };
export const log = { fn: (..._a: Any[]) => {} };

// ---------- Network guard (SSRF) ----------
// Pages, links and redirects come from the web, so they must never reach this computer, the local network
// or cloud metadata endpoints. Hosts the user typed into the current message are allowed for that message
// only: the plugin runs each message inside `hostScope.run(new Set([...hosts]), …)`.
export const hostScope = new AsyncLocalStorage<Set<string>>();
function v4Private(ip: string) {
  const [a, b, c] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19));
}
/** The eight 16-bit groups of an IPv6 address (also with "::" and an embedded dotted IPv4); null if invalid. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, "");
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const p = dotted[1].split(".").map(Number);
    s = s.slice(0, -dotted[1].length) + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array(Math.max(0, fill)).fill("0"), ...tail].map(g => parseInt(g, 16));
  return groups.length === 8 && groups.every(g => g >= 0 && g <= 0xffff) ? groups : null;
}
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return v4Private(ip);
  const g = v6Groups(ip);
  if (!g) return true;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zeros = (n: number) => g.slice(0, n).every(x => x === 0);
  if (zeros(5) && g[5] === 0xffff) return v4Private(v4(g[6], g[7])); // ::ffff:a.b.c.d (IPv4-mapped)
  if (zeros(4) && g[4] === 0xffff && g[5] === 0) return v4Private(v4(g[6], g[7])); // ::ffff:0:a.b.c.d (translated)
  if (zeros(6)) return true; // ::, ::1 and the deprecated IPv4-compatible ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) return v4Private(v4(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return v4Private(v4(g[1], g[2])); // 6to4
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00; // ULA, link-local, site-local, multicast
}
const lookups = new Map<string, { at: number; ok: Promise<boolean> }>();
/**
 * Names that point to the user's own machine or network by themselves (IP literals, localhost, *.local, single
 * labels…). Only such hosts can be allowed for a message: a public domain the user pasted is checked like any other,
 * so a scam domain that resolves to 127.0.0.1 gains nothing from being pasted.
 */
export function isLocalName(host: string) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return !!net.isIP(h) || h === "localhost" || !h.includes(".") || /\.(localhost|local|lan|home|internal|localdomain|home\.arpa)$/.test(h);
}
/** True when the URL is http(s) and its host resolves only to public addresses (or the user typed this host). */
export async function isPublicUrl(u: string, allowed: Set<string> | undefined = hostScope.getStore()): Promise<boolean> {
  let url: URL;
  try { url = new URL(u); } catch { return false; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (allowed?.has(host)) return true;
  if (host === "localhost" || /\.(localhost|local|internal|home\.arpa)$/.test(host)) return false;
  if (net.isIP(host)) return !isPrivateIp(host);
  // An early filter only: the address each connection really uses is checked again when it connects.
  const hit = lookups.get(host);
  if (!hit || Date.now() - hit.at > 60_000) {
    lookups.set(host, { at: Date.now(), ok: dns.promises.lookup(host, { all: true })
      .then(addrs => addrs.length > 0 && addrs.every(a => !isPrivateIp(a.address)))
      .catch(() => true) }); // unresolvable: the request fails by itself
    if (lookups.size > 2000) lookups.delete(lookups.keys().next().value as string);
  }
  return lookups.get(host)!.ok;
}

// ---------- Chromium discovery / auto-install ----------
function playwrightCaches() {
  const home = os.homedir();
  return [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(home, "Library/Caches/ms-playwright"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "ms-playwright"),
    path.join(home, ".cache/ms-playwright"),
  ].filter(Boolean) as string[];
}
export function findChromium(): string | undefined {
  // WEB_POWERS_CHROME: path to a Chromium-based browser to use instead of the auto-detected one.
  const own = process.env.WEB_POWERS_CHROME;
  if (own && fs.existsSync(own)) return own;
  const cands: string[] = [];
  for (const base of playwrightCaches()) {
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(base).sort().reverse(); } catch { continue; }
    for (const d of dirs) {
      const p = path.join(base, d);
      if (d.startsWith("chromium_headless_shell-")) {
        cands.push(
          path.join(p, "chrome-headless-shell-mac-arm64/chrome-headless-shell"),
          path.join(p, "chrome-headless-shell-mac-x64/chrome-headless-shell"),
          path.join(p, "chrome-headless-shell-win64/chrome-headless-shell.exe"),
          path.join(p, "chrome-headless-shell-linux64/chrome-headless-shell"),
        );
      }
    }
  }
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  cands.push(
    // System browsers: no download needed (Edge exists on every Windows 10/11).
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    path.join(pf, "Google/Chrome/Application/chrome.exe"),
    path.join(pf86, "Google/Chrome/Application/chrome.exe"),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe") : "",
    path.join(pf86, "Microsoft/Edge/Application/msedge.exe"),
    path.join(pf, "Microsoft/Edge/Application/msedge.exe"),
    "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
  );
  return cands.filter(Boolean).find(p => fs.existsSync(p));
}
let installing: Promise<void> | null = null;
function installHeadlessShell(): Promise<void> {
  // Downloads Playwright's small headless Chromium (~100 MB) once, using LM Studio's own Node.
  if (!installing) {
    installing = new Promise<void>((resolve) => {
      try {
        // cli.js is not in playwright-core's "exports": resolve it next to package.json.
        const cli = path.join(path.dirname(req.resolve("playwright-core/package.json")), "cli.js");
        const child = spawn(process.execPath, [cli, "install", "chromium-headless-shell"], { stdio: "ignore", windowsHide: true });
        child.on("exit", () => resolve());
        child.on("error", () => resolve());
      } catch { resolve(); }
    }).then(() => { if (!findChromium()) installing = null; }); // offline: try again next time
  }
  return installing;
}

// ---------- Browser pool ----------
let browser: Any = null;
let launching: Promise<Any> | null = null;
let idleTimer: Any = null;
let active = 0;
const waiters: Any[] = [];
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  // Parallel page reads share one launch: otherwise each starts its own Chromium and only one is ever closed.
  if (!launching) launching = launchBrowser().finally(() => { launching = null; });
  return launching;
}
async function launchBrowser() {
  let exe = findChromium();
  if (!exe) { log.fn("no Chromium found, downloading headless shell"); await installHeadlessShell(); exe = findChromium(); }
  if (!exe) throw new Error("no Chromium/Chrome/Edge found");
  const { chromium } = req("playwright-core");
  browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    // The browser resolves no names itself: every page request is fetched by the plugin (see render), so the
    // same connection checks apply to it.
    args: ["--disable-gpu", "--no-first-run", "--disable-dev-shm-usage", "--mute-audio", "--js-flags=--max-old-space-size=512", "--disable-blink-features=AutomationControlled", "--host-resolver-rules=MAP * ~NOTFOUND",
      // WebRTC talks UDP to IP addresses directly (no names, no HTTP): not allowed either.
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
  });
  return browser;
}
function touchIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (active === 0 && browser) { const b = browser; browser = null; try { await b.close(); } catch { /* */ } }
  }, IDLE_CLOSE_MS);
}
async function slot() {
  if (active < MAX_PARALLEL) { active++; return; }
  await new Promise(r => waiters.push(r));
  active++;
}
function release() { active--; const n = waiters.shift(); if (n) n(); touchIdle(); }

const tidy = (s: string) => s.split("\n").map(l => l.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n").slice(0, MAX_TEXT);

// ---------- Main-content extraction (Defuddle on a linkedom document, no browser needed) ----------
let defuddleLib: Any = null;
function defuddle() {
  if (!defuddleLib) {
    // "defuddle/node" is exported for `import` only; its CommonJS build sits next to the main entry.
    const dir = path.dirname(req.resolve("defuddle"));
    defuddleLib = { Defuddle: req(path.join(dir, "node.js")).Defuddle, parseHTML: req("linkedom").parseHTML };
  }
  return defuddleLib;
}
/** Turns Defuddle's Markdown into compact text for the model: headings, lists and tables stay; links and images go. */
function compactMarkdown(md: string, base: string) {
  const images: string[] = [];
  let text = md.replace(/!\[([^\]\n]{0,300})\]\(\s*<?([^)\s>]{1,2000})>?(?:\s+"[^"\n]{0,300}")?\s*\)/g, (_m, _alt, src) => {
    try { const u = new URL(src, base).href; if (/^https?:/.test(u) && !/\.svg(\?|#|$)/i.test(u)) images.push(u); } catch { /* */ }
    return "";
  });
  text = text.replace(/\[([^\]\n]{0,300})\]\((?:[^()\s]|\([^()\s]{0,200}\)){0,2000}(?:\s+"[^"\n]{0,300}")?\)/g, "$1") // [text](url) → text
    .replace(/<\/?[a-z][^>]*>/gi, " ") // leftover inline HTML
    .replace(/(\*\*|__)(?=\S)([^\n]{0,400}?\S)\1/g, "$2") // bold: no value for the model, costs tokens
    .replace(/^\s*\[\^[^\]]{1,12}\]:.*$/gm, "") // footnote definitions = the reference list
    .replace(/\[\^[^\]]{1,12}\]/g, "") // footnote markers [^1]
    .replace(/^\s*(\*\*|__)?\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
  return { text: tidy(text), images: [...new Set(images)].slice(0, 8) };
}
export type Extracted = { title: string; description: string; published: string; text: string; images: string[] };
/** Main content of an HTML document as compact Markdown-ish text; null when nothing useful is found. */
export async function extractHtml(html: string, url: string): Promise<Extracted | null> {
  try {
    const { Defuddle, parseHTML } = defuddle();
    const { document } = parseHTML(html);
    const res: Any = await Defuddle(document, url, { markdown: true });
    const { text, images } = compactMarkdown(String(res?.content || ""), url);
    if (res?.image) { try { images.unshift(new URL(res.image, url).href); } catch { /* */ } }
    return { title: String(res?.title || ""), description: String(res?.description || ""), published: String(res?.published || ""), text, images: [...new Set(images)].slice(0, 8) };
  } catch (e) { log.fn("defuddle failed", String(e)); return null; }
}
/** Bot walls and cookie walls instead of the page (Cloudflare, DataDome, "enable JavaScript"…). */
export function isBlockedPage(title: string, text: string) {
  return /^(just a moment|attention required|access denied|checking your browser|verify you are human|are you a robot|security check|403 forbidden|captcha)/i.test(title.trim())
    || (text.length < 600 && /(cloudflare|enable javascript and cookies|verify you are human|unusual traffic|captcha)/i.test(text));
}

export async function render(url: string, waitMs = 6000): Promise<Page> {
  // Playwright calls handlers outside this message's async context: take the allowed hosts along explicitly.
  const allowed = hostScope.getStore();
  const isOk = (u: string) => isPublicUrl(u, allowed);
  if (!(await isOk(url))) throw new Error("blocked address");
  await slot();
  let ctx: Any;
  try {
    const b = await getBrowser();
    ctx = await b.newContext({ userAgent: UA, locale: "ru-RU", viewport: { width: 1280, height: 2000 }, javaScriptEnabled: true, serviceWorkers: "block" });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      for (const k of ["RTCPeerConnection", "webkitRTCPeerConnection"]) { try { delete (window as Any)[k]; } catch { /* */ } }
    });
    let navHops = 0;
    // A main-page navigation that the handler refuses (a download, a blocked hop, a loop) fails the render at once
    // instead of leaving page.goto waiting for its whole timeout.
    let failNav: (e: Error) => void = () => {};
    const navFailed = new Promise<never>((_, rej) => { failNav = rej; });
    navFailed.catch(() => {});
    const mainNav = (rq: Any) => rq.isNavigationRequest() && !rq.frame().parentFrame();
    const refuse = (r: Any, rq: Any, why: string) => { if (mainNav(rq)) failNav(new Error(why)); return r.abort().catch(() => {}); };
    // Every request of the page is fetched by the plugin with the same checks as any other download (redirects are
    // passed to the browser one hop at a time, so each hop is checked). No images/fonts/media (speed), no WebSockets.
    await ctx.route("**/*", async (r: Any) => {
      const rq = r.request();
      let pathname = "";
      try { pathname = new URL(rq.url()).pathname; } catch { /* */ }
      if (["image", "media", "font"].includes(rq.resourceType()) || /\.(m3u8|mpd|ts|m4s|mp4|webm|mp3|aac)$|\/videoplayback/i.test(pathname)) return r.abort().catch(() => {});
      try {
        const headers: Record<string, string> = await rq.allHeaders();
        for (const h of Object.keys(headers)) if (h.startsWith(":") || /^(host|connection|content-length|accept-encoding|transfer-encoding|upgrade|keep-alive|proxy-connection)$/i.test(h)) delete headers[h];
        const nav = rq.isNavigationRequest();
        const res: Any = await get(rq.url(), { method: rq.method(), headers, body: rq.postDataBuffer() || undefined }, 25_000, undefined, { follow: !nav, allowed });
        const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
        if (nav && loc) {
          // Chromium would follow a fulfilled redirect on its own (and fail: it resolves no names). A tiny page
          // that navigates on makes the next hop a new request, which comes through this handler again. Cookies the
          // redirect sets go along (sign-in and consent chains depend on them); loops end after 10 hops.
          res.body?.cancel().catch(() => {});
          if (mainNav(rq) && ++navHops > 10) return refuse(r, rq, "too many redirects");
          const next = JSON.stringify(new URL(loc, rq.url()).href).replace(/</g, "\\u003c");
          const sc: string[] = res.headers.getSetCookie?.() || [];
          return r.fulfill({ status: 200, headers: { "content-type": "text/html", ...(sc.length ? { "set-cookie": sc.join("\n") } : {}) }, body: `<!doctype html><script>location.replace(${next})</script>` });
        }
        // A navigation that turns out to be a file (zip, doc…) is not a page to read.
        if (nav && (/attachment/i.test(res.headers.get("content-disposition") || "") || !/html|text|xml|json/i.test(res.headers.get("content-type") || "text/html"))) {
          res.body?.cancel().catch(() => {});
          return refuse(r, rq, "not a web page");
        }
        const body = await readBody(res, 15 * 1024 * 1024);
        const out: Record<string, string> = {};
        res.headers.forEach((v: string, k: string) => { if (!/^(content-encoding|content-length|transfer-encoding|connection|set-cookie)$/i.test(k)) out[k] = v; });
        const cookies: string[] = res.headers.getSetCookie?.() || [];
        if (cookies.length) out["set-cookie"] = cookies.join("\n");
        return r.fulfill({ status: res.status, headers: out, body });
      } catch (e) { return refuse(r, rq, String((e as Any)?.message || e).slice(0, 80)); }
    });
    await ctx.routeWebSocket(/.*/, (ws: Any) => ws.close());
    const page = await ctx.newPage();
    page.setDefaultTimeout(25_000);
    await Promise.race([page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 }), navFailed]);
    // Redirect pages hand over to the next hop: wait until the real document is there.
    await Promise.race([
      page.waitForFunction(() => document.readyState !== "loading" && !!document.body && document.body.innerHTML.length > 0, null, { timeout: 15_000 }).catch(() => {}),
      navFailed,
    ]);
    if (/^https?:/.test(page.url()) && !(await isOk(page.url()))) throw new Error("blocked redirect");
    await page.waitForLoadState("networkidle", { timeout: waitMs }).catch(() => {});
    // Cookie banners: privacy-preserving choice first, then a plain "OK/close".
    for (const re of [/^(reject|decline|reject all|отклонить|только необходимые|necessary only|odbij)/i, /^(ok|понятно|close|закрыть|×)$/i]) {
      const btn = page.getByRole("button", { name: re }).first();
      if (await btn.isVisible({ timeout: 300 }).catch(() => false)) { await btn.click({ timeout: 1000 }).catch(() => {}); break; }
    }
    for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 2500); await page.waitForTimeout(350); }
    await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
    const data = await page.evaluate(() => {
      const kill = "script,style,noscript,svg,iframe,template,nav,footer,aside,[role=navigation],[role=banner],[aria-hidden=true],[class*=cookie],[id*=cookie],[class*=consent]";
      const root: Any = document.querySelector("main, article, [role=main]") || document.body;
      const clone: Any = root.cloneNode(true);
      clone.querySelectorAll(kill).forEach((e: Any) => e.remove());
      document.body.appendChild(clone); clone.style.position = "absolute"; clone.style.left = "-99999px";
      let text = clone.innerText || "";
      clone.remove();
      if (text.trim().length < 300 && root !== document.body) text = (document.body as Any).innerText || text;
      const links = [...document.querySelectorAll("a[href]")]
        .map((a: Any) => ({ url: a.href, text: (a.innerText || a.title || "").replace(/\s+/g, " ").trim().slice(0, 120) }))
        .filter((l: Any) => /^https?:/.test(l.url)).slice(0, 400);
      // Candidate pictures: the page's preview image plus large images in the content.
      const imgs: string[] = [];
      const og: Any = document.querySelector('meta[property="og:image"],meta[name="twitter:image"]');
      try { if (og && og.content) imgs.push(new URL(og.content, location.href).href); } catch { /* bad og:image */ }
      for (const im of [...root.querySelectorAll("img")] as Any[]) {
        const src = im.currentSrc || im.src || im.getAttribute("data-src") || "";
        if (!/^https?:/.test(src) || /\.svg(\?|$)|sprite|icon|logo|avatar|pixel|blank|spacer|badge|emoji/i.test(src)) continue;
        const w = parseInt(im.getAttribute("width") || "0", 10), h = parseInt(im.getAttribute("height") || "0", 10);
        if ((w && w < 200) || (h && h < 150)) continue;
        imgs.push(src);
        if (imgs.length >= 8) break;
      }
      return { title: document.title, html: document.documentElement.outerHTML, text, links, imgs: [...new Set(imgs)] };
    });
    if (!/^https?:/.test(page.url())) throw new Error("navigation failed");
    if (!(await isOk(page.url()))) throw new Error("blocked redirect");
    if (isBlockedPage(data.title, data.text)) throw new Error(`bot wall: ${data.title.slice(0, 60)}`);
    // Defuddle on the rendered DOM; the visible text is the fallback for pages it cannot structure.
    const ex = await extractHtml(data.html, page.url());
    const useEx = ex && ex.text.length > Math.max(300, data.text.trim().length * 0.35);
    return {
      ok: true, kind: "page", url: page.url(), title: (useEx && ex!.title) || data.title, description: ex?.description || "",
      text: useEx ? ex!.text : tidy(data.text), links: data.links, images: [...new Set([...data.imgs, ...(ex?.images || [])])].slice(0, 8), published: ex?.published || "",
    };
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    release();
  }
}

// ---------- Plain HTTP ----------
// isPublicUrl checks a name before a request; the connection itself is checked too: undici resolves the name for
// each connection through connectLookup, which refuses private addresses. A DNS server that answers with a public
// address first and 127.0.0.1 later (DNS rebinding) therefore gets nowhere.
function connectLookup(allowed?: Set<string>) {
  return (hostname: string, options: Any, cb: Any) => {
    dns.lookup(hostname, { ...options, all: true }, (err: Any, addrs: Any) => {
      if (err) return cb(err);
      const list = addrs as { address: string; family: number }[];
      if (!allowed?.has(hostname.toLowerCase()) && (!list.length || list.some(a => isPrivateIp(a.address)))) {
        return cb(Object.assign(new Error(`blocked address: ${hostname}`), { code: "EBLOCKED" }));
      }
      if (options?.all) cb(null, list); else cb(null, list[0].address, list[0].family);
    });
  };
}
let strictAgent: Any = null;
const typedAgents = new Map<string, Any>();
function agentFor(allowed?: Set<string>) {
  const { Agent } = req("undici");
  if (!allowed?.size) return (strictAgent ||= new Agent({ connect: { lookup: connectLookup() } }));
  const key = [...allowed].sort().join(",");
  let agent = typedAgents.get(key);
  if (!agent) {
    agent = new Agent({ connect: { lookup: connectLookup(new Set(allowed)) } });
    typedAgents.set(key, agent);
    if (typedAgents.size > 8) { const [k, old] = typedAgents.entries().next().value as [string, Any]; typedAgents.delete(k); old.close().catch(() => {}); }
  }
  return agent;
}
/** Abort signal for a request: the time limit covers reading the body too, and Stop (also an earlier one) ends it. */
export function deadline(ms: number, signal?: AbortSignal | null): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}
/**
 * Fetch for web content. Every hop (also redirects) must be a public address, checked by name and again on connect.
 * `res.url` is the final URL. With `follow: false` a redirect is returned as is (used for the browser).
 */
export async function get(url: string, init: Any = {}, ms = 25_000, signal?: Any, opts: { follow?: boolean; allowed?: Set<string> } = {}): Promise<Response> {
  const allowed = opts.allowed ?? hostScope.getStore();
  const sig = deadline(ms, signal);
  const { fetch: ufetch } = req("undici");
  let current = url;
  for (let hop = 0; hop < 8; hop++) {
    if (!(await isPublicUrl(current, allowed))) throw new Error(`blocked address: ${new URL(current).host}`);
    const headers: Record<string, string> = { "user-agent": UA, "accept-language": "ru,en;q=0.8" };
    for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = String(v);
    const res: Any = await ufetch(current, { ...init, headers, redirect: "manual", signal: sig, dispatcher: agentFor(allowed) });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!loc || opts.follow === false) { Object.defineProperty(res, "url", { value: current }); return res; }
    res.body?.cancel().catch(() => {});
    const nextUrl = new URL(loc, current);
    // Like browsers: cookies and credentials stay with their own site.
    if (nextUrl.origin !== new URL(current).origin && init.headers) {
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(init.headers)) if (!/^(cookie|authorization|proxy-authorization)$/i.test(k)) h[k] = String(v);
      init = { ...init, headers: h };
    }
    current = nextUrl.href;
    // Like browsers: 301/302/303 turn a POST into a GET.
    if (res.status <= 303 && init.method && init.method !== "GET" && init.method !== "HEAD") init = { ...init, method: "GET", body: undefined };
  }
  throw new Error("too many redirects");
}
/** The response body, at most `max` bytes (an endless or huge page cannot fill the memory). */
export async function readBody(res: Response, max: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = []; let size = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value)); size += value.byteLength;
      if (size >= max) { reader.cancel().catch(() => {}); break; }
    }
  } finally { try { reader.releaseLock(); } catch { /* */ } }
  return Buffer.concat(chunks).subarray(0, max);
}
/** The body as text in its own encoding (windows-1251, KOI8-R… are still common on Russian sites). */
export async function readText(res: Response, max = 3_000_000): Promise<string> {
  const buf = await readBody(res, max);
  // A byte-order mark wins over any declared charset (as in browsers).
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return new TextDecoder("utf-8").decode(buf);
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf);
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf);
  let charset = ((res.headers.get("content-type") || "").match(/charset=["']?([\w-]+)/i) || [])[1];
  if (!charset) charset = (buf.subarray(0, 4096).toString("latin1").match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
  try { return new TextDecoder(charset || "utf-8").decode(buf); } catch { return new TextDecoder("utf-8").decode(buf); }
}

// ---------- YouTube ----------
export const YT_RE = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/i;
const decodeXml = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
// Innertube clients whose caption links work without a Proof-of-Origin token (checked October 2026).
// The WEB client (and the watch page) needs a BotGuard token and returns empty captions without it.
// ANDROID_VR also needs the visitor id from the watch page.
const YT_CLIENTS: Any[] = [
  { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30 },
  { clientName: "IOS", clientVersion: "20.10.4", deviceMake: "Apple", deviceModel: "iPhone16,2", osName: "iPhone", osVersion: "18.3.2.22D82" },
  { clientName: "ANDROID_VR", clientVersion: "1.65.10", deviceMake: "Oculus", deviceModel: "Quest 3", androidSdkVersion: 32, osName: "Android", osVersion: "12L" },
];
function captionText(xml: string) {
  const parts = [...xml.matchAll(/<(?:p|text)\b[^>]*>([\s\S]*?)<\/(?:p|text)>/g)].map(m => decodeXml(m[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim()).filter(Boolean);
  const paras: string[] = [];
  for (let i = 0; i < parts.length; i += 6) paras.push(parts.slice(i, i + 6).join(" "));
  return paras.join("\n");
}
async function youtube(url: string): Promise<Page> {
  const id = (url.match(YT_RE) as Any)[1];
  // The watch page only adds a visitor id; when YouTube rate-limits it (HTTP 429), the player API still answers.
  let watch = "";
  try { const w = await get(`https://www.youtube.com/watch?v=${id}&hl=en`, {}, 10_000); if (w.ok) watch = await readText(w); } catch { /* optional */ }
  const key = (watch.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1];
  const visitor = (watch.match(/"VISITOR_DATA":"([^"]+)"/) || [])[1];
  let vd: Any = {}; let track: Any = null; let transcript = ""; let playable = false;
  for (const client of YT_CLIENTS) {
    try {
      const pr = await get(`https://www.youtube.com/youtubei/v1/player?prettyPrint=false${key ? `&key=${key}` : ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(visitor ? { "X-Goog-Visitor-Id": visitor } : {}) },
        body: JSON.stringify({ context: { client: { hl: "en", ...client, ...(visitor ? { visitorData: visitor } : {}) } }, videoId: id }),
      });
      const player: Any = JSON.parse(await readText(pr, 5_000_000));
      if (player.videoDetails) vd = player.videoDetails;
      if (player?.playabilityStatus?.status === "OK") playable = true;
      const tracks: Any[] = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      if (!tracks.length) { if (player?.playabilityStatus?.status === "OK") break; continue; } // a video without subtitles
      const pick = tracks.find(t => t.kind !== "asr" && /^(ru|en)/.test(t.languageCode)) || tracks.find(t => t.kind !== "asr") || tracks.find(t => t.kind === "asr") || tracks[0];
      const text = captionText(await readText(await get(pick.baseUrl), 10_000_000));
      // An empty body with HTTP 200 means YouTube wants a token from this client: try the next one.
      if (text) { track = pick; transcript = text; break; }
      log.fn(`YouTube ${client.clientName}: empty captions, trying the next client`);
    } catch (e) { log.fn(`YouTube ${client.clientName} failed`, String(e)); }
  }
  if (!playable && !watch) throw new Error("YouTube is not answering (rate limit?)");
  const head = [
    vd.title && `Video: ${vd.title}`,
    vd.author && `Channel: ${vd.author}`,
    vd.lengthSeconds && `Length: ${Math.round(vd.lengthSeconds / 60)} min`,
    track ? `Subtitles: ${((n: string) => n + (track.kind === "asr" && !/auto-generated/i.test(n) ? " (auto-generated)" : ""))(track.name?.runs?.[0]?.text || track.name?.simpleText || track.languageCode)}` : "No subtitles available (only the description)",
  ].filter(Boolean).join("\n");
  const desc = String(vd.shortDescription || (watch.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/) || [])[1]?.replace(/\\n/g, "\n") || "").slice(0, 3000);
  const title = vd.title || (watch.match(/<title>([^<]*)<\/title>/) || [])[1]?.replace(/ - YouTube$/, "") || `YouTube ${id}`;
  return { ok: true, kind: "youtube", url: `https://www.youtube.com/watch?v=${id}`, title, description: desc.slice(0, 300), text: tidy(`${head}\n\nDescription:\n${desc}\n\nTranscript:\n${transcript || "(none)"}`), links: [], images: [`https://i.ytimg.com/vi/${id}/hqdefault.jpg`] };
}

// ---------- PDF ----------
let pdfjs: Any = null;
async function pdfText(buf: Buffer, url: string): Promise<Page> {
  if (!pdfjs) {
    const { pathToFileURL } = req("node:url");
    // pdf.js warns about an optional canvas package it only needs for rendering; text extraction works without it.
    const warn = console.warn; const log = console.log;
    console.warn = () => {}; console.log = () => {};
    try { pdfjs = await importEsm(pathToFileURL(req.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href); }
    finally { console.warn = warn; console.log = log; }
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(req.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
  }
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  try { return await readPdf(await task.promise, url); } finally { await task.destroy().catch(() => {}); }
}
async function readPdf(doc: Any, url: string): Promise<Page> {
  const numPages = doc.numPages;
  let title = "";
  try { const meta = await doc.getMetadata(); title = meta?.info?.Title || ""; } catch { /* */ }
  const pages = Math.min(numPages, 150);
  const out: string[] = [];
  let total = 0;
  for (let i = 1; i <= pages && total < MAX_TEXT; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const width = page.getViewport({ scale: 1 }).width || 600;
    const t = pageText(tc.items, width);
    total += t.length; out.push(t);
    page.cleanup();
  }
  let name = new URL(url).pathname.split("/").pop() || "document.pdf";
  try { name = decodeURIComponent(name); } catch { /* keep it encoded */ }
  const head = out.join("\n").split("\n").map(l => l.trim()).filter(l => l.length > 10 && l.length < 140).slice(0, 40);
  const titleCase = (l: string) => { const w = l.split(/\s+/).filter(x => /\p{L}/u.test(x)); return w.length >= 2 && w.filter(x => /^\p{Lu}/u.test(x)).length / w.length >= 0.6; };
  const firstLine = head.find(l => titleCase(l) && !/permission|copyright|licen[cs]e|attribution|journal|vol\.|doi/i.test(l) && !/[,;:]$/.test(l)) || head[0] || "";
  return { ok: true, kind: "pdf", url, title: title || firstLine || name, description: `PDF, ${numPages} pages${numPages > pages ? ` (read ${pages})` : ""}`, text: tidy(out.join("\n")), links: [] };
}

type Line = { y: number; x0: number; x1: number; text: string };
/** Text of one PDF page in reading order; two-column layouts are read left column first, then right. */
export function pageText(items: Any[], width: number): string {
  const lines: Line[] = [];
  const rotated: string[] = []; // margin stamps ("arXiv:… [cs.CL]") and vertical labels: kept out of the flow
  let cur: Line | null = null;
  for (const it of items) {
    if (!it.transform || typeof it.str !== "string") continue;
    if (Math.abs(it.transform[1]) > 0.01 || Math.abs(it.transform[2]) > 0.01) { if (it.str.trim()) rotated.push(it.str); continue; }
    const x = it.transform[4], y = Math.round(it.transform[5]), w = it.width || it.str.length * 4;
    // A new segment when the baseline changes, the text jumps back left (next column), or across a wide gap
    // (the gutter between columns when a PDF writes both columns row by row).
    if (!cur || Math.abs(cur.y - y) > 2 || x < cur.x0 - 5 || x - cur.x1 > Math.max(18, width * 0.035)) { if (cur && cur.text.trim()) lines.push(cur); cur = { y, x0: x, x1: x + w, text: "" }; }
    cur.text += (cur.text && x - cur.x1 > 2 && !/\s$/.test(cur.text) && !/^\s/.test(it.str) ? " " : "") + it.str;
    cur.x1 = Math.max(cur.x1, x + w);
  }
  if (cur && cur.text.trim()) lines.push(cur);
  const mid = width / 2;
  const left = lines.filter(l => l.x1 < mid + 8), right = lines.filter(l => l.x0 > mid - 8);
  const twoColumns = lines.length > 12 && left.length > lines.length * 0.3 && right.length > lines.length * 0.3;
  const tail = rotated.length ? ["", rotated.join(" ")] : [];
  if (!twoColumns) return [...lines.map(l => l.text), ...tail].join("\n");
  // Full-width lines (title, headings across both columns) split the page into bands; each band is read
  // left column first, then right, and the full-width line follows the band above it.
  const byY = (a: Line, b: Line) => b.y - a.y;
  const wide = lines.filter(l => !left.includes(l) && !right.includes(l)).sort(byY);
  const out: string[] = [];
  let upper = Infinity;
  for (const w of [...wide, null]) {
    const lower = w ? w.y : -Infinity;
    const inBand = (l: Line) => l.y < upper && l.y > lower;
    out.push(...left.filter(inBand).sort(byY).map(l => l.text), ...right.filter(inBand).sort(byY).map(l => l.text));
    if (w) out.push(w.text);
    upper = lower;
  }
  return [...out, ...tail].join("\n");
}

async function download(url: string) {
  // Some sites reject a full Chrome UA from a non-browser TLS stack but accept a plain one.
  for (const ua of [UA, "Mozilla/5.0", "curl/8.7.1"]) {
    let r: Response;
    try { r = await get(url, { headers: { "User-Agent": ua } }, 40_000); } catch { continue; }
    if (Number(r.headers.get("content-length") || 0) > 40 * 1024 * 1024) { r.body?.cancel().catch(() => {}); throw new Error("PDF larger than 40 MB"); }
    if (r.ok) { try { return { buf: await readBody(r, 40 * 1024 * 1024 + 1), url: r.url || url }; } catch { /* next */ } }
  }
  throw new Error("download failed");
}

export async function extract(url: string): Promise<Page> {
  if (YT_RE.test(url)) return youtube(url);
  let isPdf = /\.pdf(\?|#|$)/i.test(url);
  if (!isPdf) {
    // PDFs without .pdf in the URL are common (arXiv, government sites): check the content type cheaply.
    try { const h = await get(url, { method: "HEAD" }, 8000); isPdf = /application\/pdf/i.test(h.headers.get("content-type") || ""); } catch { /* */ }
  }
  if (isPdf) {
    const d = await download(url);
    if (d.buf.length > 40 * 1024 * 1024) throw new Error("PDF larger than 40 MB");
    if (d.buf.subarray(0, 5).toString() !== "%PDF-") throw new Error("not a PDF");
    return pdfText(d.buf, d.url);
  }
  return render(url);
}

/** The latest Internet Archive copy of a page that is down, blocked or behind a bot wall. */
export async function wayback(url: string): Promise<Page | null> {
  try {
    const r = await get(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, {}, 10_000);
    const snap = (JSON.parse(await readText(r, 200_000)) as Any)?.archived_snapshots?.closest;
    if (!snap?.available || !snap.url) return null;
    // "id_" asks for the original HTML without the archive's toolbar.
    const raw = String(snap.url).replace(/\/web\/(\d+)\//, "/web/$1id_/").replace(/^http:/, "https:");
    const html = await readText(await get(raw, {}, 20_000));
    const ex = await extractHtml(html, url);
    if (!ex || ex.text.length < 300) return null;
    const when = String(snap.timestamp || "").replace(/^(\d{4})(\d{2})(\d{2}).*/, "$1-$2-$3");
    return { ok: true, kind: "archive", url, title: ex.title || url, description: `Internet Archive copy from ${when}`, text: ex.text, links: [], images: ex.images, published: ex.published };
  } catch (e) { log.fn("wayback failed", String(e)); return null; }
}

// Wrapper used by the plugin: never throws.
export async function safe(fn: () => Promise<Page>): Promise<Page | null> {
  try { const p = await fn(); return p && p.ok && p.text ? p : null; } catch (e) { console.error("[web-powers] reader:", String(e).split("\n")[0]); return null; }
}

// ---------- Images for vision models ----------
export const IMAGE_URL_RE = /\.(jpe?g|png|webp|gif|bmp|avif)(\?|#|$)/i;
/** Downloads an image and returns it as a JPEG (longest side <= maxSide) in base64, or null. */
export async function imageForVision(url: string, maxSide = 896): Promise<{ b64: string; mime: string; hash?: string } | null> {
  let buf: Buffer; let type = "";
  try {
    const r = await get(url, { headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8" } }, 20_000);
    if (!r.ok) return null;
    type = r.headers.get("content-type") || "";
    if (!/^image\//i.test(type) || /svg/i.test(type)) return null;
    buf = await readBody(r, 20 * 1024 * 1024 + 1);
    if (buf.length < 3_000 || buf.length > 20 * 1024 * 1024) return null; // icons or huge files
  } catch { return null; }
  // Resize in the browser: no native image library needed, works the same on every OS.
  try {
    await slot();
    let ctx: Any;
    try {
      const b = await getBrowser();
      ctx = await b.newContext();
      const page = await ctx.newPage();
      const dataUrl = `data:${type.split(";")[0]};base64,${buf.toString("base64")}`;
      const out = await page.evaluate(async ({ dataUrl, maxSide }: Any) => {
        const img = new Image();
        img.src = dataUrl;
        await img.decode();
        // Skip icons and banners: too small, or stretched strips that show nothing at chat size.
        const w = img.naturalWidth, h = img.naturalHeight;
        if (w < 200 || h < 150 || w / h > 2.4 || h / w > 2.4) return null;
        const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement("canvas");
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        const g: Any = c.getContext("2d");
        g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, c.width, c.height);
        // 8x8 average hash: lets the plugin drop the same photo found on several pages.
        const t = document.createElement("canvas"); t.width = 8; t.height = 8;
        const tg: Any = t.getContext("2d"); tg.drawImage(img, 0, 0, 8, 8);
        const px = tg.getImageData(0, 0, 8, 8).data; const gray: number[] = [];
        for (let i = 0; i < 64; i++) gray.push(px[i * 4] * 0.3 + px[i * 4 + 1] * 0.59 + px[i * 4 + 2] * 0.11);
        const mean = gray.reduce((a, b) => a + b, 0) / 64;
        return { data: c.toDataURL("image/jpeg", 0.85), hash: gray.map(v => (v > mean ? "1" : "0")).join("") };
      }, { dataUrl, maxSide });
      if (!out) return null;
      return { b64: String((out as Any).data).split(",")[1], mime: "image/jpeg", hash: (out as Any).hash };
    } finally {
      if (ctx) await ctx.close().catch(() => {});
      release();
    }
  } catch {
    // No browser: send the original if it is small enough and in a common format.
    if (buf.length <= 2 * 1024 * 1024 && /jpe?g|png|webp/i.test(type)) return { b64: buf.toString("base64"), mime: type.split(";")[0] };
    return null;
  }
}

/** Shrinks a JPEG/PNG (base64) to a small preview for display in the chat. */
export async function shrinkB64(b64: string, maxSide = 420): Promise<string> {
  try {
    await slot();
    let ctx: Any;
    try {
      const b = await getBrowser();
      ctx = await b.newContext();
      const page = await ctx.newPage();
      const out = await page.evaluate(async ({ b64, maxSide }: Any) => {
        const img = new Image();
        img.src = `data:image/jpeg;base64,${b64}`;
        await img.decode();
        const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement("canvas");
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        const g: Any = c.getContext("2d");
        g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, c.width, c.height);
        return c.toDataURL("image/jpeg", 0.85);
      }, { b64, maxSide });
      return String(out).split(",")[1] || b64;
    } finally {
      if (ctx) await ctx.close().catch(() => {});
      release();
    }
  } catch { return b64; }
}
