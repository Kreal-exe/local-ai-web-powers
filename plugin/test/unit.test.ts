// Unit tests for the parts that broke or were fixed before: run with `npm test` (bundled by esbuild, then node --test).
import test from "node:test";
import assert from "node:assert/strict";
import { stem, stemRu, stemEn } from "../src/stem";
import http from "node:http";
import { isPrivateIp, isPublicUrl, extractHtml, isBlockedPage, pageText, hostScope, get, readText } from "../src/reader";
import { _test } from "../src/index";

test("Russian Snowball stems (reference vocabulary)", () => {
  const ref: Record<string, string> = { "вавилонского": "вавилонск", "важное": "важн", "вдохновение": "вдохновен", "великолепнейших": "великолепн", "вечерами": "вечер", "взбесившаяся": "взбес", "видимостью": "видим", "государственный": "государствен", "каналы": "канал", "сербии": "серб", "выборах": "выбор", "победили": "побед" };
  for (const [w, e] of Object.entries(ref)) assert.equal(stemRu(w), e, w);
});
test("English Porter stems", () => {
  assert.equal(stemEn("canals"), "canal");
  assert.equal(stemEn("elections"), "elect");
  assert.equal(stemEn("running"), "run");
});
test("word forms share an index key (stem or 5-letter prefix)", () => {
  const share = (a: string, b: string) => _test.terms(a).some((k: string) => _test.terms(b).includes(k));
  assert.ok(share("канал", "канала"));
  assert.ok(share("студенческого", "студенческий"));
  assert.ok(share("canal", "canals"));
  assert.ok(!share("канал", "выборы"));
  assert.equal(stem("izbori"), "izbori");
});
test("private and public addresses", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fd00::1", "fe80::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "0:0:0:0:0:ffff:127.0.0.1", "::ffff:a9fe:a9fe", "::7f00:1", "::ffff:0:7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::1"]) assert.ok(isPrivateIp(ip), ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "2a00:1450:4001::200e", "172.32.0.1", "192.0.78.9"]) assert.ok(!isPrivateIp(ip), ip);
});
test("URL guard blocks local targets unless the user typed them", async () => {
  for (const u of ["http://127.0.0.1:1234/", "http://localhost:8080", "http://[::1]/", "file:///etc/passwd", "http://nas.local/", "http://169.254.169.254/latest",
    "http://[::ffff:127.0.0.1]/", "http://[::ffff:a9fe:a9fe]/", "http://2130706433/", "http://0x7f.1/", "http://127.1/"]) assert.equal(await isPublicUrl(u), false, u);
  assert.equal(await isPublicUrl("https://93.184.215.14/"), true);
  // Allowed only inside the message that typed the host.
  await hostScope.run(new Set(["127.0.0.1"]), async () => assert.equal(await isPublicUrl("http://127.0.0.1:1234/"), true));
  assert.equal(await isPublicUrl("http://127.0.0.1:1234/"), false);
});
test("pasted links keep balanced parentheses; time commands only as words", () => {
  assert.deepEqual(_test.extractUrls("see https://en.wikipedia.org/wiki/Mercury_(planet) and (https://a.org/x)."), ["https://en.wikipedia.org/wiki/Mercury_(planet)", "https://a.org/x"]);
  const range = (q: string) => _test.TIME_WORDS.find(([re]: any) => re.test(q))?.[1];
  assert.equal(range("news /week"), "week");
  assert.equal(range("read https://en.wikipedia.org/wiki/Week"), undefined);
  assert.equal(range("https://x.org/year/2025 summary"), undefined);
});
test("keyword triggers need whole words", () => {
  assert.ok(_test.AUTO_TRIGGERS.test("latest news about Serbia"));
  assert.ok(_test.AUTO_TRIGGERS.test("найди информацию"));
  assert.ok(!_test.AUTO_TRIGGERS.test("how do I build a website in python"));
  assert.ok(!_test.AUTO_TRIGGERS.test("free up resources in C++"));
});
test("cache keys keep path case", () => {
  assert.notEqual(_test.normUrl("https://www.youtube.com/watch?v=AbC"), _test.normUrl("https://youtube.com/watch?v=abc"));
  assert.equal(_test.normUrl("https://WWW.Example.org/a/"), "example.org/a");
});
test("per-message state does not leak between parallel chats", async () => {
  const seen: string[] = [];
  const chat = (lang: string, ms: number) => _test.RUN.run(_test.newRun(), async () => {
    _test.run().lang = lang;
    await new Promise(r => setTimeout(r, ms));
    seen.push(`${lang}:${_test.run().lang}`);
  });
  await Promise.all([chat("ru", 20), chat("en", 5)]);
  assert.deepEqual(seen.sort(), ["en:en", "ru:ru"]);
});
test("embedding prefixes", () => {
  assert.deepEqual(_test.embedPrefixes("text-embedding-nomic-embed-text-v1.5"), ["search_query: ", "search_document: "]);
  assert.deepEqual(_test.embedPrefixes("intfloat/multilingual-e5-large"), ["query: ", "passage: "]);
  assert.deepEqual(_test.embedPrefixes("bge-m3"), ["", ""]);
  assert.deepEqual(_test.embedPrefixes("gte5-something"), ["", ""]);
});
test("main-content extraction gives compact text and collects pictures", async () => {
  const html = `<html><head><title>Canal</title><meta property="og:image" content="https://x.org/og.jpg"></head><body>
    <nav>Home | Login | Shop</nav><article><h1>The canal</h1><p>The <b>Rusanivka canal</b> was dug in the 1960s.<sup><a href="#n1">[1]</a></sup> ${"It surrounds an island of apartment blocks. ".repeat(12)}</p>
    <p><img src="/photo.jpg" width="800" height="500" alt="Canal"> See <a href="https://en.wikipedia.org/wiki/Rusanivka">Wikipedia</a>.</p></article></body></html>`;
  const ex = await extractHtml(html, "https://x.org/canal");
  assert.ok(ex);
  assert.match(ex!.text, /Rusanivka canal was dug in the 1960s/);
  assert.doesNotMatch(ex!.text, /\]\(https?:|\*\*|Login/);
  assert.ok(ex!.images.includes("https://x.org/photo.jpg"));
});
test("bot walls are recognised", () => {
  assert.ok(isBlockedPage("Just a moment...", ""));
  assert.ok(isBlockedPage("Example", "Please enable JavaScript and cookies to continue"));
  assert.ok(!isBlockedPage("Rusanivka — Wikipedia", "Rusanivka is a man-made island ".repeat(40)));
});
test("two-column PDF pages are read column by column", () => {
  const items: any[] = [{ str: "A Paper Title Across Both Columns", transform: [1, 0, 0, 1, 150, 760], width: 300 }];
  for (let i = 0; i < 10; i++) {
    items.push({ str: `left ${i}`, transform: [1, 0, 0, 1, 50, 700 - i * 12], width: 200 });
    items.push({ str: `right ${i}`, transform: [1, 0, 0, 1, 320, 700 - i * 12], width: 200 });
  }
  // Row by row (left and right piece of each row in turn)…
  items.push({ str: "arXiv:2305.14627v2 [cs.CL] 31 Oct 2023", transform: [0, 20, -20, 0, 32, 640], width: 346 }); // rotated margin stamp
  const text = pageText(items, 600).split("\n");
  assert.equal(text[0], "A Paper Title Across Both Columns");
  assert.equal(text[text.length - 1], "arXiv:2305.14627v2 [cs.CL] 31 Oct 2023", "margin stamp moved out of the flow");
  assert.ok(text.indexOf("left 9") < text.indexOf("right 0"), "left column first");
  // …and column by column, as LaTeX papers usually do.
  const body = items.slice(1, 21);
  const byColumn = [items[0], ...body.filter((_, i) => i % 2 === 0), ...body.filter((_, i) => i % 2 === 1)];
  const text2 = pageText(byColumn, 600).split("\n");
  assert.ok(text2.indexOf("left 9") < text2.indexOf("right 0"));
  assert.equal(text2.length, 21);
  // A one-column page stays in order.
  const single = Array.from({ length: 15 }, (_, i) => ({ str: `line ${i}`, transform: [1, 0, 0, 1, 50, 700 - i * 12], width: 480 }));
  assert.deepEqual(pageText(single, 600).split("\n"), single.map(x => x.str));
});
test("smart mode reads WEB/NO probabilities", () => {
  const lp = (web: number, no: number) => ({ content: [{ token: "WEB", top_logprobs: [{ token: "WEB", logprob: Math.log(web) }, { token: "NO", logprob: Math.log(no) }] }] });
  assert.ok(Math.abs(_test.webProbability(lp(0.63, 0.37))! - 0.63) < 0.01);
  assert.equal(_test.webProbability(null), null);
  assert.equal(_test.webProbability({ content: [{ token: "Hello", top_logprobs: [{ token: "Hello", logprob: 0 }] }] }), null);
});
test("follow-up detection", () => {
  const prev = [{ text: "The Student List won 52.71% in the 2026 Serbian election, led by cardiologist Ilija Srdanović. Students in blockade organised protests." }];
  assert.ok(_test.looksLikeFollowUp(prev, "And who leads the list?"));
  assert.ok(_test.looksLikeFollowUp(prev, "What did the students demand after the election?"));
  assert.ok(!_test.looksLikeFollowUp(prev, "Write a recipe for pancakes with blueberries and maple syrup"));
  assert.ok(!_test.looksLikeFollowUp([], "And who leads the list?"));
});
test("previous sources are parsed for the follow-up pointer", () => {
  const conv = { messages: [{ versions: [{ content: [{ type: "text", text: 'Q\n\n<web_research date="2026-10-31" sources="2">\n[1](https://a.org/x) First page (2026-10-30)\nbody\n\n---\n\n[2](https://b.org/y) Second page\nbody\n</web_research>' }] }] }, { versions: [{}] }] };
  assert.deepEqual(_test.previousSources(conv), [{ n: 1, url: "https://a.org/x", title: "First page" }, { n: 2, url: "https://b.org/y", title: "Second page" }]);
});
test("passage selection keeps relevant text within budget", async () => {
  const sources = [
    { url: "https://a.org", text: "Cookie banner and menu text.\n" + "The Rusanivka canal surrounds the island and has dancing fountains. ".repeat(5) },
    { url: "https://b.org", text: "Recipes for pancakes and waffles with syrup. ".repeat(20) },
  ];
  const bodies = await _test.selectChunks(sources, "Rusanivka canal fountains", 600);
  assert.match(bodies[0], /fountains/);
  assert.ok(bodies.join("").length <= 700);
  assert.doesNotMatch(bodies[1], /pancakes/);
});
test("wiki creation dates are hidden", () => {
  assert.equal(_test.shortDate("2005-10-02T10:00:00Z", "https://en.wikipedia.org/wiki/X"), "");
  assert.equal(_test.shortDate("2026-10-31T08:00:00Z", "https://news.org/a"), "2026-10-31");
});

