// LM Studio plugin: Local AI Web Powers (prompt preprocessor).
// Searches the web before the model answers and injects numbered sources into the prompt,
// so it works with any model, including ones that cannot do tool calls.
import { createConfigSchematics, tool } from "@lmstudio/sdk";
import { z } from "zod";
import * as reader from "./reader";
import { builtinSearxngUrl } from "./searxng";
import { cache, stats as cacheStats } from "./cache";
import { stem } from "./stem";
import { AsyncLocalStorage } from "node:async_hooks";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const HELP_TEXT = [
  "COMMANDS — anywhere in your message:",
  "/web — check the internet now   ·   /noweb — skip it",
  "/think · /no_think — thinking on/off for this message",
  "/fresh — ignore the cache   ·   /clearcache — empty it",
  "/day /week /month /year — only recent results",
  "",
  "SETTINGS:",
  "Search the web — Smart: the model decides when it needs fresh facts; Always; On keywords; Only with /web or a link.",
  "Research depth — Quick: 1 search; Standard: queries in several languages; Deep: plus a second round for gaps.",
  "How much to read — Auto fits the chat's context (recommended); Light/Normal/Heavy ≈ 3/6/10 pages, never more than fits.",
  "Pictures in answers — illustrates research answers with web pictures, like an article (any model).",
  "Model looks at web pictures — vision models study the pictures found during research (and image links you paste).",
  "Thinking — follows LM Studio's Think button, or always off/on.",
  "",
  "TIPS:",
  "• Paste a link and ask about it: the page (also PDF, YouTube, JavaScript sites) and related pages of the site are read.",
  "• Ask \"what does it look like\", \"show a photo/map/chart\" — vision models get pictures.",
  "• Follow-up questions use the sources already in the chat: instant, no new search, almost no extra context.",
  "• Each researched message takes at most ~1/4 of the context; when the chat is full, start a new one (or load the model with a bigger context).",
  "• Ask in any language: queries are also made in English and in the topic's local language; the answer comes in your language.",
  "• Faster with LM Studio's local server on (Developer → Start server); works without it too.",
  "• \"Nothing found\" with a CAPTCHA/too many requests note: free engines rate-limit — wait a few minutes or add a free Tavily key (global settings).",
  "• An embedding model in LM Studio (e.g. bge-m3) adds meaning-based ranking of passages.",
  "• Footnotes [1] open the exact page; the sources list is at the end.",
  "",
  "Docs: github.com/Kreal-exe/local-ai-web-powers",
].join("\n");

// Per-chat settings: right panel → Integrations → local-ai-web-powers.
// Main options on top, details below; explanations live in hover hints to keep the panel compact.
const configSchematics = createConfigSchematics()
  .field("mode", "select", {
    displayName: "Search the web",
    hint: "Smart: the loaded model decides in ~3 s whether the message needs fresh facts from the internet (news, people, prices, numbers, anything it isn't sure about). Links in the message and /web always trigger a check, /noweb skips it.",
    options: [
      { value: "smart", displayName: "🧠 Smart — when the model needs it" },
      { value: "always", displayName: "🌐 Always" },
      { value: "auto", displayName: "🔑 On keywords (find, news, latest…)" },
      { value: "manual", displayName: "✋ Only with /web or a link" },
    ],
  }, "smart")
  .field("depth", "select", {
    displayName: "Research depth",
    hint: "Quick: your question as one search. Standard: the model also writes queries in English and in the topic's local language. Deep: after reading, it searches again for what is still missing.",
    options: [
      { value: "1", displayName: "⚡ Quick — one search" },
      { value: "2", displayName: "🔎 Standard — several languages" },
      { value: "3", displayName: "🧭 Deep — plus a gap-filling round" },
    ],
  }, "2")
  .field("reading", "select", {
    displayName: "How much to read",
    hint: "Auto reads as much as fits: the plugin checks the model's context and what this chat already uses (earlier sources stay in the history), and keeps each researched message under a quarter of the context.",
    options: [
      { value: "auto", displayName: "🎯 Auto — fits the chat's context" },
      { value: "light", displayName: "📄 Light — 3 pages" },
      { value: "normal", displayName: "📚 Normal — 6 pages" },
      { value: "heavy", displayName: "🗄️ Heavy — 10 pages" },
    ],
  }, "auto")
  .field("history", "select", {
    displayName: "Keep in chat history",
    hint: "LM Studio keeps everything the plugin adds in the chat history. Compact sources are fast. Notes: the model first condenses many more pages into short cited facts in a separate pass (slower), and only the notes stay in the chat. Auto switches to notes when the chat is more than half full.",
    options: [
      { value: "auto", displayName: "🎯 Auto — notes when the chat fills up" },
      { value: "notes", displayName: "🗒️ Short notes (saves context)" },
      { value: "full", displayName: "📄 Compact sources (faster)" },
    ],
  }, "auto")
  .field("pictures", "select", {
    displayName: "Pictures in answers",
    hint: "Adds pictures from the web to research answers, like an illustrated article. Works with any model. 'When useful': questions like \"what does it look like\", photos, maps, charts, logos.",
    options: [
      { value: "auto", displayName: "🖼️ When useful" },
      { value: "always", displayName: "📰 Always illustrate" },
      { value: "off", displayName: "🚫 Never" },
    ],
  }, "auto")
  .field("see", "select", {
    displayName: "Model looks at web pictures",
    hint: "Vision models only: the pictures found during research are given to the model so it can study them, not only read about them. Image links in your message count as 'when useful'.",
    options: [
      { value: "auto", displayName: "👁️ When useful" },
      { value: "always", displayName: "🔬 Always" },
      { value: "off", displayName: "🚫 Never" },
    ],
  }, "auto")
  .field("reasoning", "select", {
    displayName: "Thinking",
    hint: "Thinking over the sources is slower but often smarter. 'Same as LM Studio' follows the Think button under the input. /think and /no_think work for a single message.",
    options: [
      { value: "model", displayName: "⚙️ Same as LM Studio's Think button" },
      { value: "off", displayName: "⚡ Off — answer right away" },
      { value: "on", displayName: "💭 On — think over sources first" },
    ],
  }, "model")
  .field("answerStyle", "select", {
    displayName: "Answer style",
    hint: "Short: a few key facts. Detailed: a structured report with headings.",
    options: [
      { value: "balanced", displayName: "⚖️ Balanced" },
      { value: "short", displayName: "✂️ Short — key facts only" },
      { value: "detailed", displayName: "📝 Detailed — full report" },
    ],
  }, "balanced")
  .field("sourcesList", "boolean", {
    displayName: "Clickable sources list at the end",
  }, true)
  .field("help", "string", {
    displayName: "📘 Commands & tips (read-only)",
    isParagraph: true,
  }, HELP_TEXT)
  .build();

// Global settings (shown below the per-chat ones).
const globalConfigSchematics = createConfigSchematics()
  .field("cacheMinutes", "numeric", {
    int: true, min: 0, max: 1440,
    displayName: "Cache, minutes",
    hint: "Searches and pages are reused for this long, also after a restart. PDFs and videos are kept 7 days, news searches 10 minutes. 0 = off. /fresh ignores the cache once, /clearcache empties it.",
  }, 60)
  .field("searxngUrl", "string", {
    displayName: "Own SearXNG URL",
    hint: "Leave empty to use the built-in SearXNG, which starts automatically.",
    placeholder: "empty = built-in",
  }, "")
  .field("ranking", "select", {
    displayName: "Passage ranking",
    hint: "Auto: keyword ranking (BM25) plus meaning-based ranking with an embedding model when one is installed in LM Studio (a multilingual one such as bge-m3 or Qwen3-Embedding for non-English questions; the built-in nomic-embed works for English). The embedding model loads for a moment and unloads itself.",
    options: [
      { value: "auto", displayName: "🎯 Auto — keywords + embedding model if installed" },
      { value: "keywords", displayName: "🔤 Keywords only (BM25)" },
    ],
  }, "auto")
  .field("tools", "boolean", {
    displayName: "Tools for tool-calling models",
    hint: "Also gives models with native tool use two tools: read_more (the rest of a source page) and search_web (a new search). Leave off for small or abliterated models: the plugin already researches before every answer.",
  }, false)
  .field("tavilyKey", "string", {
    displayName: "Tavily API key (optional)",
    hint: "Used before the free engines when set. 1,000 free searches a month at tavily.com, no card.",
    isProtected: true, placeholder: "tvly-…",
  }, "")
  .field("braveKey", "string", {
    displayName: "Brave Search API key (optional)",
    hint: "Used before the free engines when set (api-dashboard.search.brave.com).",
    isProtected: true,
  }, "")
  .field("ollamaKey", "string", {
    displayName: "Ollama web search key (optional)",
    hint: "Used before the free engines when set (free account at ollama.com → Keys).",
    isProtected: true,
  }, "")
  .build();

// State of one message (or one tool call). Several chats can be researched at the same time, so nothing
// per-message may live in module variables: each message runs inside RUN.run(newRun(), …).
type Run = {
  lang: string; timeRange: string; searchProblem: string; freshSearch: boolean; fresh: boolean;
  pendingFiles: Any[]; seeBudget: number; conv: { text: string; conv: Any } | null;
};
const newRun = (): Run => ({ lang: "en", timeRange: "", searchProblem: "", freshSearch: false, fresh: false, pendingFiles: [], seeBudget: 2, conv: null });
const RUN = new AsyncLocalStorage<Run>();
const OUTSIDE = newRun();
const run = (): Run => RUN.getStore() || OUTSIDE;
cache.skipReadsFor = () => run().fresh;
const t = (ru: Any, en: Any) => (run().lang === "ru" ? ru : en);
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const AUTO_TRIGGERS = /(?<![\p{L}\p{N}])(интернет|найди|поищи|загугли|погугли|ресерч|исследу|источник|новост|сегодня|сейчас|последн|актуальн|свеж|цена|цены|курс|погода|search|google|web(?![\p{L}])|internet|latest|news|today|current(?:ly)?(?![\p{L}])|research|sources?(?![\p{L}])|20[2-3]\d(?![\p{N}]))/iu;

function decodeEntities(s: Any) {
  return s
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_: string, n: string) => { try { return String.fromCodePoint(+n); } catch { return " "; } })
    .replace(/&#x([0-9a-f]+);/gi, (_: string, n: string) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return " "; } });
}

function htmlToText(html: Any, minLen: Any = 40) {
  // Attribute values (e.g. Wikipedia's data-mw JSON) may contain ">" and break tag stripping: drop them first.
  let h = html.replace(/\s(?:data-[\w-]+|style|class|typeof|about|title|alt|srcset|sizes)=("[^"]*"|'[^']*')/gi, "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe|template)[\s\S]*?<\/\1>/gi, " ");
  h = h.replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n");
  h = decodeEntities(h.replace(/<[^>]+>/g, " "));
  return h.split("\n").map((l: string) => l.replace(/\s+/g, " ").trim()).filter((l: string) => l.length >= minLen).join("\n");
}

function keywords(q: Any): string[] {
  return [...new Set<string>(q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w: string) => w.length > 2))];
}

/** Fetch for known services (LM Studio, SearXNG, search APIs); the time limit and Stop also cover the body. */
async function fetchWithTimeout(url: Any, ms: Any, signal: Any, init: Any = {}) {
  return fetch(url, { ...init, signal: reader.deadline(ms, signal), redirect: "follow", headers: { "User-Agent": UA, "Accept-Language": "ru,en;q=0.8", ...(init.headers || {}) } });
}
/** Ends the research quietly once the user pressed Stop (checked between the stages). */
function stopIfAborted(signal: Any) {
  if (signal?.aborted) throw Object.assign(new Error("stopped by the user"), { name: "AbortError" });
}

type Hit = { title: string; url: string; snippet: string; engine: string };

async function searchSearxng(base: Any, q: Any, signal: Any): Promise<Hit[]> {
  const u = `${base.replace(/\/$/, "")}/search?format=json&q=${encodeURIComponent(q)}${run().timeRange ? `&time_range=${run().timeRange}` : ""}`;
  const r = await fetchWithTimeout(u, 20000, signal);
  if (!r.ok) throw new Error(`SearXNG HTTP ${r.status}`);
  const d: Any = await r.json();
  const results = (d.results || []).map((x: Any) => ({ title: x.title || x.url, url: x.url, snippet: x.content || "", engine: x.engine || "searxng" }));
  // SearXNG answers 200 even when every engine refused: the reasons are in unresponsive_engines.
  if (!results.length && d.unresponsive_engines?.length) run().searchProblem = d.unresponsive_engines.map((x: Any) => `${x[0]}: ${x[1]}`).join("; ");
  return results;
}

async function searchImages(cfg: Any, q: Any, signal: Any, log: Any): Promise<Any[]> {
  try {
    const base = cfg.searxngUrl || (await builtinSearxngUrl(log));
    if (!base) return [];
    const r = await fetchWithTimeout(`${base.replace(/\/$/, "")}/search?format=json&categories=images&q=${encodeURIComponent(q)}`, 20000, signal);
    if (!r.ok) return [];
    const d: Any = await r.json();
    return (d.results || []).filter((x: Any) => x.img_src).map((x: Any) => ({ img: x.img_src, page: x.url, title: x.title || "" }));
  } catch { return []; }
}

