// Word stems for BM25: Snowball Russian for Cyrillic, Porter for Latin script.
// Prefixes alone miss short forms ("канал"/"канала", "canal"/"canals"); real stemmers join them.

// ---------- Russian (Snowball, https://snowballstem.org/algorithms/russian/stemmer.html) ----------
const RU_VOWELS = "аеиоуыэюя";
const isVowel = (c: string) => RU_VOWELS.includes(c);

// Longest ending first, so "ившись" wins over "ись".
const byLength = (a: string[]) => [...a].sort((x, y) => y.length - x.length);
const PERFECTIVE_1 = byLength(["в", "вши", "вшись"]); // only after а/я
const PERFECTIVE_2 = byLength(["ив", "ивши", "ившись", "ыв", "ывши", "ывшись"]);
const REFLEXIVE = ["ся", "сь"];
const ADJECTIVE = byLength(["ее", "ие", "ые", "ое", "ими", "ыми", "ей", "ий", "ый", "ой", "ем", "им", "ым", "ом", "его", "ого", "ему", "ому", "их", "ых", "ую", "юю", "ая", "яя", "ою", "ею"]);
const PARTICIPLE_1 = byLength(["ем", "нн", "вш", "ющ", "щ"]); // only after а/я
const PARTICIPLE_2 = byLength(["ивш", "ывш", "ующ"]);
const VERB_1 = byLength(["ла", "на", "ете", "йте", "ли", "й", "л", "ем", "н", "ло", "но", "ет", "ют", "ны", "ть", "ешь", "нно"]); // only after а/я
const VERB_2 = byLength(["ила", "ыла", "ена", "ейте", "уйте", "ите", "или", "ыли", "ей", "уй", "ил", "ыл", "им", "ым", "ен", "ило", "ыло", "ено", "ят", "ует", "уют", "ит", "ыт", "ены", "ить", "ыть", "ишь", "ую", "ю"]);
const NOUN = byLength(["а", "ев", "ов", "ие", "ье", "е", "иями", "ями", "ами", "еи", "ии", "и", "ией", "ей", "ой", "ий", "й", "иям", "ям", "ием", "ем", "ам", "ом", "о", "у", "ах", "иях", "ях", "ы", "ь", "ию", "ью", "ю", "ия", "ья", "я"]);
const DERIVATIONAL = ["ость", "ост"];
const SUPERLATIVE = ["ейше", "ейш"];

/** Removes the longest ending of `list` that lies inside the region starting at `from`; "" if none. */
function strip(word: string, from: number, list: string[], afterAYa = false): string | null {
  for (const e of list) {
    if (!word.endsWith(e)) continue;
    const start = word.length - e.length;
    if (start < from) continue;
    if (afterAYa) {
      const prev = word[start - 1];
      if (start - 1 < from || (prev !== "а" && prev !== "я")) continue;
    }
    return word.slice(0, start);
  }
  return null;
}
function regions(w: string) {
  let rv = w.length;
  for (let i = 0; i < w.length; i++) if (isVowel(w[i])) { rv = i + 1; break; }
  const after = (from: number) => {
    for (let i = from; i < w.length - 1; i++) if (isVowel(w[i]) && !isVowel(w[i + 1])) return i + 2;
    return w.length;
  };
  const r1 = after(0);
  return { rv, r2: after(r1) };
}
export function stemRu(input: string): string {
  let w = input.toLowerCase().replace(/ё/g, "е");
  if (w.length < 3) return w;
  const { rv, r2 } = regions(w);
  // Step 1
  let s = strip(w, rv, PERFECTIVE_1, true) ?? strip(w, rv, PERFECTIVE_2);
  if (s !== null) w = s;
  else {
    w = strip(w, rv, REFLEXIVE) ?? w;
    s = strip(w, rv, ADJECTIVE);
    if (s !== null) w = strip(s, rv, PARTICIPLE_1, true) ?? strip(s, rv, PARTICIPLE_2) ?? s;
    else {
      s = strip(w, rv, VERB_1, true) ?? strip(w, rv, VERB_2);
      if (s !== null) w = s;
      else w = strip(w, rv, NOUN) ?? w;
    }
  }
  // Step 2
  if (w.endsWith("и") && w.length - 1 >= rv) w = w.slice(0, -1);
  // Step 3
  w = strip(w, r2, DERIVATIONAL) ?? w;
  // Step 4
  if (w.endsWith("нн") && w.length - 2 >= rv) w = w.slice(0, -1);
  else {
    const sup = strip(w, rv, SUPERLATIVE);
    if (sup !== null) { w = sup; if (w.endsWith("нн")) w = w.slice(0, -1); }
    else if (w.endsWith("ь") && w.length - 1 >= rv) w = w.slice(0, -1);
  }
  return w;
}