test("Russian time phrases and keywords match whole words only", () => {
  const range = (q: string) => _test.TIME_WORDS.find(([re]: any) => re.test(q))?.[1];
  assert.equal(range("новости за день"), "day");
  assert.equal(range("купить за деньги"), undefined);
  assert.equal(range("за годы войны"), undefined);
  assert.equal(range("что изменилось за этот год"), "year");
  assert.ok(!_test.SEE_RE.test("найди информацию о выборах"));
  assert.ok(!_test.SEE_RE.test("biography of Tesla"));
  assert.ok(!_test.SEE_RE.test("a suitable laptop"));
  assert.ok(_test.SEE_RE.test("what does the chart show"));
  assert.ok(!_test.VISUAL_RE.test("Объясни, как работает фотосинтез"));
  assert.ok(!_test.VISUAL_RE.test("внешняя политика Сербии"));
  assert.ok(_test.VISUAL_RE.test("покажи фото канала"));
  assert.ok(_test.VISUAL_RE.test("какой у него внешний вид"));
});
test("URLs with parentheses survive in history and the source list", () => {
  const history = { getMessagesArray: () => [{ getRole: () => "assistant", getText: () => "Mercury [1](https://en.wikipedia.org/wiki/Mercury_(planet)) is small." }] };
  assert.deepEqual(_test.lastAnswerUrls(history), ["https://en.wikipedia.org/wiki/Mercury_(planet)"]);
  const conv = { messages: [{ versions: [{ content: [{ type: "text", text: '<web_research date="x" sources="1">\n[1](https://en.wikipedia.org/wiki/Mercury_(planet)) Mercury\nbody\n</web_research>' }] }] }, {}] };
  assert.equal(_test.previousSources(conv)[0]?.url, "https://en.wikipedia.org/wiki/Mercury_(planet)");
});
test("time limit and Stop also cover a slow body; an earlier Stop is honoured", async () => {
  const srv = http.createServer((_q, res) => { res.writeHead(200, { "content-type": "text/html" }); const t = setInterval(() => res.write("x"), 100); res.on("close", () => clearInterval(t)); });
  await new Promise<void>(r => srv.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(srv.address() as any).port}/`;
  try {
    await hostScope.run(new Set(["127.0.0.1"]), async () => {
      const t0 = Date.now();
      await assert.rejects(async () => readText(await get(url, {}, 600)));
      assert.ok(Date.now() - t0 < 2500, "the time limit ended the body");
      const stopped = AbortSignal.abort();
      await assert.rejects(() => get(url, {}, 5000, stopped));
    });
  } finally { srv.closeAllConnections(); srv.close(); }
});
test("bodies are capped", async () => {
  const srv = http.createServer((_q, res) => { res.end("y".repeat(50_000)); });
  await new Promise<void>(r => srv.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(srv.address() as any).port}/`;
  try { await hostScope.run(new Set(["127.0.0.1"]), async () => assert.equal((await readText(await get(url), 1000)).length, 1000)); }
  finally { srv.close(); }
});
