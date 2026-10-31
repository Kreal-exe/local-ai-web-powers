// Built-in SearXNG: started from the plugin itself with the prebuilt binary that LM Studio's
// installer downloads for this platform (@searxng-js/<platform>). No Docker, no Python, no Node install.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const req: Any = typeof require === "function" ? require : (0, eval)("require");
const importEsm: Any = new Function("s", "return import(s)");

// LM Studio starts plugins without PATH; SearXNG (and anything we spawn) needs one.
export function ensurePath() {
  if (process.env.PATH && process.env.PATH.length > 3) return;
  process.env.PATH = process.platform === "win32"
    ? [process.env.SystemRoot || "C:\\Windows", "System32"].join("\\") + ";" + (process.env.SystemRoot || "C:\\Windows")
    : "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
}
ensurePath();

// Engines checked from a home connection in October 2026. Google (all variants) needs JavaScript and is
// always refused, Qwant blocks, Bing's general results are mostly unrelated pages, and the translation and
// currency engines only add noise. Brave and DuckDuckGo rate-limit after many searches: Yahoo, Yandex and
// Mwmbl keep results coming meanwhile.
const ENGINE_SETTINGS: [string, boolean, number?][] = [
  ["duckduckgo", true, 1.2], ["brave", true, 1.2], ["yahoo", true, 1], ["yandex", true, 0.7], ["mwmbl", true, 0.5], ["wikipedia", true, 1],
  ["google cse", false], ["google", false], ["qwant", false], ["bing", false], ["wikidata", false], ["lingva", false],
  ["dictzone", false], ["mymemory translated", false], ["currency", false],
  ["google cse images", false], ["google images", false], ["qwant images", false],
  ["google news", false], ["qwant news", false], ["reuters", false],
];
function writeSettings(): string {
  const fs = req("node:fs"); const os = req("node:os"); const path = req("node:path"); const crypto = req("node:crypto");
  const engines = ENGINE_SETTINGS.map(([name, on, weight]) => `  - name: ${name}\n    disabled: ${!on}${weight ? `\n    weight: ${weight}` : ""}`).join("\n");
  const yml = [
    "use_default_settings: true",
    "general:\n  instance_name: local-ai-web-powers",
    "search:\n  formats: [html, json]",
    `server:\n  limiter: false\n  image_proxy: false\n  secret_key: "${crypto.randomBytes(24).toString("hex")}"`,
    "valkey:\n  url: false",
    "outgoing:\n  request_timeout: 4.0\n  max_request_timeout: 8.0",
    `engines:\n${engines}`,
  ].join("\n") + "\n";
  const file = path.join(os.tmpdir(), `local-ai-web-powers-searxng-${process.pid}.yml`);
  fs.writeFileSync(file, yml, { mode: 0o600 });
  process.once("exit", () => { try { fs.unlinkSync(file); } catch { /* */ } });
  return file;
}

let server: Any = null;
let starting: Promise<string | null> | null = null;
let lastError = "";

export async function builtinSearxngUrl(log: (...a: Any[]) => void): Promise<string | null> {
  if (server) return server.url;
  if (!starting) {
    starting = (async () => {
      try {
        ensurePath();
        const { pathToFileURL } = req("node:url");
        const mod = await importEsm(pathToFileURL(req.resolve("@searxng-js/searxng")).href);
        server = await mod.startServer({ timeoutMs: 120_000, settingsPath: writeSettings() });
        console.error("[web-powers] built-in SearXNG at", server.url);
        return server.url as string;
      } catch (e) {
        lastError = String((e as Any)?.message || e);
        console.error("[web-powers] built-in SearXNG failed:", lastError, "\n--- output ---\n", String((e as Any)?.output || "").slice(-3000));
        starting = null; // allow a retry on the next message
        return null;
      }
    })();
  }
  return starting;
}