// ---------- English (Porter; adapted from wooorm/stemmer, MIT) ----------
const step2list: Record<string, string> = {
  ational: "ate", tional: "tion", enci: "ence", anci: "ance", izer: "ize", bli: "ble", alli: "al", entli: "ent", eli: "e",
  ousli: "ous", ization: "ize", ation: "ate", ator: "ate", alism: "al", iveness: "ive", fulness: "ful", ousness: "ous",
  aliti: "al", iviti: "ive", biliti: "ble", logi: "log",
};
const step3list: Record<string, string> = { icate: "ic", ative: "", alize: "al", iciti: "ic", ical: "ic", ful: "", ness: "" };
const consonant = "[^aeiou]";
const vowel = "[aeiouy]";
const consonants = "(" + consonant + "[^aeiouy]*)";
const vowels = "(" + vowel + "[aeiou]*)";
const gt0 = new RegExp("^" + consonants + "?" + vowels + consonants);
const eq1 = new RegExp("^" + consonants + "?" + vowels + consonants + vowels + "?$");
const gt1 = new RegExp("^" + consonants + "?(" + vowels + consonants + "){2,}");
const vowelInStem = new RegExp("^" + consonants + "?" + vowel);
const consonantLike = new RegExp("^" + consonants + vowel + "[^aeiouwxy]$");
const step2 = /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/;
const step3 = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/;
const step4 = /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/;

export function stemEn(value: string): string {
  let result = value.toLowerCase();
  if (result.length < 3) return result;
  const firstY = result.charCodeAt(0) === 121;
  if (firstY) result = "Y" + result.slice(1);
  if (/^.+?(ss|i)es$/.test(result)) result = result.slice(0, -2);
  else if (/^.+?[^s]s$/.test(result)) result = result.slice(0, -1);
  let m: RegExpExecArray | null;
  if ((m = /^(.+?)eed$/.exec(result))) {
    if (gt0.test(m[1])) result = result.slice(0, -1);
  } else if ((m = /^(.+?)(ed|ing)$/.exec(result)) && vowelInStem.test(m[1])) {
    result = m[1];
    if (/(at|bl|iz)$/.test(result)) result += "e";
    else if (/([^aeiouylsz])\1$/.test(result)) result = result.slice(0, -1);
    else if (consonantLike.test(result)) result += "e";
  }
  if ((m = /^(.+?)y$/.exec(result)) && vowelInStem.test(m[1])) result = m[1] + "i";
  if ((m = step2.exec(result)) && gt0.test(m[1])) result = m[1] + step2list[m[2]];
  if ((m = step3.exec(result)) && gt0.test(m[1])) result = m[1] + step3list[m[2]];
  if ((m = step4.exec(result))) { if (gt1.test(m[1])) result = m[1]; }
  else if ((m = /^(.+?(s|t))(ion)$/.exec(result)) && gt1.test(m[1])) result = m[1];
  if ((m = /^(.+?)e$/.exec(result)) && (gt1.test(m[1]) || (eq1.test(m[1]) && !consonantLike.test(m[1])))) result = m[1];
  if (/ll$/.test(result) && gt1.test(result)) result = result.slice(0, -1);
  if (firstY) result = "y" + result.slice(1);
  return result;
}

/** Stem of one lowercase word in any script; other scripts keep a long prefix. */
export function stem(word: string): string {
  if (/^[a-z]+$/.test(word)) return stemEn(word);
  if (/^[а-яё]+$/.test(word)) return stemRu(word);
  // Serbian Latin, Ukrainian, Serbian Cyrillic and others: drop diacritics, keep a generous prefix.
  return word.normalize("NFD").replace(/\p{M}/gu, "").slice(0, 7);
}