// DuckDuckGo's bot wall: HTTP 202, or a page with the "select all ducks" puzzle.
const DDG_BLOCK = /anomaly-modal__|\/anomaly\.js|id="challenge-form"/;
async function searchDuckDuckGo(q: Any, signal: Any): Promise<Hit[]> {
  // GET with a plain UA: DuckDuckGo answers POSTs from non-browser TLS stacks with a 202 bot page.
  const r = await fetchWithTimeout(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}${run().timeRange ? `&df=${run().timeRange[0]}` : ""}`, 20000, signal, { headers: { "User-Agent": "Mozilla/5.0" } });
  const html = await r.text();
  if (r.status === 202 || DDG_BLOCK.test(html)) throw new Error("DuckDuckGo shows a CAPTCHA: too many searches from this address, try again in a few minutes");
  const out: Hit[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m;
  while ((m = re.exec(html)) && out.length < 20) {
    let url = decodeEntities(m[1]);
    const ud = url.match(/[?&]uddg=([^&]+)/);
    if (ud) url = decodeURIComponent(ud[1]);
    if (!/^https?:/.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    out.push({ title: decodeEntities(m[2].replace(/<[^>]+>/g, "")).trim(), url, snippet: decodeEntities((m[3] || "").replace(/<[^>]+>/g, "")).trim(), engine: "duckduckgo" });
  }
  return out;
}

// Keyed APIs (optional, set in the global settings): more reliable than scraping free engines.
async function searchTavily(key: string, q: string, signal: Any): Promise<Hit[]> {
  const r = await fetchWithTimeout("https://api.tavily.com/search", 20000, signal, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: q, max_results: 10, search_depth: "basic", ...(run().timeRange ? { time_range: run().timeRange } : {}) }),
  });
  if (!r.ok) throw new Error(`Tavily HTTP ${r.status}`);
  const d: Any = await r.json();
  return (d.results || []).map((x: Any) => ({ title: x.title || x.url, url: x.url, snippet: x.content || "", engine: "tavily" }));
}
async function searchBrave(key: string, q: string, signal: Any): Promise<Hit[]> {
  const fresh = run().timeRange ? `&freshness=p${run().timeRange[0]}` : "";
  const r = await fetchWithTimeout(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=10${fresh}`, 20000, signal, {
    headers: { Accept: "application/json", "X-Subscription-Token": key },
  });
  if (!r.ok) throw new Error(`Brave HTTP ${r.status}`);
  const d: Any = await r.json();
  return (d.web?.results || []).map((x: Any) => ({ title: x.title || x.url, url: x.url, snippet: String(x.description || "").replace(/<[^>]+>/g, ""), engine: "brave-api" }));
}
async function searchOllama(key: string, q: string, signal: Any): Promise<Hit[]> {
  const r = await fetchWithTimeout("https://ollama.com/api/web_search", 20000, signal, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: q, max_results: 10 }),
  });
  if (!r.ok) throw new Error(`Ollama web search HTTP ${r.status}`);
  const d: Any = await r.json();
  return (d.results || []).map((x: Any) => ({ title: x.title || x.url, url: x.url, snippet: String(x.content || "").slice(0, 400), engine: "ollama" }));
}

async function search(cfg: Any, q: Any, signal: Any, log: Any): Promise<Hit[]> {
  const key = `${run().timeRange}|${q}`;
  const hit = cache.get(`q:${key}`);
  if (hit) return hit;
  const tryOne = async (name: string, fn: () => Promise<Hit[]>) => {
    try { return await fn(); } catch (e) { const msg = String((e as Any)?.message || e); run().searchProblem = msg; console.error(`[web-powers] ${name} failed: ${msg}`); return []; }
  };
  let res: Hit[] = [];
  // 1) The user's own API keys.
  if (cfg.tavilyKey) res = await tryOne("Tavily", () => searchTavily(cfg.tavilyKey, q, signal));
  if (!res.length && cfg.braveKey) res = await tryOne("Brave API", () => searchBrave(cfg.braveKey, q, signal));
  if (!res.length && cfg.ollamaKey) res = await tryOne("Ollama web search", () => searchOllama(cfg.ollamaKey, q, signal));
  // 2) Own SearXNG, then the built-in one.
  if (!res.length && cfg.searxngUrl) res = await tryOne("own SearXNG", () => searchSearxng(cfg.searxngUrl, q, signal));
  if (!res.length) res = await tryOne("built-in SearXNG", async () => { const b = await builtinSearxngUrl(log); return b ? searchSearxng(b, q, signal) : []; });
  // 3) DuckDuckGo directly (also the only free option where the built-in SearXNG has no binary, e.g. Intel Macs).
  if (!res.length) res = await tryOne("DuckDuckGo", () => searchDuckDuckGo(q, signal));
  if (res.length) cache.put(`q:${key}`, res, searchTtl());
  return res;
}

