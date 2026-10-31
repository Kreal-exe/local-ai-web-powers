#!/usr/bin/env node
// Turns "thinking" OFF by default for MLX/HF models whose chat template uses the Qwen-style
// `enable_thinking` switch (Qwen 3/3.5, Bonsai, many fine-tunes). LM Studio's MLX engine does not pass
// `enable_thinking=false` to the template, so such models always think, sometimes for thousands of tokens.
//
// After patching, reasoning is OFF by default and ON for any message that contains "/think".
//
// Usage (LM Studio ships Node, no install needed):
//   ~/.lmstudio/.internal/utils/node disable-thinking.mjs <model folder>            # turn thinking off
//   ~/.lmstudio/.internal/utils/node disable-thinking.mjs <model folder> --restore  # undo
// Then reload the model in LM Studio. Backups: *.orig-thinking next to the original files.
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
const restore = process.argv.includes("--restore");
if (!dir || !fs.existsSync(dir)) {
  console.error("Usage: node disable-thinking.mjs <model folder> [--restore]");
  process.exit(1);
}
const files = ["chat_template.jinja", "tokenizer_config.json"].map(f => path.join(dir, f)).filter(f => fs.existsSync(f));
if (!files.length) { console.error("No chat_template.jinja or tokenizer_config.json in", dir); process.exit(1); }

if (restore) {
  for (const f of files) {
    const b = f + ".orig-thinking";
    if (fs.existsSync(b)) { fs.copyFileSync(b, f); console.log("restored", path.basename(f)); }
  }
  process.exit(0);
}

const swaps = [
  // System-prompt reasoning instructions only when thinking is explicitly on.
  [/enable_thinking is undefined or enable_thinking is true/g, "enable_thinking is defined and enable_thinking is true"],
  // Generation prompt: open a <think> block only when explicitly asked, otherwise emit an empty one.
  [/\{%-?\s*if enable_thinking is defined and enable_thinking is false\s*-?%\}(\s*\{\{-?\s*'<think>\\n\\n<\/think>\\n\\n'\s*-?\}\}\s*)\{%-?\s*else\s*-?%\}(\s*\{\{-?\s*'<think>\\n'\s*-?\}\}\s*)\{%-?\s*endif\s*-?%\}/g,
    (_m, empty, open) =>
      // "/think" in the last message turns reasoning on for that answer (the web plugin can add it for you).
      `{%- set _tk = namespace(s='') %}` +
      `{%- if messages and messages[-1].content is string %}{%- set _tk.s = messages[-1].content %}` +
      `{%- elif messages and messages[-1].content %}{%- for _p in messages[-1].content %}{%- if _p.text is defined and _p.text %}{%- set _tk.s = _tk.s + _p.text %}{%- endif %}{%- endfor %}{%- endif %}` +
      `{%- if (enable_thinking is defined and enable_thinking is true) or ('/think' in _tk.s) %}${open}{%- else %}${empty}{%- endif %}`],
];

let changed = 0;
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  let text = src;
  if (f.endsWith(".json")) {
    const j = JSON.parse(src);
    if (typeof j.chat_template !== "string") continue;
    let t = j.chat_template;
    for (const [re, to] of swaps) t = t.replace(re, to);
    if (t === j.chat_template) continue;
    j.chat_template = t;
    text = JSON.stringify(j, null, 2);
  } else {
    for (const [re, to] of swaps) text = text.replace(re, to);
    if (text === src) continue;
  }
  if (!fs.existsSync(f + ".orig-thinking")) fs.copyFileSync(f, f + ".orig-thinking");
  fs.writeFileSync(f, text);
  changed++;
  console.log("patched", path.basename(f));
}
console.log(changed ? "Done. Reload the model in LM Studio." : "Nothing to change (already patched, or the template has no enable_thinking switch).");