/** Wikipedia's own search: keyless and stable, used when the engines return little. */
async function searchWikipedia(q: string, lang: string, signal: Any): Promise<Hit[]> {
  try {
    const r = await fetchWithTimeout(`https://${lang}.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(q)}&limit=3`, 10000, signal, { headers: { "User-Agent": "local-ai-web-powers (https://github.com/Kreal-exe/local-ai-web-powers)" } });
    if (!r.ok) return [];
    const d: Any = await r.json();
    return (d.pages || []).map((x: Any) => ({ title: `${x.title} — Wikipedia`, url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(x.key)}`, snippet: String(x.excerpt || "").replace(/<[^>]+>/g, ""), engine: "wikipedia" }));
  } catch { return []; }
}

function safeDecode(u: string) { try { return decodeURIComponent(u); } catch { return u; } }
// Only the host is case-insensitive: paths and queries (YouTube ids, base64 tokens) keep their case.
function normUrl(u: Any) {
  try { const x = new URL(u); x.hash = ""; return x.host.toLowerCase().replace(/^www\./, "") + x.pathname.replace(/\/$/, "") + x.search; } catch { return u; }
}

let CACHE_MS = 60 * 60_000;
const PAGE_CAP = 80_000; // chars kept per page before chunk selection
const SPECIAL_RE = /(youtube\.com\/(watch|shorts|live|embed)|youtu\.be\/|\.pdf(\?|#|$))/i;
// Cache lifetimes. Static content (PDF, video transcripts) lives long; time-sensitive searches short.
const DAY = 24 * 60 * 60_000;
function pageTtl(kind?: Any) { return kind === "pdf" || kind === "youtube" ? Math.max(CACHE_MS, 7 * DAY) : CACHE_MS; }
function searchTtl() { return run().freshSearch ? Math.min(CACHE_MS, 10 * 60_000) : CACHE_MS; }
/** Pages from public hosts are shared through the cache; pages from a host the user typed (a LAN address) are not. */
const shareable = (url: string) => reader.isPublicUrl(url, new Set());
async function service(endpoint: Any, url: Any) {
  // The guard runs before the cache too: a cached page is only as allowed as a fresh request would be.
  if (!(await reader.isPublicUrl(url))) return null;
  const read = () => reader.safe(() => (endpoint === "render" ? reader.render(url) : endpoint === "wayback" ? reader.wayback(url) as Promise<reader.Page> : reader.extract(url)));
  if (!(await shareable(url))) return read();
  const key = `${endpoint}:${normUrl(url)}`;
  const hit = cache.get(key);
  if (hit) return { ...hit, fromCache: true };
  // A shared page is read without this message's typed hosts: a redirect to the user's router must not end up
  // in the cache that other chats read.
  return cache.once(key, () => reader.hostScope.run(new Set<string>(), async () => {
    const d = await read();
    if (d) cache.put(key, d, pageTtl(d.kind));
    return d;
  }));
}
const kindLabel = (k: Any) => (({ youtube: " (YouTube)", pdf: " (PDF)", page: t(" (браузер)", " (browser)"), archive: t(" (копия из архива)", " (archived copy)") }) as Any)[k] || "";

/** Short date (YYYY-MM-DD) from the various formats pages use; "" when unknown. */
function shortDate(d: Any, url = "") {
  // Wikis report the date the article was created, which reads like a stale source.
  if (/(wikipedia|wikimedia|wiktionary|fandom)\.(org|com)/i.test(url)) return "";
  const m = String(d || "").match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

async function readPages(results: Any, signal: Any, status: Any) {
  const out: Any[] = [];
  // Search results never need the hosts the user typed (their pages may be cached and shared).
  await reader.hostScope.run(new Set<string>(), () => Promise.all(results.map(async (r: Any) => {
    const host = hostOf(r.url);
    const cached = (await shareable(r.url)) ? cache.get(`page:${normUrl(r.url)}`) : null;
    if (cached) { out.push({ ...r, ...cached }); status.addSubStatus({ status: "done", text: `${t("Из кэша", "Cached")}: ${r.title.slice(0, 60)} · ${host}` }); return; }
    const sub = status.addSubStatus({ status: "loading", text: `${t("Читаю", "Reading")}: ${r.title.slice(0, 60)} · ${host}` });
    const keep = (page: Any, ttl: number, label: string) => {
      const entry = { title: page.title, text: page.text.slice(0, PAGE_CAP), images: page.images || [], date: page.date || "" };
      out.push({ ...r, ...entry });
      shareable(r.url).then(ok => { if (ok) cache.put(`page:${normUrl(r.url)}`, entry, ttl); });
      sub.setState({ status: "done", text: `${t("Прочитано", "Read")}${label}: ${String(page.title).slice(0, 55)} · ${host}` });
    };
    const viaService = async (endpoint: Any) => {
      const d = await service(endpoint, r.url);
      if (d && d.text.length > 200) {
        keep({ title: d.kind === "page" ? r.title : (d.title || r.title), text: d.text, images: d.images, date: shortDate(d.published, r.url) }, pageTtl(d.kind),
          `${kindLabel(d.kind)}${d.fromCache ? t(" (из кэша)", " (cached)") : ""}`);
        return true;
      }
      return false;
    };
    try {
      if (SPECIAL_RE.test(r.url) && await viaService("extract")) return;
      const resp = await reader.get(r.url, {}, 12000, signal);
      const ct = resp.headers.get("content-type") || "";
      if (/application\/pdf/i.test(ct)) { if (await viaService("extract")) return; throw new Error("pdf"); }
      if (!resp.ok || !/html|text/.test(ct)) { resp.body?.cancel().catch(() => {}); throw new Error(`${resp.status} ${ct}`); }
      const html = await reader.readText(resp, 2_000_000);
      const ex = await reader.extractHtml(html, resp.url || r.url);
      const text = ex && ex.text.length >= 200 ? ex.text : htmlToText(html);
      // JavaScript apps, bot walls and cookie walls: open in the browser.
      if (text.length < 600 || reader.isBlockedPage(titleOf(html, ""), text)) {
        sub.setState({ status: "loading", text: `${t("Открываю в браузере", "Opening in browser")}: ${r.title.slice(0, 50)} · ${host}` });
        if (await viaService("render")) return;
        if (reader.isBlockedPage(titleOf(html, ""), text)) throw new Error("bot wall");
      }
      if (text.length < 200) throw new Error("empty");
      keep({ title: ex?.title || r.title, text, images: ex?.images?.length ? ex.images : ogImage(html, r.url), date: shortDate(ex?.published, r.url) }, pageTtl(), "");
    } catch (e) {
      if (signal?.aborted) return; // Stop: no browser, no archive
      if (!SPECIAL_RE.test(r.url) && await viaService("extract")) return;
      // Down, blocked or behind a bot wall: the Internet Archive's latest copy.
      sub.setState({ status: "loading", text: `${t("Ищу копию в архиве", "Looking for an archived copy")}: ${r.title.slice(0, 45)} · ${host}` });
      if (await viaService("wayback")) return;
      if (r.snippet) out.push({ ...r, text: r.snippet });
      sub.setState({ status: "canceled", text: `${t("Не открылось", "Failed")}: ${r.title.slice(0, 50)} · ${host}` });
    }
  })));
  return out;
}

// ---------- BM25 chunk selection ----------
const STEMS = new Map<string, string[]>();
/** Index keys of one word: its stem plus a 5-letter prefix, so both "студенческого"/"студенческий" and "канал"/"канала" match. */
function keysOf(w: string): string[] {
  let k = STEMS.get(w);
  if (!k) {
    const st = stem(w);
    k = w.length > 5 && w.slice(0, 5) !== st ? [st, w.slice(0, 5)] : [st];
    if (STEMS.size > 50_000) STEMS.clear();
    STEMS.set(w, k);
  }
  return k;
}
function words(s: Any): string[] {
  return String(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2);
}
function terms(s: Any, skipStop = false): string[] {
  return words(s).filter(w => !skipStop || !STOP.has(w)).flatMap(keysOf);
}
function chunkText(text: Any, size = 700) {
  const lines = String(text).split("\n").filter(l => l.trim());
  const chunks: string[] = [];
  let cur = "";
  for (const l of lines) {
    if (cur && cur.length + l.length > size) { chunks.push(cur); cur = ""; }
    if (l.length > size * 1.5) {
      for (let i = 0; i < l.length; i += size) chunks.push(l.slice(i, i + size));
      continue;
    }
    cur += (cur ? "\n" : "") + l;
  }
  if (cur) chunks.push(cur);
  return chunks;
}
const STOP = new Set(["как", "что", "это", "так", "для", "они", "она", "оно", "его", "еще", "ещё", "уже", "там", "тут", "где", "кто", "чем", "при", "или", "the", "and", "what", "how", "you", "are", "this", "that", "with", "for", "дела", "привет", "спасибо", "hello", "thanks"]);
function overlap(sources: Any[], query: Any) {
  // How many meaningful words of the question occur in the sources (stems, cross-language friendly).
  const q = [...new Set(words(query).filter(w => !STOP.has(w)))].map(w => keysOf(w));
  if (!q.length) return 0;
  const hay = new Set(sources.flatMap((s: Any) => terms(String(s.text).slice(0, 200_000))));
  return q.filter(keys => keys.some(k => hay.has(k))).length;
}
type Similarity = (query: string, texts: string[]) => Promise<number[] | null>;
async function selectChunks(sources: Any, query: Any, maxChars: Any, opts: { summary?: boolean; similarity?: Similarity | null; semanticQuery?: string } = {}) {
  const all: Any[] = [];
  const seenText = new Set<string>();
  sources.forEach((s: Any, si: number) => {
    chunkText(s.text).forEach((t, ci) => {
      const key = t.toLowerCase().replace(/\s+/g, " ").slice(0, 200);
      if (seenText.has(key)) return; // drop repeated menus/boilerplate across pages
      seenText.add(key);
      all.push({ si, ci, t, tf: terms(t) });
    });
  });
  if (!all.length) return sources.map(() => "");
  const q = [...new Set(terms(query, true))];
  const df: Any = {};
  for (const c of all) for (const w of new Set<string>(c.tf)) df[w] = (df[w] || 0) + 1;
  const N = all.length;
  const avg = all.reduce((a, c) => a + c.tf.length, 0) / N || 1;
  const k1 = 1.2, b = 0.75;
  for (const c of all) {
    const tf: Any = {};
    for (const w of c.tf) tf[w] = (tf[w] || 0) + 1;
    let s = 0;
    for (const w of q) {
      if (!tf[w]) continue;
      const idf = Math.log(1 + (N - df[w] + 0.5) / (df[w] + 0.5));
      s += idf * (tf[w] * (k1 + 1)) / (tf[w] + k1 * (1 - b + b * c.tf.length / avg));
    }
    const src = sources[c.si];
    // Leading chunks carry the summary of a page; links pasted by the user matter more.
    const lead = Math.max(0, 1 - c.ci / 6) * (opts.summary ? 2.5 : 0.6);
    const lines = c.t.split("\n");
    const refLines = lines.filter((l: Any) => /^\s*\[\d+\]|arXiv preprint|In Proceedings|et al\.,? \d{4}|doi:|ISBN/i.test(l)).length;
    const biblio = refLines / lines.length > 0.3 ? 0.25 : 1;
    c.bm = s * biblio;
    c.score = (s * (src.direct ? 1.4 : src.prev ? 0.9 : 1) + (src.prev ? 0 : lead) + Math.min(c.t.length, 500) / 2000) * biblio;
  }
  // Meaning-based ranking (embedding model) on the best keyword candidates: finds passages that say the same
  // thing in other words or another language, and pushes down passages that only share words with the question.
  let semantic = false;
  if (opts.similarity && !opts.summary && all.length > 3) {
    const pool = [...all].sort((x, y) => y.score - x.score).slice(0, 48);
    for (const s of sources.map((_: Any, si: number) => all.find(c => c.si === si))) if (s && !pool.includes(s)) pool.push(s);
    const sims = await opts.similarity(opts.semanticQuery || String(query), pool.map(c => c.t)).catch(() => null);
    if (sims && sims.length === pool.length) {
      const top = Math.max(...sims), low = Math.min(...sims);
      const maxScore = Math.max(...all.map(c => c.score)) || 1;
      pool.forEach((c, i) => { c.sem = top > low ? (sims[i] - low) / (top - low) : 1; });
      for (const c of all) c.score = 0.5 * (c.score / maxScore) + 0.5 * (c.sem || 0);
      semantic = true;
    }
  }
  const picked = new Set<Any>();
  let used = 0;
  const take = (c: Any) => { if (picked.has(c) || used + c.t.length > maxChars) return false; picked.add(c); used += c.t.length + 1; return true; };
  // 1) every source gets its best chunk (and direct links their opening chunk)
  sources.forEach((s: Any, si: number) => {
    const mine = all.filter(c => c.si === si);
    if (!mine.length || (s.prev && sources.some((o: Any) => !o.prev))) return; // earlier sources only if they score
    take([...mine].sort((x, y) => y.score - x.score)[0]);
    if (s.direct) take(mine[0]);
  });
  // 2) fill the rest by score — but only with passages that are really relevant: every token of sources
  //    stays in the chat history, so the budget is a ceiling, not a target.
  const sorted = [...all].sort((x, y) => y.score - x.score);
  const topBm = Math.max(0, ...all.map((c: Any) => c.bm || 0));
  const cutoff = opts.summary || topBm === 0 ? 0 : topBm * 0.4;
  // Relevant = strong on keywords, or (with an embedding model) close in meaning.
  const relevant = (c: Any) => (c.bm || 0) >= cutoff || (semantic && (c.sem || 0) >= 0.7);
  for (const c of sorted) {
    if (used >= maxChars * 0.97) break;
    if (!relevant(c)) continue;
    take(c);
  }
  // Keep only sentences that carry words of the question (plus each page's opening sentence):
  // the model gets the facts, the chat history does not fill up with filler.
  const qset = new Set(q);
  const dense = (text: string, keepFirst: boolean) => {
    if (opts.summary || !qset.size) return text;
    const sentences = text.split(/(?<=[.!?…])\s+|\n/);
    const keep = sentences.filter((x, i) => (keepFirst && i === 0) || terms(x).some((w: string) => qset.has(w)));
    return keep.length ? keep.join(" ") : text;
  };
  return sources.map((_: Any, si: number) => {
    const mine = all.filter(c => c.si === si && picked.has(c)).sort((x, y) => x.ci - y.ci)
      .map((c: Any) => ({ ...c, t: dense(c.t.replace(/\[\s*(\d+|[a-z]|citation needed|clarification needed|edit)\s*\]/gi, ""), c.ci === 0) }));
    let out = "", last = -2;
    for (const c of mine) { out += (out ? (c.ci === last + 1 ? "\n" : "\n…\n") : "") + c.t; last = c.ci; }
    return out;
  });
}

// ---------- Embedding model (optional, for meaning-based ranking) ----------
// Multilingual models first; the built-in nomic-embed-text v1.5 is English-only.
const MULTILINGUAL_EMBED = /(bge-m3|multilingual|qwen3-embedding|nomic-embed-text-v2|jina-embeddings-v3|gte-multilingual|labse|granite-embedding.*278m|snowflake-arctic-embed-l-v2|paraphrase-multilingual)/i;
let EMBED_CHOICE: { at: number; key: string | null; multi: boolean } | null = null;
async function pickEmbeddingModel(ctl: Any): Promise<{ key: string | null; multi: boolean }> {
  if (EMBED_CHOICE && Date.now() - EMBED_CHOICE.at < 10 * 60_000) return EMBED_CHOICE;
  let key: string | null = null; let multi = false;
  try {
    const list: Any[] = await ctl.client.system.listDownloadedModels("embedding");
    const names = list.map(m => String(m.modelKey || m.path || ""));
    key = names.find(n => MULTILINGUAL_EMBED.test(n)) || null;
    multi = !!key;
    if (!key) key = names.find(n => /nomic-embed-text/i.test(n)) || names[0] || null;
  } catch (e) { ctl.debug("cannot list embedding models", String(e)); }
  EMBED_CHOICE = { at: Date.now(), key, multi };
  return EMBED_CHOICE;
}
/** Query/document prefixes some embedding models are trained with. */
function embedPrefixes(key: string): [string, string] {
  if (/nomic-embed/i.test(key)) return ["search_query: ", "search_document: "];
  if (/(^|[-_/])(multilingual-)?e5([-_.]|$)/i.test(key)) return ["query: ", "passage: "];
  if (/qwen3-embedding/i.test(key)) return ["Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ", ""];
  return ["", ""];
}
/**
 * Cosine similarity between the question and passages, using an embedding model installed in LM Studio.
 * Returns null when no suitable model is installed (the plugin then ranks by keywords only).
 */
async function embeddingSimilarity(ctl: Any, sample: string, signal: Any, status: Any): Promise<Similarity | null> {
  const { key, multi } = await pickEmbeddingModel(ctl);
  if (!key) return null;
  // An English-only model would mis-rank other languages: use it only for English text.
  if (!multi && /[^\x00-\x7F’“”—–…€£°±×]/.test(sample.replace(URL_RE, ""))) return null;
  return async (query: string, texts: string[]) => {
    const sub = status.addSubStatus({ status: "loading", text: `${t("Ранжирую по смыслу", "Ranking by meaning")} (${key.split("/").pop()})…` });
    try {
      const model = await ctl.client.embedding.model(key, { signal, ttl: 300 });
      const [qp, dp] = embedPrefixes(key);
      let timer: Any;
      const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("embedding timeout")), 30_000); });
      const res: Any[] = await Promise.race([model.embed([qp + query, ...texts.map(x => dp + x.slice(0, 1500))]), timeout]).finally(() => clearTimeout(timer)) as Any[];
      const vecs: number[][] = res.map(r => r.embedding);
      const norm = (v: number[]) => Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
      const qv = vecs[0]; const qn = norm(qv);
      const sims = vecs.slice(1).map(v => v.reduce((a, x, i) => a + x * qv[i], 0) / (norm(v) * qn));
      sub.setState({ status: "done", text: `${t("Ранжировано по смыслу", "Ranked by meaning")} (${key.split("/").pop()})` });
      return sims;
    } catch (e) {
      ctl.debug("embedding ranking failed", String(e));
      sub.setState({ status: "canceled", text: t("Ранжирование по смыслу недоступно — беру ключевые слова", "Meaning-based ranking unavailable — using keywords") });
      return null;
    }
  };
}

function stripThink(s: Any) {
  return String(s || "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*<\/think>/, "").trim();
}

function parseQueries(raw: Any) {
  return stripThink(raw).split("\n")
    .map((l: Any) => l.replace(/^[\s\-*\d.)"«»]+/, "").replace(/["»]$/, "").trim())
    .filter((l: Any) => l.length > 3 && l.length < 160 && !/no_think|<\/?think|^(запрос|query|вопрос)\s*[:：]?$/i.test(l))
    .map((l: Any) => l.replace(/^(запрос|query)\s*\d*\s*[:：]\s*/i, ""))
    .slice(0, 4);
}

// LM Studio's local server address (the user may have changed the port).
let API_BASE = "";
function apiBase() {
  if (API_BASE) return API_BASE;
  let port = 1234;
  try {
    const fs = require("node:fs"); const path = require("node:path");
    const cfg = JSON.parse(fs.readFileSync(path.join(lmsHome(), ".internal", "http-server-config.json"), "utf8"));
    if (Number(cfg.port) > 0) port = Number(cfg.port);
  } catch { /* default port */ }
  API_BASE = `http://127.0.0.1:${port}`;
  return API_BASE;
}

// One short answer from the loaded model, as fast as possible (no reasoning).
async function quickAnswer(ctl: Any, prompt: Any, signal: Any, maxTokens = 160): Promise<{ text: string; reasoning: string }> {
  let modelKey = "";
  try {
    const model = await ctl.client.llm.model(undefined, { signal });
    modelKey = model.identifier || model.modelKey || "";
  } catch (e) { ctl.debug("no loaded model", String(e)); return { text: "", reasoning: "" }; }
  const api = `${apiBase()}/v1`;
  const post = (path: Any, body: Any, ms = 120000) => fetchWithTimeout(`${api}${path}`, ms, signal, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: modelKey, stream: false, temperature: 0.2, ...body }),
  });
  // 1) Raw completion with the thinking block already closed: reasoning models answer in seconds
  //    instead of spending the whole budget on thinking (chat_template_kwargs is ignored by some MLX builds).
  const raw = /qwen|bonsai|qwq/i.test(modelKey)
    ? { prompt: `<|im_start|>user\n${prompt}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`, stop: ["<|im_end|>", "<|im_start|>"] }
    : /gemma/i.test(modelKey)
      ? { prompt: `<start_of_turn>user\n${prompt}<end_of_turn>\n<start_of_turn>model\n`, stop: ["<end_of_turn>", "<start_of_turn>"] }
      : null;
  if (raw) {
    try {
      const r = await post("/completions", { ...raw, max_tokens: maxTokens }, 60000);
      if (r.ok) {
        const d: Any = await r.json();
        const text = stripThink(d?.choices?.[0]?.text || "");
        if (text.trim()) return { text, reasoning: "" };
      }
    } catch (e) { ctl.debug("raw completion failed", String(e)); }
  }
  // 2) Chat API (works for any model; reasoning models may spend tokens thinking first).
  try {
    const r = await post("/chat/completions", { max_tokens: Math.max(700, maxTokens), chat_template_kwargs: { enable_thinking: false }, reasoning_effort: "none", messages: [{ role: "user", content: prompt }] });
    if (r.ok) {
      const d: Any = await r.json();
      const m = d?.choices?.[0]?.message || {};
      return { text: stripThink(m.content || ""), reasoning: String(m.reasoning_content || "") };
    }
  } catch (e) { ctl.debug("chat completion failed", String(e)); }
  // 3) Server off: ask the model through the SDK connection the plugin already has.
  try {
    const model = await ctl.client.llm.model(undefined, { signal });
    const res = await model.respond([{ role: "user", content: prompt + "\n\n/no_think" }], { maxTokens: Math.max(400, maxTokens), temperature: 0.2, signal });
    return { text: stripThink(res.nonReasoningContent ?? res.content ?? ""), reasoning: String(res.reasoningContent || "") };
  } catch (e) { ctl.debug("SDK completion failed", String(e)); }
  return { text: "", reasoning: "" };
}

async function llmQueries(ctl: Any, prompt: Any, signal: Any) {
  const { text, reasoning } = await quickAnswer(ctl, prompt, signal, 160);
  const q = parseQueries(text);
  if (q.length) return q;
  // The model kept thinking: salvage quoted queries from its reasoning.
  const quoted = [...reasoning.matchAll(/["«“]([^"»”\n]{6,100})["»”]/g)].map(x => x[1]);
  return parseQueries([...new Set(quoted)].slice(-4).join("\n")).slice(0, 3);
}

const VISUAL_RE = /(?<![\p{L}\p{N}])(как выгляд|выглядит|фото(?!синтез)|фотк|картин|изображен|покажи|схем|диаграм|график|логотип|карт[аеуы](?!\p{L})|скриншот|внешн(?:ий|его|ему|им|ем) вид|внешност|какого цвета|дизайн|интерьер|look(s)? like|photo(?!synth)|picture|images?(?![\p{L}])|logos?(?![\p{L}])|\bmap\b|chart|diagram|screenshot|design|what colou?r|appearance|show me)/iu;
// When is it worth for the MODEL to look at pictures: the answer depends on what is visible.
const SEE_RE = /(?<![\p{L}\p{N}])(как выгляд|выглядит|какого цвета|цвет|форм[аы]|отлича|сравни|похож|узнай|опознай|что это за|что на (фото|картинк)|график|диаграм|схем|карт[аеуы](?!\p{L})|инфограф|таблиц|скриншот|интерфейс|расписан|планировк|look(s)? like|colou?r|shape|difference|compare|similar|identify|which \w+ is (this|that)|^\s*(what is (this|that)|что это( такое)?)\s*\??\s*$|chart|graphs?(?![\p{L}])|diagram|\bmap\b|infographic|tables?(?![\p{L}])|screenshot|interface|layout|floor plan|schedule)/iu;
// When illustrations add nothing: code, math, text work, abstract questions.
const ABSTRACT_RE = /(?<![\p{L}\p{N}])(код|функци|ошибк|баг|скрипт|формул|уравнен|посчита|вычисл|переведи|перевод|граммат|определени|синоним|напиши (письмо|текст|стих|пост)|code|function|error|bug|script|regex|sql|python|javascript|typescript|formula|equation|calculate|compute|translate|grammar|definition|synonym|write (a|an) (letter|email|poem|post|essay))/iu;
// Topics where pictures carry a lot: more illustrations in the answer.
const RICH_RE = /(?<![\p{L}\p{N}])(новост|событи|протест|движени|революц|фестивал|концерт|чемпионат|олимпи|матч|выбор|войн|катастроф|архитектур|здани|собор|храм|замок|дворец|музей|памятник|город|страна|путешеств|природ|животн|птиц|рыб|растени|цвет[оы]к|гор[аы]|озер|остров|пляж|космос|планет|искусств|картин[аы]|скульптур|мода|ед[аы](?!\p{L})|блюд|рецепт|машин|автомобил|самол[её]т|корабл|news|event|protest|movement|revolution|festival|concert|championship|olympic|match|election|wars?(?![\p{L}])|disaster|architect|building|cathedral|church|temple|castle|palace|museum|monument|city|country|travel|nature|animal|bird|fish|plant|flower|mountain|lake|island|beach|space|planet|galaxy|arts?(?![\p{L}])|painting|sculpture|fashion|food|dish|recipe|cars?(?![\p{L}])|aircraft|plane|ships?(?![\p{L}])|landmark|wonder)/iu;
const COMPARE_RE = /(?<![\p{L}\p{N}])(сравни|похож|similar|compare|find (more|other) (pictures|images|photos))/iu;

async function isVisionModel(ctl: Any) {
  try {
    const m = await ctl.client.llm.model();
    const info: Any = await m.getModelInfo();
    if (typeof info?.vision === "boolean") return info.vision;
    const id = info?.identifier || info?.modelKey;
    if (id) {
      const r = await fetchWithTimeout(`${apiBase()}/api/v0/models/${encodeURIComponent(id)}`, 5000, undefined);
      if (r.ok) return ((await r.json()) as Any).type === "vlm";
    }
  } catch { /* */ }
  return false;
}

/**
 * Two separate jobs for web pictures:
 *  - show: illustrate the answer (any model): pictures are saved in the chat's working directory,
 *    because LM Studio renders Markdown images only from there (by bare file name);
 *  - see:  attach them to the message so a vision model can look at them.
 */
async function gatherImages(ctl: Any, settings: Any, imageLinks: string[], pages: Any[], question: string, search: boolean, mode: { show: boolean; see: boolean; vet?: boolean }, signal: Any, status: Any) {
  const empty = { files: [] as Any[], notes: [] as string[], shows: [] as string[] };
  const cands: Any[] = mode.see ? imageLinks.map(u => ({ img: u, page: u, title: t("картинка из сообщения", "image from the message"), pasted: true })) : [];
  for (const p of pages) for (const img of (p.images || []).slice(0, 3)) cands.push({ img, page: p.url, title: p.title });
  if (search && cands.length < settings.maxImages * 2) {
    for (const x of (await searchImages(settings, question, signal, () => {})).slice(0, 8)) cands.push(x);
  }
  const seen = new Set<string>();
  const uniq = cands.filter(c => { const k = c.img.split("?")[0]; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, settings.maxImages * 3);
  if (!uniq.length) return empty;
  const sub = status.addSubStatus({ status: "loading", text: t("Подбираю картинки…", "Picking pictures…") });
  if (signal?.aborted) return empty;
  const fetched = await Promise.all(uniq.map(async c => ({ c, img: signal?.aborted ? null : await reader.imageForVision(c.img) })));
  if (signal?.aborted) { sub.setState({ status: "canceled", text: t("Остановлено", "Stopped") }); return empty; }
  // Same photo on several pages (e.g. Wikipedia in two languages): keep one.
  const seenHashes: string[] = [];
  let ready = fetched.filter(({ img }) => {
    if (!img) return false;
    if (img.hash && seenHashes.some(h => [...h].filter((b, i) => b !== img.hash![i]).length <= 6)) return false;
    if (img.hash) seenHashes.push(img.hash);
    return true;
  });
  // A vision model looks at the candidates in a separate call (not kept in the chat): it drops logos, banners
  // and off-topic pictures and says what each kept one shows, so it places them sensibly in the answer.
  let vetted = false;
  if (mode.vet && ready.length > 1) {
    const pool = ready.slice(0, 6); // every picture costs the vision model a few seconds
    sub.setState({ status: "loading", text: t("Модель просматривает картинки…", "The model is checking the pictures…") });
    const verdicts = await vetPictures(ctl, question, await Promise.all(pool.map(r => reader.shrinkB64(r.img!.b64, 448))), signal, mode.see);
    if (verdicts) {
      ready = pool.filter((r, i) => r.c.pasted || (verdicts[i]?.keep !== false && !/(?<!\p{L})(similar|same|duplicate|identical|похож|такая же|дубл)/iu.test(verdicts[i]?.caption || "")
        && !/(\btext on\b|\bword\b|\btitle card\b|\blogo\b|typograph|\bbanner\b|\bonly text\b|text-only|\bwatermark\b|надпись|логотип)/i.test(verdicts[i]?.caption || "")))
        .map((r) => { const v = verdicts[pool.indexOf(r)]; return v?.caption ? { ...r, c: { ...r.c, title: v.caption.split(/[.;:]/)[0].slice(0, 90), seen: v.caption } } : r; });
      vetted = true;
    }
  }
  const files: Any[] = []; const notes: string[] = []; const shows: string[] = [];
  let wd = "";
  if (mode.show) { try { wd = String(ctl.getWorkingDirectory() || ""); } catch { /* no working directory */ } }
  const stamp = Date.now();
  let count = 0;
  for (const { c, img } of ready) {
    if (!img || count >= settings.maxImages) continue;
    // The model already looked at vetted pictures: their descriptions go in as text (a few dozen tokens)
    // instead of attaching the images (hundreds of tokens each, kept in the chat history).
    const forSee = mode.see && (c.pasted || (!vetted && files.length < run().seeBudget));
    if (!forSee && shows.length >= settings.maxImages) continue;
    if (!forSee && !(mode.show && !c.pasted)) continue;
    count++;
    const alt = String(c.title || "picture").replace(/[\[\]]/g, "").slice(0, 80);
    // No page URL here: small models then paste the page URL instead of the picture file name.
    notes.push(`Picture ${count}: ${c.seen ? `(you looked at it) ${c.seen}` : alt} (from ${hostOf(c.page)})`);
    if (forSee) {
      try { files.push(await ctl.client.files.prepareImageBase64(`web-image-${count}.jpg`, img.b64)); } catch (e) { ctl.debug("prepareImage failed", String(e)); }
    }
    if (mode.show && !c.pasted) {
      let shown = false;
      if (wd) {
        try {
          const fs = require("node:fs"); const path = require("node:path");
          const name = `web-${stamp}-${count}.jpg`;
          // A small preview for the chat: LM Studio shows pictures at their natural size.
          fs.writeFileSync(path.join(wd, name), Buffer.from(await reader.shrinkB64(img.b64, 420), "base64"));
          shows.push(`![${alt}](${name})`);
          shown = true;
        } catch (e) { ctl.debug("cannot save picture to the working directory", String(e)); }
      }
      if (!shown) shows.push(`🖼️ [${alt}](${c.img})`);
    }
  }
  const label = mode.see && mode.show ? t("Картинки: в ответе и для модели", "Pictures: in the answer and for the model")
    : mode.see ? t("Картинки для модели", "Pictures for the model") : t("Картинки для ответа", "Pictures for the answer");
  sub.setState({ status: count ? "done" : "canceled", text: count ? `${label}: ${count}` : t("Подходящих картинок не нашлось", "No suitable pictures found") });
  return { files, notes, shows };
}

/** Shows candidate pictures to the vision model in a separate call; returns keep/drop + a short caption for each. */
async function vetPictures(ctl: Any, question: string, b64s: string[], signal: Any, detailed = false): Promise<{ keep: boolean; caption: string }[] | null> {
  try {
    const m = await ctl.client.llm.model(undefined, { signal });
    const content: Any[] = [{ type: "text", text:
      `Question: "${question.slice(0, 200)}". Below are ${b64s.length} pictures found on the web for an illustrated answer. ` +
      `Judge every picture: KEEP if it is a real photo or illustration that fits the question, DROP if it is off-topic, a logo, banner, icon, ` +
      `advertisement, text-only graphic or nearly the same as another kept picture. A picture whose main content is text, a word, a title or a logo, or a stock photo covered with watermarks, is always DROP. ` +
      `Reply with one line per picture, in order, using its number, like:\n` +
      `1: KEEP — a grey long-haired cat on a sofa\n2: DROP — website logo\n` +
      (detailed ? `For KEEP pictures describe what is visible (up to 25 words: shapes, colours, materials, notable features) — this description replaces the picture later.\n`
        : `Keep every description under 12 words.\n`) +
      `/no_think` }];
    b64s.forEach((b, i) => { content.push({ type: "text", text: `Picture ${i + 1}:` }); content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b}` } }); });
    const r = await fetchWithTimeout(`${apiBase()}/v1/chat/completions`, 120000, signal, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: m.identifier || m.modelKey, max_tokens: (detailed ? 45 : 22) * b64s.length + 60, temperature: 0.1, stream: false,
        chat_template_kwargs: { enable_thinking: false }, reasoning_effort: "none", reasoning: { effort: "none" }, messages: [{ role: "user", content }] }),
    });
    if (!r.ok) return null;
    const d: Any = await r.json();
    const msg = d?.choices?.[0]?.message || {};
    // Some models still think first: the verdict lines may then sit in the reasoning text.
    const text = stripThink(msg.content || "") + "\n" + String(msg.reasoning_content || "");
    const out: { keep: boolean; caption: string }[] = b64s.map(() => ({ keep: true, caption: "" }));
    let parsed = 0; let seq = 0;
    for (const line of text.split("\n")) {
      const mm = line.match(/(?:picture\s*)?(\d+|N)?\s*[:.)]?\s*\**\s*(KEEP|DROP)\**\s*[—–\-:]*\s*(.*)/i);
      if (!mm) continue;
      const i = mm[1] && /\d/.test(mm[1]) ? Number(mm[1]) - 1 : seq; // some models write "N:" literally: take the order
      seq = i + 1;
      if (i >= 0 && i < out.length) { out[i] = { keep: /keep/i.test(mm[2]), caption: /keep/i.test(mm[2]) ? mm[3].replace(/[\[\]*]/g, "").trim().slice(0, detailed ? 260 : 90) : "" }; parsed++; }
    }
    return parsed ? out : null;
  } catch (e) { ctl.debug("picture check failed", String(e)); return null; }
}

/** Names what is in a picture the user attached, so the web search can look for it. */
async function describeAttachedImage(ctl: Any, file: Any, signal: Any): Promise<string> {
  try {
    const fs = require("node:fs");
    const p = await file.getFilePath();
    const buf: Buffer = fs.readFileSync(p);
    if (buf.length > 8 * 1024 * 1024) return "";
    const mime = /\.png$/i.test(p) ? "image/png" : /\.webp$/i.test(p) ? "image/webp" : "image/jpeg";
    const m = await ctl.client.llm.model(undefined, { signal });
    const r = await fetchWithTimeout(`${apiBase()}/v1/chat/completions`, 60000, signal, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: m.identifier || m.modelKey, max_tokens: 40, temperature: 0.1, stream: false,
        chat_template_kwargs: { enable_thinking: false },
        messages: [{ role: "user", content: [
          { type: "text", text: "Name what is shown in this picture in a few words (object, species, place, product, artwork or visible text). Only the name. /no_think" },
          { type: "image_url", image_url: { url: `data:${mime};base64,${buf.toString("base64")}` } },
        ] }],
      }),
    });
    if (!r.ok) return "";
    const d: Any = await r.json();
    return stripThink(d?.choices?.[0]?.message?.content || "").replace(/\s+/g, " ").trim().slice(0, 120);
  } catch (e) { ctl.debug("cannot describe the attached picture", String(e)); return ""; }
}

/** Probability of "WEB" vs "NO" at the answer token, from the chat API's logprobs; null if the server gives none. */
function webProbability(lp: Any): number | null {
  try {
    // Chat API: content[0].top_logprobs[{token, logprob}]; completions API: top_logprobs[0] = {token: logprob}.
    // The first answer token that is WEB or NO (some templates emit whitespace or a quote first).
    const first = (lp?.content || []).find((c: Any) => /^\W*(W|WE|WEB|N|NO)\b/i.test(String(c.token).trim()) && c.top_logprobs?.length);
    const alts: { token: string; logprob: number }[] = first?.top_logprobs || [];
    if (!alts.length) return null;
    let web = 0, no = 0;
    for (const a of alts) {
      const tok = String(a.token).trim().toUpperCase(); const p = Math.exp(a.logprob);
      if (tok && "WEB".startsWith(tok)) web += p; else if (tok && "NO".startsWith(tok)) no += p;
    }
    return web + no > 0.05 ? web / (web + no) : null;
  } catch { return null; }
}

// "Smart" mode: the model itself decides whether the question needs a web check.
async function needsWeb(ctl: Any, question: Any, signal: Any): Promise<boolean | null> {
  const today = new Date().toISOString().slice(0, 10);
  const prompt =
    `Today is ${today}. Decide if answering the message below needs checking the internet.\n` +
    `Answer WEB if it asks about: current or recent events, news, people in office, prices, rates, scores, weather, ` +
    `releases, specific facts or numbers you may not know exactly, anything that may have changed after your training, ` +
    `or anything you are not sure about. Answer NO for: chit-chat, opinions, creative writing, coding, math, translation, ` +
    `rewriting given text, general well-known knowledge.\nReply with exactly one word: WEB or NO.\n\nMessage: ${question}`;
  // 1) Token probabilities (LM Studio's chat API reports them): an unsure "NO" still searches. A needless web
  //    check costs a few seconds; a confident wrong answer costs the user.
  try {
    const m = await ctl.client.llm.model(undefined, { signal });
    const r = await fetchWithTimeout(`${apiBase()}/v1/chat/completions`, 30000, signal, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: m.identifier || m.modelKey, stream: false, temperature: 0, max_tokens: 6, logprobs: true, top_logprobs: 5,
        chat_template_kwargs: { enable_thinking: false }, reasoning_effort: "none", messages: [{ role: "user", content: prompt }] }),
    });
    if (r.ok) {
      const pWeb = webProbability(((await r.json()) as Any)?.choices?.[0]?.logprobs);
      if (pWeb !== null) { ctl.debug(`smart mode: P(web) = ${pWeb.toFixed(2)}`); return pWeb >= 0.25; }
    }
  } catch (e) { ctl.debug("logprob routing unavailable", String(e)); }
  // 2) The plain one-word answer.
  const { text } = await quickAnswer(ctl, prompt, signal, 4);
  if (/\bWEB\b/i.test(text)) return true;
  if (/\bNO\b/i.test(text)) return false;
  return null; // undecided: caller falls back to keywords
}

function lastAnswerUrls(history: Any) {
  // URLs cited in the most recent assistant answer: the sources a follow-up question is about.
  try {
    const msgs = history.getMessagesArray();
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (typeof m.getRole === "function" && m.getRole() !== "assistant") continue;
      const urls = (m.getText() || "").match(URL_RE) || [];
      if (urls.length) return [...new Set(urls.map((u: Any) => u.replace(/[.,;:!?»]+$/, "")))].slice(0, 8);
    }
  } catch { /* ignore */ }
  return [];
}
/** A follow-up: shares enough words with the pages behind the last answer, or refers back to them. */
function looksLikeFollowUp(prevPages: Any[], question: string): boolean {
  if (!prevPages.length) return false;
  const n = new Set(words(question).filter(w => !STOP.has(w))).size;
  const hits = overlap(prevPages, question);
  if (!hits) return false;
  if (n <= 4) return true;
  const refersBack = /(?<![\p{L}])(они|он|она|оно|их|его|её|ее|им|там|тогда|этот|эта|это|эти|этого|этих|такой|такие|they|them|their|it|its|there|then|this|that|these|those|he|she|his|her)(?![\p{L}])/iu.test(question)
    || /^\s*(а|и|но|ещё|еще|а что|а как|а почему|and|but|also|what about|how about|why)(?![\p{L}])/iu.test(question);
  return hits / n >= 0.4 || (refersBack && hits / n >= 0.2);
}
/** Numbered sources of the most recent research block in this chat (for the follow-up pointer). */
function previousSources(conv: Any): { n: number; url: string; title: string }[] {
  try {
    const texts: string[] = [];
    for (const msg of (conv?.messages || []).slice(0, -1)) {
      const v = msg.versions?.[msg.currentlySelected ?? 0] || msg.versions?.[0] || {};
      for (const c of (v.preprocessed?.content || v.content || [])) if (c.type === "text" && String(c.text).includes("<web_research")) texts.push(String(c.text));
    }
    const last = texts.pop() || "";
    const block = last.slice(last.lastIndexOf("<web_research"));
    const out: { n: number; url: string; title: string }[] = [];
    for (const m of block.matchAll(/^\[(\d+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\) ([^\n]+)$/gm)) out.push({ n: Number(m[1]), url: m[2], title: m[3].replace(/ \(\d{4}-\d{2}-\d{2}\)$/, "") });
    return out.slice(0, 12);
  } catch { return []; }
}
async function cachedPage(url: Any) {
  if (!(await shareable(url))) return null;
  const k = normUrl(url);
  for (const prefix of ["extract:", "page:", "render:", "wayback:"]) {
    const v = cache.get(prefix + k);
    if (v && v.text) return { url, title: v.title || hostOf(url), text: v.text };
  }
  return null;
}
const TIME_WORDS: [RegExp, string][] = [
  [/((?:^|\s)\/day\b|(?<![\p{L}])за (сегодня|сутки|последние сутки|день)(?![\p{L}])|past 24|last 24|today'?s)/iu, "day"],
  [/((?:^|\s)\/week\b|(?<![\p{L}])за (эту |последнюю )?неделю(?![\p{L}])|this week|past week|last week)/iu, "week"],
  [/((?:^|\s)\/month\b|(?<![\p{L}])за (этот |последний )?месяц(?![\p{L}])|this month|past month|last month)/iu, "month"],
  [/((?:^|\s)\/year\b|(?<![\p{L}])за (этот |последний )?год(?![\p{L}])|this year|past year|last year)/iu, "year"],
];
function seenUrlsFromHistory(history: Any) {
  const seen = new Set();
  try {
    for (const m of history.getMessagesArray()) {
      for (const u of (m.getText() || "").match(URL_RE) || []) seen.add(normUrl(u));
    }
  } catch { /* ignore */ }
  return seen;
}

// Balanced parentheses stay in the URL (https://en.wikipedia.org/wiki/Mercury_(planet)); a closing one after it does not.
const URL_RE = /https?:\/\/(?:[^\s<>"'`()\[\]]|\([^\s()<>]*\))+/gi;
const GENERIC_SUMMARY = /(?<![\p{L}\p{N}])(переска|вытян|кратк|вкратце|суть|о ч[её]м|резюм|конспект|основн|главн|полезн|summar|tl;?dr|what.{0,20}about|overview|key points|main points|explain this|gist)/iu;
const SEARCH_ALSO = /(?<![\p{L}\p{N}])(найди|поищи|загугли|погугли|поиск|сравни|провер|что пишут|другие источники|search|google|compare|verify|fact.?check)/iu;
function extractUrls(text: Any): string[] {
  return [...new Set<string>((text.match(URL_RE) || []).map((u: string) => u.replace(/[.,;:!?»]+$/, "")))].slice(0, 5);
}
function hostOf(u: Any) { try { return new URL(u).host.replace(/^www\./, ""); } catch { return u; } }
function ogImage(html: Any, base: Any): string[] {
  const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i);
  if (!m) return [];
  try { return [new URL(decodeEntities(m[1]), base).href]; } catch { return []; }
}
function titleOf(html: Any, fallback: Any) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const t = m ? decodeEntities(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() : "";
  return t || fallback;
}
function internalLinks(links: Any, base: Any, q: Any) {
  const b = new URL(base);
  const kws = keywords(q);
  const seen = new Set([normUrl(base)]);
  const out: Any[] = [];
  let i = 0;
  for (const l of links) {
    let u; try { u = new URL(l.url, b); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || u.host !== b.host) continue;
    if (/\.(pdf|jpe?g|png|gif|svg|webp|zip|mp4|mp3|css|js|xml|ico)(\?|$)/i.test(u.pathname)) continue;
    if (/(login|signin|signup|register|cart|account|privacy|cookie|wp-admin|feed|tag\/|replytocom|mailto:)/i.test(u.href)) continue;
    u.hash = "";
    const k = normUrl(u.href);
    if (seen.has(k)) continue;
    seen.add(k);
    const text = String(l.title || "").trim();
    const hay = (text + " " + u.pathname).toLowerCase();
    const score = kws.filter(w => hay.includes(w)).length * 3 + (text.length > 3 ? 1 : 0) - u.pathname.split("/").filter(Boolean).length * 0.2 - (i++) * 0.01;
    out.push({ url: u.href, title: text || u.pathname, score });
  }
  return out.sort((a, b) => b.score - a.score);
}
async function readDirect(url: Any, signal: Any, status: Any) {
  const host = hostOf(url);
  const sub = status.addSubStatus({ status: "loading", text: `${t("Открываю", "Opening")}: ${url.slice(0, 80)}` });
  const finish = (page: Any, links: Any, how: Any) => {
    page.text = page.text.slice(0, PAGE_CAP);
    page.direct = true;
    sub.setState({ status: "done", text: `${t("Прочитано", "Read")}${how}: ${page.title.slice(0, 60)} · ${host}` });
    return { page, links };
  };
  const fromService = async (endpoint: string) => {
    const b = await service(endpoint, url);
    if (!b || b.text.length <= 100) return null;
    const links = (b.links || []).map((l: Any) => ({ url: l.url, title: l.text }));
    const text = (b.description && b.kind === "page" ? b.description + "\n" : "") + b.text;
    return finish({ url: b.url || url, title: b.title || host, text, images: b.images || [], date: shortDate(b.published, url) }, links, kindLabel(b.kind) + (b.fromCache ? t(" (из кэша)", " (cached)") : ""));
  };
  // PDFs and videos have their own readers.
  if (SPECIAL_RE.test(url)) { const d = await fromService("extract"); if (d) return d; }
  try {
    // Fast path: plain download + main-content extraction; the browser only for JavaScript apps and bot walls.
    const resp = await reader.get(url, {}, 20000, signal);
    const ct = resp.headers.get("content-type") || "";
    if (/application\/pdf/i.test(ct)) { const d = await fromService("extract"); if (d) return d; throw new Error("PDF could not be read"); }
    if (!resp.ok || !/html|text|json|xml/.test(ct)) { resp.body?.cancel().catch(() => {}); throw new Error(resp.ok ? `type ${ct}` : `HTTP ${resp.status}`); }
    const raw = await reader.readText(resp, 3_000_000);
    const isHtml = /html/.test(ct) || /<html|<body/i.test(raw.slice(0, 2000));
    const finalUrl = resp.url || url;
    if (!isHtml) {
      const text = raw.replace(/\s+\n/g, "\n");
      if (text.length < 50) throw new Error("empty page");
      return finish({ url: finalUrl, title: host, text, images: [] }, [], "");
    }
    const ex = await reader.extractHtml(raw, finalUrl);
    const text = ex && ex.text.length >= 200 ? ex.text : htmlToText(raw, 15);
    const title = ex?.title || titleOf(raw, host);
    if (text.length < 600 || reader.isBlockedPage(titleOf(raw, ""), text)) {
      sub.setState({ status: "loading", text: `${t("Открываю в браузере", "Opening in browser")}: ${url.slice(0, 70)}` });
      const d = await fromService("render");
      if (d) return d;
      if (reader.isBlockedPage(titleOf(raw, ""), text)) throw new Error("bot wall");
    }
    if (text.length < 50) throw new Error("empty page");
    const desc = ex?.description && !text.startsWith(ex.description.slice(0, 40)) ? ex.description + "\n" : "";
    return finish({ url: finalUrl, title, text: desc + text, images: ex?.images?.length ? ex.images : ogImage(raw, finalUrl), date: shortDate(ex?.published, finalUrl) }, linksFromHtml(raw, finalUrl), "");
  } catch (e) {
    if (signal?.aborted) { sub.setState({ status: "canceled", text: t("Остановлено", "Stopped") }); return null; }
    const d = (!SPECIAL_RE.test(url) && await fromService("extract")) || await fromService("wayback");
    if (d) return d;
    sub.setState({ status: "canceled", text: `${t("Не открылось", "Failed")}: ${url.slice(0, 60)} (${String(e).slice(0, 60)})` });
    return null;
  }
}
function linksFromHtml(html: Any, base: Any) {
  const out: Any[] = [];
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { out.push({ url: new URL(decodeEntities(m[1]), base).href, title: decodeEntities(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() }); } catch { /* skip */ }
  }
  return out;
}

async function research(ctl: Any, userMessage: Any) {
  const cfg = ctl.getPluginConfig(configSchematics);
  let gcfg: Any = { get: () => undefined };
  try { gcfg = ctl.getGlobalPluginConfig(globalConfigSchematics); } catch { /* older LM Studio */ }
  const settings = {
    mode: cfg.get("mode"), depth: parseInt(String(cfg.get("depth") ?? "2"), 10) || 2,
    reading: cfg.get("reading") || "auto",
    pages: ({ light: 3, normal: 6, heavy: 10, auto: 6 } as Any)[cfg.get("reading") || "auto"] || 6,
    maxChars: (({ light: 8000, normal: 16000, heavy: 32000, auto: 24000 } as Any)[cfg.get("reading") || "auto"] || 16000),
    answerStyle: cfg.get("answerStyle") || "balanced", history: cfg.get("history") || "auto", sourcesList: cfg.get("sourcesList") !== false,
    searxngUrl: String(gcfg.get("searxngUrl") || "").trim(),
    tavilyKey: String(gcfg.get("tavilyKey") || "").trim(), braveKey: String(gcfg.get("braveKey") || "").trim(), ollamaKey: String(gcfg.get("ollamaKey") || "").trim(),
    ranking: String(gcfg.get("ranking") || "auto"),
    pictures: cfg.get("pictures") || "auto", see: cfg.get("see") || "auto", maxImages: 3,
    cacheMinutes: gcfg.get("cacheMinutes") ?? 60,
  };
  let userPrompt = userMessage.getText().trim();
  if (!userPrompt) return userMessage;
  run().lang = /[а-яё]/i.test(userPrompt.replace(/https?:\/\/\S+/g, "")) ? "ru" : "en";
  if (/(^|\s)\/noweb\b/i.test(userPrompt)) return userPrompt.replace(/(^|\s)\/noweb\b/gi, " ").replace(/\s{2,}/g, " ").trim();
  // Small talk never needs the web, even in "always" mode.
  if (userPrompt.length < 40 && /^(привет|здравствуй|спасибо|благодарю|ок(ей)?|ладно|понятно|хорошо|как дела|пока|hi|hello|hey|thanks|thank you|ok(ay)?|got it|bye)(?![\p{L}\p{N}])[\s!.?,)]*$/iu.test(userPrompt)) return userMessage;
  const allUrls = extractUrls(userPrompt);
  const imageLinks = allUrls.filter((u: Any) => reader.IMAGE_URL_RE.test(u));
  const directUrls = allUrls.filter((u: Any) => !reader.IMAGE_URL_RE.test(u));
  // Cache commands: /fresh (or /nocache) ignores cached data for this message, /clearcache empties it.
  const fresh = /(^|\s)\/(fresh|nocache)\b/i.test(userPrompt);
  if (/(^|\s)\/clearcache\b/i.test(userPrompt)) {
    cache.clear();
    ctl.createStatus({ status: "done", text: t("Веб-ресёрч: кэш очищен", "Web research: cache cleared") });
    userPrompt = userPrompt.replace(/(^|\s)\/clearcache\b/gi, " ").trim();
    if (!userPrompt) return "(The user cleared the web research cache. Confirm it in one short sentence.)";
  }
  userPrompt = userPrompt.replace(/(^|\s)\/(fresh|nocache)\b/gi, " ").trim();
  run().timeRange = ""; run().searchProblem = "";
  // Links the user typed may point to their own network (a NAS, a dev server); links found on the web may not.
  const typedHosts = reader.hostScope.getStore();
  for (const u of allUrls) {
    try { const h = new URL(u).hostname.replace(/^\[|\]$/g, "").toLowerCase(); if (reader.isLocalName(h)) typedHosts?.add(h); } catch { /* */ }
  }
  for (const [re, range] of TIME_WORDS) if (re.test(userPrompt)) { run().timeRange = range; break; }
  userPrompt = userPrompt.replace(/(^|\s)\/(day|week|month|year)\b/gi, "$1").replace(/\s{2,}/g, " ").trim();
  CACHE_MS = (settings.cacheMinutes ?? 60) * 60_000;
  cache.enabled = CACHE_MS > 0;
  run().fresh = fresh;
  run().freshSearch = run().timeRange === "day" || /(?<![\p{L}\p{N}])(новост|сегодня|сейчас|курс|цена|цены|стоимост|погод|счёт матча|счет матча|news|today|now(?![\p{L}])|live(?![\p{L}])|prices?(?![\p{L}])|rates?(?![\p{L}])|weather|score)/iu.test(userPrompt);
  const hits0 = cacheStats.hits;
  // Follow-up memory: pages behind the previous answer's citations, still in the cache.
  const history = await ctl.pullHistory();
  const prevPages = (await Promise.all(lastAnswerUrls(history).map(cachedPage))).filter(Boolean) as Any[];
  let followUpOnly = false;
  // /web forces a web check in any mode.
  const forceWeb = /(^|\s)\/web\b/i.test(userPrompt);
  userPrompt = userPrompt.replace(/(^|\s)\/web\b/gi, " ").trim();
  // Pictures attached to the message by the user: the model sees them anyway (LM Studio passes them).
  // For research, the model first names what is in the picture, so the web search looks for that.
  let attached: Any[] = [];
  try { attached = (userMessage.getFiles?.(ctl.client) || []).filter((f: Any) => f.isImage?.() || f.type === "image"); } catch { /* */ }
  let attachedCaption = "";
  if (attached.length && userPrompt.trim()) attachedCaption = await describeAttachedImage(ctl, attached[0], ctl.abortSignal);

  // Only picture links and no reason to search: just hand the pictures to a vision model.
  if (imageLinks.length && !directUrls.length && !forceWeb && settings.mode !== "always" && !AUTO_TRIGGERS.test(userPrompt.replace(URL_RE, " "))) {
    if (settings.see !== "off" && await isVisionModel(ctl)) {
      const st = ctl.createStatus({ status: "loading", text: t("Веб-ресёрч: картинки из сообщения", "Web research: pictures from the message") });
      const g = await gatherImages(ctl, settings, imageLinks, [], "", false, { show: false, see: true }, ctl.abortSignal, st);
      run().pendingFiles = g.files;
      st.setState({ status: g.files.length ? "done" : "canceled", text: g.files.length ? `${t("Веб-ресёрч: картинок передано модели", "Web research: pictures passed to the model")} — ${g.files.length}` : t("Веб-ресёрч: картинку не удалось загрузить", "Web research: could not load the picture") });
    }
    return userMessage;
  }
  if (!forceWeb && !directUrls.length && settings.mode !== "always") {
    // "What does it look like" questions need pictures from the web, even when the model knows the facts.
    const keywordHit = AUTO_TRIGGERS.test(userPrompt) || (!attached.length && (settings.pictures !== "off" || settings.see !== "off") && VISUAL_RE.test(userPrompt));
    const isFollowUp = looksLikeFollowUp(prevPages, userPrompt);
    let wantWeb = keywordHit;
    if (!keywordHit && !isFollowUp && settings.mode === "smart") {
      const st = ctl.createStatus({ status: "loading", text: t("Веб-ресёрч: решаю, нужен ли интернет…", "Web research: deciding whether the web is needed…") });
      const verdict = await needsWeb(ctl, attachedCaption ? `${userPrompt}\n(The user attached a picture showing: ${attachedCaption})` : userPrompt, ctl.abortSignal);
      wantWeb = verdict === true;
      if (!wantWeb) { st.setState({ status: "canceled", text: t("Веб-ресёрч: модель отвечает сама, интернет не нужен (/web — проверить всё равно)", "Web research: not needed, the model answers itself (/web to check anyway)") }); return userMessage; }
      st.setState({ status: "done", text: t("Веб-ресёрч: нужна проверка в интернете", "Web research: a web check is needed") });
    }
    if (settings.mode === "manual") wantWeb = false;
    if (!wantWeb) {
      if (!isFollowUp) return userMessage;
      followUpOnly = true;
    }
  }

  const signal = ctl.abortSignal;
  reader.log.fn = (...a: Any[]) => { try { ctl.debug(...a); } catch { /* that chat has finished */ } };
  if (!settings.searxngUrl && !followUpOnly) void builtinSearxngUrl((...m: Any[]) => ctl.debug(...m)); // warm up in parallel
  const status = ctl.createStatus({ status: "loading", text: t("Веб-ресёрч: ищу…", "Web research: searching…") });
  const log = (m: Any) => ctl.debug(m);
  const seen = seenUrlsFromHistory(history);
  const cleanQuery = userPrompt.replace(/\/(no_)?think/gi, "").replace(/\s+/g, " ").trim().slice(0, 300);

  // Memory guard: Bonsai/MLX-vision models on a 16 GB Mac with the default GPU limit (~10.7 GB)
  // cannot prefill long prompts (Metal "Insufficient Memory"). Cap the injected text there.
  let modelKey = "";
  try { const m = await ctl.client.llm.model(undefined, { signal }); modelKey = String(m.identifier || m.modelKey || ""); } catch { /* none */ }
  const isMac = process.platform === "darwin";
  let wiredLimitMb = -1;
  if (isMac && /bonsai/i.test(modelKey)) {
    try {
      const cp = require("node:child_process");
      wiredLimitMb = parseInt(String(cp.execSync("/usr/sbin/sysctl -n iogpu.wired_limit_mb", { timeout: 2000, stdio: ["ignore", "pipe", "ignore"] })).trim(), 10);
    } catch (e) { ctl.debug("cannot read iogpu.wired_limit_mb", String(e)); }
  }
  if (/bonsai/i.test(modelKey) && isMac && !(wiredLimitMb >= 12000)) {
    settings.maxChars = Math.min(settings.maxChars, 6000);
    status.setState({ status: "loading", text: t("Веб-ресёрч: мало видеопамяти для этой модели — беру сокращённый объём источников", "Web research: low GPU memory for this model — using fewer source passages") });
  } else if (/bonsai/i.test(modelKey) && isMac) {
    settings.maxChars = Math.min(settings.maxChars, 20000);
  }

  // Fit the chat's context: history (with earlier sources) + answer reserve + new sources must stay below the limit.
  let thinkingOn = false;
  try {
    const r = String(cfg.get("reasoning") || "model");
    thinkingOn = r === "on" || (r === "model" && (await lmStudioThinking(ctl, userMessage.getText())) === true);
  } catch { /* */ }
  const budget = await contextBudget(ctl, userMessage.getText(), history, thinkingOn);
  if (settings.reading === "auto") {
    // One researched message takes at most a quarter of the context, so several fit into one chat.
    // ~4k tokens per researched message at most: a bigger context means more questions per chat, not fatter ones.
    settings.maxChars = Math.min(12000, budget.freeChars, Math.round(budget.ctx * 0.18 * 3));
    settings.pages = Math.max(2, Math.min(8, Math.round(settings.maxChars / 2700)));
  } else settings.maxChars = Math.min(settings.maxChars, budget.freeChars);
  run().seeBudget = budget.freeChars >= 9000 ? 2 : budget.freeChars >= 5000 ? 1 : 0; // pictures the model may look at
  // Notes mode: sources are read in a separate call without the chat history, and only short notes stay in the chat.
  // So it can read much more than fits into the chat itself.
  // Auto: fast compact sources while the chat is fresh; notes once it is more than half full.
  const useNotes = settings.history === "notes" || (settings.history === "auto" && budget.used > budget.ctx * 0.5);
  if (useNotes && settings.reading === "auto") {
    settings.maxChars = Math.max(settings.maxChars, Math.min(30000, Math.round(budget.ctx * 0.5 * 3)));
    settings.pages = Math.max(settings.pages, Math.min(10, Math.round(settings.maxChars / 2700)));
  }
  if (budget.freeChars < 2500) {
    settings.maxChars = Math.max(1200, budget.freeChars); settings.pages = 2;
    status.setState({ status: "loading", text: t("Веб-ресёрч: контекст чата почти заполнен — беру немного текста. Для полного ресёрча начните новый чат.", "Web research: this chat's context is almost full — using little source text. Start a new chat for full research.") });
  }

  const collected: Any[] = [];
  const used = new Set(seen);
  let doSearch = !followUpOnly;
  let question = cleanQuery;
  if (followUpOnly && overlap(prevPages, cleanQuery) === 0) {
    // Small talk or a new topic without search words: leave the message alone.
    status.setState({ status: "canceled", text: t("Веб-ресёрч: не нужен для этого сообщения", "Web research: not needed for this message") });
    return userMessage;
  }
  // Earlier sources are still in this chat's history (LM Studio keeps the enriched messages):
  // point the model at them instead of pasting the same text again.
  const conv = findConversation(userMessage.getText());
  const histJson = conv ? JSON.stringify(conv.messages?.slice(0, -1) || []) : "";
  const sourcesInHistory = histJson.includes("<web_research") && !histJson.includes('format=\\"notes\\"') && !useNotes;
  if (followUpOnly && sourcesInHistory) {
    // A short pointer (numbers and titles, no text) keeps the earlier sources in focus several turns later.
    const earlier = previousSources(conv);
    const list = earlier.length ? ` Earlier sources: ${earlier.map(x => `[${x.n}] ${x.title.slice(0, 70)}`).join("; ")}.` : "";
    status.setState({ status: "done", text: t("Веб-ресёрч: уточняющий вопрос — отвечаю по источникам выше (почти 0 новых токенов)", "Web research: follow-up — answering from the sources above (almost 0 new tokens)") });
    return `${userPrompt}\n\n(Answer from the <web_research> results given earlier in this conversation and cite them the same way, as [n](URL).${list} If they do not cover the question, say so and suggest /web for a new search.)`;
  }
  if (followUpOnly) status.setState({ status: "loading", text: t("Веб-ресёрч: уточняющий вопрос — беру уже прочитанные источники", "Web research: follow-up — reusing sources read earlier") });
  if (directUrls.length) {
    question = cleanQuery.replace(URL_RE, " ").replace(/\s+/g, " ").trim() || t("основное содержание страницы", "main content of the page");
    doSearch = SEARCH_ALSO.test(question);
    status.setState({ status: "loading", text: `${t("Веб-ресёрч: открываю ссылки из сообщения", "Web research: opening links from the message")} (${directUrls.length})…` });
    const firsts = await Promise.all(directUrls.map(u => readDirect(u, signal, status)));
    const subLinks: Any[] = [];
    for (const f of firsts) {
      if (!f) continue;
      collected.push(f.page); used.add(normUrl(f.page.url));
      subLinks.push(...internalLinks(f.links, f.page.url, question).slice(0, 8));
    }
    // Follow a few of the most relevant pages of the same site for a fuller picture.
    const follow: Any[] = [];
    for (const l of subLinks) {
      const k = normUrl(l.url);
      if (used.has(k)) continue;
      used.add(k); follow.push(l);
      if (follow.length >= Math.max(0, Math.min(4, settings.pages - directUrls.length))) break;
    }
    if (follow.length && settings.depth >= 2) {
      status.setState({ status: "loading", text: `${t("Веб-ресёрч: читаю связанные страницы сайта", "Web research: reading related pages of the site")} (${follow.length})…` });
      const subs = await Promise.all(follow.map(l => readDirect(l.url, signal, status)));
      for (const f of subs) if (f) { f.page.direct = false; f.page.sameSite = true; collected.push(f.page); }
    }
    if (!collected.length) doSearch = true;
  }

  const queries = [(cleanQuery.replace(URL_RE, " ").replace(/\s+/g, " ").trim() || cleanQuery) + (attachedCaption ? ` ${attachedCaption}` : "")];
  if (directUrls.length && !doSearch && collected.length && !(GENERIC_SUMMARY.test(question) || question.length < 15)) {
    // Specific question about a pasted link: get keywords in the document's language to find the right passages.
    status.setState({ status: "loading", text: t("Веб-ресёрч: ищу ответ внутри документа…", "Web research: locating the answer inside the document…") });
    const sample = collected[0].text.slice(0, 400).replace(/\s+/g, " ");
    const kw = await llmQueries(ctl,
      `Document excerpt: "${sample}"\n\nQuestion: ${question}\n\n` +
      `Write 3 short keyword phrases to locate the answer inside this document: in the document's language and in English. ` +
      `Only the phrases, one per line, no explanations.`, signal);
    queries.push(...kw);
  }
  if (doSearch && settings.depth >= 2) {
    status.setState({ status: "loading", text: t("Веб-ресёрч: модель подбирает поисковые запросы…", "Web research: the model is writing search queries…") });
    const extra = await llmQueries(ctl,
      `Write 3 short web search queries for the user question below (no explanations, no reasoning). ` +
      `One in the language of the question and one in English. Add a third in a local language ONLY if the topic belongs to a specific country, city or people (e.g. Serbian for a Serbian election); otherwise write a second, differently worded English query. ` +
      `Only the queries, one per line, no numbering.\n\nQuestion: ${cleanQuery}${attachedCaption ? `\n(The user attached a picture showing: ${attachedCaption})` : ""}`, signal);
    queries.push(...extra);
  }
  if (doSearch && queries.length === 1) {
    // Fallback when the model returned no usable queries: keyword-only variant + recency variant.
    const kw = keywords(cleanQuery).filter(w => !/^(что|как|где|когда|расскажи|найди|интернет|internet|check|tell|about|what|have|they|done|that|called|this|info)$/i.test(w)).slice(0, 8).join(" ");
    if (kw && kw !== cleanQuery.toLowerCase()) queries.push(kw);
    queries.push(`${kw || cleanQuery} ${new Date().getFullYear()}`);
  }

  const runRound = async (qs: string[], pages: number, label: string) => {
    status.setState({ status: "loading", text: `${t("Веб-ресёрч", "Web research")}: ${label} — ${t("поиск по запросам", "searching, queries")}: ${qs.length}…` });
    const lists = await Promise.all(qs.map(q => search(settings, q, signal, log)));
    let merged: Any[] = [];
    for (let i = 0; i < Math.max(...lists.map(l => l.length), 0); i++) {
      for (const l of lists) if (l[i]) merged.push(l[i]);
    }
    // Engines sometimes return unrelated pages (shop locators, login pages): keep results that share
    // at least one word with any of the queries.
    const qTerms = new Set(terms(qs.join(" "), true));
    const related = merged.filter(r => terms(`${r.title} ${r.snippet} ${safeDecode(String(r.url)).replace(/[\/_\-.?=&]+/g, " ")}`).some(w => qTerms.has(w)));
    if (related.length) merged = related;
    // Few results (engines rate-limited, or a niche topic): Wikipedia's own search in the question's language and English.
    if (merged.length < pages) {
      const wiki = await Promise.all([...new Set([run().lang === "ru" ? "ru" : "en", "en"])].map(l => searchWikipedia(qs[0], l, signal)));
      merged.push(...wiki.flat());
    }
    const fresh: Any[] = [];
    for (const r of merged) {
      const k = normUrl(r.url);
      if (used.has(k) || /\.(jpe?g|png|gif|webp|zip|rar|7z|exe|dmg|mp4|mp3)(\?|$)/i.test(r.url)) continue;
      used.add(k); fresh.push(r);
      if (fresh.length >= pages) break;
    }
    const read = await readPages(fresh, signal, status);
    collected.push(...read);
  };

  stopIfAborted(signal);
  if (doSearch) await runRound(queries, Math.max(2, settings.pages - collected.length), t("раунд 1", "round 1"));
  stopIfAborted(signal);

  if (doSearch && settings.depth >= 3 && collected.length) {
    status.setState({ status: "loading", text: t("Веб-ресёрч: ищу пробелы и уточняю…", "Web research: looking for gaps…") });
    const overview = collected.map((c, i) => `[${i + 1}] ${c.title}: ${c.text.slice(0, 300)}`).join("\n");
    const follow = await llmQueries(ctl,
      `User question: ${cleanQuery}\n\nAlready found:\n${overview}\n\n` +
      `What is missing for a complete answer? Write 2 follow-up web search queries in the most useful language, one per line, no explanations.`, signal);
    if (follow.length) await runRound(follow, Math.ceil(settings.pages / 2), t("раунд 2", "round 2"));
  }

  // Pages behind the previous answer join the pool; BM25 decides whether they are still relevant.
  for (const p of (sourcesInHistory ? [] : prevPages)) {
    if (collected.some((c: Any) => normUrl(c.url) === normUrl(p.url))) continue;
    collected.push({ ...p, prev: true });
  }

  // Pictures for vision models: pasted image links, images of the pages read, image search for visual questions.
  let imageNotes: string[] = []; let imageShows: string[] = [];
  const visual = VISUAL_RE.test(userPrompt);
  // Show (illustrate the answer): research about real-world things; not for code, math or text work,
  // and not when the user brought their own picture (unless they ask to compare / find similar ones).
  const ownPicture = attached.length > 0;
  const wantShow = settings.pictures === "always"
    || (settings.pictures === "auto" && !ABSTRACT_RE.test(userPrompt) && (!ownPicture || COMPARE_RE.test(userPrompt)));
  // See (the model studies web pictures): only when the answer depends on what is visible.
  const seeWanted = settings.see === "always"
    || (settings.see === "auto" && (imageLinks.length > 0 || (SEE_RE.test(userPrompt) && (!ownPicture || COMPARE_RE.test(userPrompt)))));
  const visionModel = (wantShow || seeWanted) ? await isVisionModel(ctl) : false;
  const wantSee = seeWanted && run().seeBudget > 0 && visionModel;
  let modelSees = false;
  // Illustrations cost the context nothing (the model gets only file names): use as many as the topic deserves.
  settings.maxImages = RICH_RE.test(userPrompt) || VISUAL_RE.test(userPrompt) ? 6 : 3;
  if (wantShow || wantSee) {
    stopIfAborted(signal);
    const g = await gatherImages(ctl, settings, imageLinks, collected, (question.replace(URL_RE, " ").trim() || cleanQuery) + (attachedCaption ? ` ${attachedCaption}` : ""), visual || SEE_RE.test(userPrompt) || (wantShow && RICH_RE.test(userPrompt)), { show: wantShow, see: wantSee, vet: wantShow && visionModel }, signal, status);
    run().pendingFiles = g.files; imageNotes = g.notes; imageShows = g.shows; modelSees = g.files.length > 0 || g.notes.some(n => n.includes("(you looked at it)"));
    // Pictures the model looks at use context too: keep the total within budget.
    if (g.files.length) settings.maxChars = Math.max(2500, settings.maxChars - 2400 * g.files.length);
  }

  if (!collected.length && imageNotes.length) {
    status.setState({ status: "done", text: `${t("Веб-ресёрч: картинок передано модели", "Web research: pictures passed to the model")} — ${imageNotes.length}` });
    return `${userPrompt}\n\n(Attached pictures:\n${imageNotes.join("\n")})`;
  }
  if (!collected.length) {
    const why = run().searchProblem ? ` (${run().searchProblem.slice(0, 140)})` : "";
    status.setState({ status: "canceled", text: `${t("Веб-ресёрч: ничего не нашлось", "Web research: nothing found")}${why}${run().searchProblem ? t(" — подождите пару минут или добавьте ключ Tavily/Brave в настройках", " — wait a few minutes or add a Tavily/Brave key in the settings") : ""}` });
    return `${userPrompt}\n\n(Web search returned nothing for this message. Say so in one sentence in the user's language, then answer from your own knowledge.)`;
  }

  status.setState({ status: "loading", text: t("Веб-ресёрч: отбираю самые полезные фрагменты…", "Web research: selecting the most relevant passages…") });
  const summaryMode = directUrls.length > 0 && !doSearch && (GENERIC_SUMMARY.test(question) || question.length < 15);
  const similarity = settings.ranking === "keywords" ? null : await embeddingSimilarity(ctl, [question, ...collected.slice(0, 6).map((c: Any) => String(c.text).slice(0, 1500))].join(" "), signal, status);
  stopIfAborted(signal);
  const bodies = await selectChunks(collected, [question, ...queries].join(" "), settings.maxChars, { summary: summaryMode, similarity, semanticQuery: question });
  const blocks: string[] = [];
  const cites: string[] = [];
  collected.forEach((c, i) => {
    if (!bodies[i]) return;
    const n = blocks.length + 1;
    cites.push(`[${n}](${c.url})`);
    const body = bodies[i].replace(/^\s*\[(\d+)\]/gm, "(ref $1)");
    blocks.push(`[${n}](${c.url}) ${c.title}${c.date ? ` (${c.date})` : ""}\n${body}`);
  });
  const today = new Date().toISOString().slice(0, 10);
  // Optionally condense the sources into short cited notes: only the notes stay in the chat history.
  let notes = "";
  stopIfAborted(signal);
  if (useNotes && blocks.length) {
    status.setState({ status: "loading", text: t("Веб-ресёрч: сжимаю источники в заметки…", "Web research: condensing sources into notes…") });
    const r = await quickAnswer(ctl,
      `Sources:\n${blocks.join("\n\n")}\n\n` +
      `Task: extract from the sources above the facts needed to answer this question: "${userPrompt.replace(URL_RE, " ").trim().slice(0, 300)}".\n` +
      `Write 6-14 short bullet points with concrete facts, names, dates and numbers. End every bullet with the source link exactly as written at the start of its source, like [1](URL). ` +
      `Note contradictions between sources. No introduction, no conclusion, only the bullets, in English.`, signal, 900);
    notes = r.text.trim();
    if (notes.length < 150 || !/\]\(https?:/.test(notes)) notes = ""; // fall back to full sources
  }
  const cached = cacheStats.hits - hits0;
  status.setState({ status: "done", text: `${t("Веб-ресёрч: прочитано источников", "Web research: sources read")} — ${blocks.length} (${t("запросов", "queries")}: ${queries.length}${cached ? `, ${t("из кэша", "from cache")}: ${cached}` : ""}${run().timeRange ? `, ${t("период", "period")}: ${run().timeRange}` : ""})` });

  // The user's question goes first: LM Studio names the chat from the processed first message.
  return (
    `${userPrompt}\n\n` +
    `<web_research date="${today}" sources="${blocks.length}"${notes ? ` format="notes"` : ""}>\n` +
    (notes ? `${notes}\n\nSources: ${collected.filter((_: Any, i: number) => bodies[i]).map((c: Any, i: number) => `[${i + 1}](${c.url}) ${c.title}`).join(" · ")}` : blocks.join("\n\n---\n\n")) +
    `\n</web_research>\n\n` +
    (imageNotes.length ? (modelSees
      ? `Attached pictures from these sources (look at them when they help to answer):\n${imageNotes.join("\n")}\n\n`
      : `Pictures from these sources will be shown to the user (you cannot see them; describe things from the text):\n${imageNotes.join("\n")}\n\n`) : "") +
    `Instructions: answer the question above using the web research results. ` +
    `Cite every claim with the source's Markdown link exactly as written at its start, e.g. ${cites[0] || "[1](URL)"} — a bare [1] without (URL) is an error. ` +
    `If sources contradict each other, say so; if information is missing, say so. ` +
    (settings.sourcesList ? `End with a "${t("Источники", "Sources")}" section: a numbered list of Markdown links like 1. [Title](URL). ` : "") +
    ({ short: "Keep the answer short: only the key facts, a few sentences or bullets. ", detailed: "Write a detailed, well-structured report with headings. ", balanced: "" } as Any)[settings.answerStyle] +
    `Answer in ${run().lang === "ru" ? "Russian" : /[a-z]/i.test(userPrompt.replace(URL_RE, "")) && !/[^\x00-\x7F]/.test(userPrompt.replace(URL_RE, "").replace(/[’“”—–…]/g, "")) ? "English" : "the language of the question"}, even if the sources are in another language.` +
    (imageShows.length ? `\nWrite the answer like an illustrated article. Spread these pictures through the text: the first one right after your first paragraph, ` +
      `each next one after a different section that matches what it shows (its caption tells you). Never put two pictures in a row, never all at the end, never after the sources. ` +
      `Copy each picture line exactly, on its own line — the part in parentheses is a local file name, never replace it with a web address:\n${imageShows.join("\n")}\n` +
      `Layout example: paragraph → picture → heading → paragraph → picture → paragraph → picture → … → Sources.` : "") +
    `\n\nQuestion: ${userPrompt}`
  );
}

// ---------- Context budget ----------
function lmsHome() {
  const fs = require("node:fs"); const path = require("node:path"); const os = require("node:os");
  let home = path.join(os.homedir(), ".lmstudio");
  try { const ptr = fs.readFileSync(path.join(os.homedir(), ".lmstudio-home-pointer"), "utf8").trim(); if (ptr) home = ptr; } catch { /* */ }
  return home;
}
/** The saved LM Studio conversation that contains this message (LM Studio does not tell plugins which chat it is). */
function findConversation(userText: string): Any {
  const memo = run().conv;
  if (memo && memo.text === userText) return memo.conv;
  const conv = readConversation(userText);
  run().conv = { text: userText, conv };
  return conv;
}
function readConversation(userText: string): Any {
  try {
    const fs = require("node:fs"); const path = require("node:path");
    const dir = path.join(lmsHome(), "conversations");
    const head = JSON.stringify(Array.from(userText).slice(0, 60).join("")).slice(1, -1);
    const files = fs.readdirSync(dir).filter((f: string) => f.endsWith(".json"))
      .map((f: string) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a: Any, b: Any) => b.m - a.m).slice(0, 4);
    for (const { f } of files) {
      const c = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (JSON.stringify(c.messages?.slice(-3) || []).includes(head)) return c;
    }
  } catch { /* */ }
  return null;
}
/**
 * How many characters of sources still fit: LM Studio keeps the plugin-enriched messages in the chat history,
 * so every researched question stays in the context. Without this, long chats overflow the model's context.
 */
async function contextBudget(ctl: Any, userText: string, history: Any, reserveForThinking: boolean) {
  let ctx = 8192;
  try { const m = await ctl.client.llm.model(); const info: Any = await m.getModelInfo(); ctx = Number(info?.contextLength) || ctx; } catch { /* */ }
  let chars = 0; let pictures = 0;
  const conv = findConversation(userText);
  if (conv?.messages?.length) {
    for (const msg of conv.messages.slice(0, -1)) {
      const v = msg.versions?.[msg.currentlySelected ?? 0] || msg.versions?.[0] || {};
      const content = (v.preprocessed?.content || v.content || []) as Any[];
      for (const c of content) { if (c.type === "text") chars += String(c.text || "").length; if (c.type === "file") pictures++; }
      for (const st of (v.steps || [])) {
        if (st.type !== "contentBlock" || st.style?.type === "thinking") continue;
        for (const c of (st.content || [])) chars += String(c.text || "").length;
      }
    }
  } else {
    try { for (const m of history.getMessagesArray().slice(0, -1)) chars += String(m.getText() || "").length; } catch { /* */ }
  }
  const used = Math.ceil(chars / 3) + pictures * 800;
  const reserve = Math.min(reserveForThinking ? 8000 : 4096, Math.max(1500, Math.round(ctx * (reserveForThinking ? 0.4 : 0.25))));
  const freeTokens = ctx - used - reserve - 900;
  return { ctx, used, freeChars: Math.max(0, freeTokens * 3) };
}

// LM Studio's own "Enable thinking" switch (per chat, else the model's defaults). MLX templates often never
// receive it, so the plugin reads it and passes it on as /think or /no_think.
async function lmStudioThinking(ctl: Any, userText: string): Promise<boolean | undefined> {
  const read = (o: Any): boolean | undefined => {
    for (const f of (o?.fields || [])) if (f?.key === "llm.prediction.reasoning.enableThinking" && typeof f.value === "boolean") return f.value;
    return undefined;
  };
  try {
    // 1) Per-chat setting of this conversation.
    const c = findConversation(userText);
    if (c?.usePerChatPredictionConfig) { const v = read(c.perChatPredictionConfig); if (v !== undefined) return v; }
    // 2) The model's default settings.
    const fs = require("node:fs"); const path = require("node:path");
    const m = await ctl.client.llm.model();
    const info: Any = await m.getModelInfo();
    const rel = String(info?.path || "").replace(/\\/g, "/").replace(/\.(gguf|json)$/i, "");
    for (const cand of [rel, rel.split("/").slice(0, 2).join("/")]) {
      const p = path.join(lmsHome(), ".internal", "user-concrete-model-default-config", cand + ".json");
      if (fs.existsSync(p)) { const v = read(JSON.parse(fs.readFileSync(p, "utf8")).operation); if (v !== undefined) return v; }
    }
  } catch (e) { ctl.debug("thinking setting not found", String(e)); }
  return undefined;
}

// Wrapper: applies the reasoning setting and keeps attachments (images, files) of the message.
async function preprocess(ctl: Any, userMessage: Any) {
  // Own state and own "hosts the user typed" for this message; nothing leaks into other chats or later messages.
  return RUN.run(newRun(), () => reader.hostScope.run(new Set<string>(), () => preprocessMessage(ctl, userMessage)));
}
async function preprocessMessage(ctl: Any, userMessage: Any) {
  let out: Any;
  try { out = await research(ctl, userMessage); }
  catch (e) {
    // Never fail the user's message because of the web: answer without it and say why.
    if (ctl.abortSignal?.aborted) throw e;
    console.error("[web-powers] research failed:", e);
    try { ctl.createStatus({ status: "error", text: `${t("Веб-ресёрч не удался", "Web research failed")}: ${String((e as Any)?.message || e).slice(0, 120)}` }); } catch { /* */ }
    out = userMessage;
  }
  let reasoning = "model";
  try { reasoning = String(ctl.getPluginConfig(configSchematics).get("reasoning") || "model"); } catch { /* */ }
  const original = userMessage.getText();
  if (reasoning === "model") {
    const v = await lmStudioThinking(ctl, original);
    if (v !== undefined) reasoning = v ? "on" : "off";
  }
  let text = typeof out === "string" ? out : out.getText();
  // Qwen-style soft switches; with a template patched by extras/disable-thinking, /think turns reasoning on.
  if (reasoning !== "model" && text.trim() && !/(^|\s)\/(no_)?think\b/i.test(original)) {
    text += reasoning === "on" ? "\n\n/think" : "\n\n/no_think";
  }
  const files = run().pendingFiles; run().pendingFiles = [];
  if (files.length && typeof userMessage.appendFile === "function") for (const f of files) userMessage.appendFile(f);
  if (text === original && !files.length) return userMessage;
  if (typeof userMessage.replaceText === "function") { userMessage.replaceText(text); return userMessage; }
  return text;
}

// ---------- Optional tools (for models with native tool use) ----------
const READ_STEP = 5000;
/** Full text of a page for read_more: from the cache when it was read for the research, else read now. */
async function pageForTool(url: string, signal: Any): Promise<{ url: string; title: string; text: string } | null> {
  const hit = await cachedPage(url);
  if (hit) return hit;
  const ok = await reader.isPublicUrl(url);
  if (!ok) return null;
  const fake = { addSubStatus: () => ({ setState() {} }) };
  const d = await readDirect(url, signal, fake);
  return d ? { url: d.page.url, title: d.page.title, text: d.page.text } : null;
}
async function toolsProvider(ctl: Any) {
  let on = false;
  try { on = ctl.getGlobalPluginConfig(globalConfigSchematics).get("tools") === true; } catch { /* */ }
  if (!on) return [];
  return [
    tool({
      name: "read_more",
      description: "Read more of a web page, e.g. a source of the web research in this chat (its URL is written next to its number). Returns about 5000 characters from `offset`; call again with next_offset to continue.",
      parameters: { source: z.string().describe("The full https URL of the page"), offset: z.number().int().min(0).optional() },
      implementation: async ({ source, offset }: Any, { status, signal }: Any) => RUN.run(newRun(), async () => {
        const url = String(source).trim().replace(/^[<(\["']+|[>)\]"'.,]+$/g, "");
        if (!/^https?:\/\//i.test(url)) return { error: `"${source}" is not a URL. Pass the full URL written next to the source number.` };
        status(`Reading ${hostOf(url)}…`);
        const page = await pageForTool(url, signal);
        if (!page) return { error: `Could not read ${url}` };
        const from = Math.max(0, Number(offset) || 0);
        const text = page.text.slice(from, from + READ_STEP);
        return { url: page.url, title: page.title, offset: from, total_chars: page.text.length, next_offset: from + READ_STEP < page.text.length ? from + READ_STEP : null, text };
      }),
    }),
    tool({
      name: "search_web",
      description: "Search the web. Returns titles, URLs and short snippets; then use read_more on the most relevant URLs.",
      parameters: { query: z.string().describe("Search query") },
      implementation: async ({ query }: Any, { status, signal }: Any) => RUN.run(newRun(), async () => {
        status(`Searching: ${String(query).slice(0, 60)}`);
        let gcfg: Any = { get: () => undefined };
        try { gcfg = ctl.getGlobalPluginConfig(globalConfigSchematics); } catch { /* */ }
        const cfg = {
          searxngUrl: String(gcfg.get("searxngUrl") || "").trim(), tavilyKey: String(gcfg.get("tavilyKey") || "").trim(),
          braveKey: String(gcfg.get("braveKey") || "").trim(), ollamaKey: String(gcfg.get("ollamaKey") || "").trim(),
        };
        const res = await search(cfg, String(query), signal, (...m: Any[]) => ctl.debug(...m));
        if (!res.length) return { error: run().searchProblem || "No results" };
        return res.slice(0, 8).map(r => ({ title: r.title, url: r.url, snippet: r.snippet.slice(0, 300) }));
      }),
    }),
  ];
}

/** Internals for the unit tests (plugin/test). */
export const _test = { webProbability, looksLikeFollowUp, previousSources, terms, overlap, selectChunks, shortDate, extractUrls, TIME_WORDS, AUTO_TRIGGERS, VISUAL_RE, SEE_RE, RICH_RE, normUrl, embedPrefixes, run, RUN, newRun, lastAnswerUrls };

export async function main(context: Any) {
  context.withConfigSchematics(configSchematics);
  context.withGlobalConfigSchematics(globalConfigSchematics);
  context.withPromptPreprocessor(preprocess);
  context.withToolsProvider(toolsProvider);
}
