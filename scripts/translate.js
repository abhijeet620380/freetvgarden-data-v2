#!/usr/bin/env node
/**
 * translate.js
 * ------------
 * Reads locales/en.json (the source of truth) and generates a translated
 * locales/{lang}.json for every language listed in locales/_langs.json.
 *
 * Design notes (read before changing):
 *
 * - CACHING: locales/_cache.json stores, per key+language, the English
 *   source string that was translated and the result. On every run we only
 *   call the translation API for keys whose English value has changed
 *   since the last run, or that are brand new. This keeps GitHub Actions
 *   minutes and API calls down — with 73 languages, re-translating
 *   everything on every push would be slow and easy to rate-limit.
 *
 * - PLACEHOLDERS: strings like "{verb} {channelName} Live" contain tokens
 *   that must survive translation untouched (channel/country names are
 *   never translated — see the conversation this was built from). Before
 *   sending text to the API we swap "{xyz}" for a placeholder token the
 *   translator is unlikely to mangle, then restore it after.
 *
 * - BATCHING: each language is translated in one or few calls (an array of
 *   strings per call) rather than one call per key, since google-translate-
 *   api-x accepts an array and this cuts total requests by ~100x.
 *
 * - LANGUAGE CODES (added after audit): three of our folder codes are not codes the
 *   translation API knows - ua (Ukrainian = "uk"), zh (Chinese = "zh-CN"), jv
 *   (Javanese = "jw"). Sending them made every call fail, and the silent English
 *   fallback shipped 340 untranslated strings for each. API_LANG maps them.
 *
 * - BRAND / NAME PROTECTION (added after audit): "FreeTV Garden" came back altered in
 *   61 of 73 languages ("FreeTV Сад", "Jardín FreeTV", "FreeTV-Garten", ...). Brand
 *   names and URLs listed in PROTECTED_TERMS are now protected exactly like
 *   {placeholders}: swapped for a marker before translation and restored after, and
 *   the result is validated to contain them unchanged. Translations already in the
 *   cache that changed a protected term are re-translated; if that fails, the previous
 *   (structurally fine) translation is kept rather than falling back to English.
 *
 * - VALIDATION (added after audit): machine translation sometimes mangles the
 *   __PHn__ markers (Serbian turned them into Cyrillic "__ПХ0__", Xhosa lost an
 *   underscore, Hindi dropped one entirely). Every translated string is now checked
 *   to contain EXACTLY the same {placeholders} as the English source. A string that
 *   fails is re-translated segment by segment (the text between placeholders is
 *   translated on its own and the real placeholders are re-inserted, so they can
 *   never be damaged). If that fails too, the English string is used. Invalid
 *   results are never cached, and invalid entries already in the cache are purged
 *   at the start of every run so they heal on the next run.
 *
 * - BEST-EFFORT: if a language's translation call fails after retries, we
 *   fall back to the English string for just those keys (with a warning),
 *   rather than failing the whole run over one flaky language.
 *
 * - MANUAL_OVERRIDES (added after audit): everything above is the automatic
 *   pipeline and needs no attention day to day — every key, every language,
 *   every run. MANUAL_OVERRIDES is a small escape hatch for the rare case
 *   where machine translation gets a short, context-free string wrong (e.g.
 *   an isolated verb like "Watch" coming back as the noun "wristwatch").
 *   Add an entry as MANUAL_OVERRIDES["hi"]["verbWatch"] = "देखें" and, from
 *   the next run on, that exact key+language pair always uses your text
 *   instead of calling the API — it's applied BEFORE any API call, checked
 *   BEFORE the cache-reuse check, and re-applied on every run even if the
 *   English source string changes, so it can never be silently
 *   overwritten by a fresh machine translation. It only touches the
 *   language/key pairs you list; every other language and every other key
 *   keeps being translated automatically exactly as before. To undo one,
 *   just delete its line here — the next run re-translates that key
 *   normally and re-caches a fresh machine translation for it.
 */

const fs = require("fs");
const path = require("path");
const translate = require("google-translate-api-x");

const ROOT = path.join(__dirname, "..");
const LOCALES_DIR = path.join(ROOT, "locales");
const EN_PATH = path.join(LOCALES_DIR, "en.json");
const LANGS_PATH = path.join(LOCALES_DIR, "_langs.json");
const CACHE_PATH = path.join(LOCALES_DIR, "_cache.json");

// Names and URLs that must appear in every language exactly as written. Longest first.
const PROTECTED_TERMS = [
  "freetool.odoo.com", "freetvgarden.com", "FreeTool TV Garden", "FreeTV Garden",
  "radio.garden", "tv.garden", "iptv-org", "Famelack",
];
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Everything that must survive translation untouched: {placeholders} and the terms above.
const PROTECTED_RE = new RegExp("\\{[^}]+\\}|" + PROTECTED_TERMS.map(escapeRe).join("|"), "g");

// Hand-corrected translations for specific key+language pairs. Always wins over the
// machine translator and over whatever is already cached for that key+language — see
// the MANUAL_OVERRIDES note in the file header above. Leave empty ({}) to change nothing;
// fill in only the pairs you've actually checked and found wrong.
//
//   const MANUAL_OVERRIDES = {
//     hi: { verbWatch: "देखें", verbListen: "सुनें" },
//     es: { verbWatch: "Ver" },
//   };
const MANUAL_OVERRIDES = {
  af: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  am: { menuChill: "ቺል", menuCountry: "ካንትሪ", menuRock: "ሮክ", menuSoul: "ሶል" },
  ar: { menuChill: "تشيل", menuCountry: "كانتري", menuRock: "روك", menuSoul: "سول" },
  as: { menuChill: "চিল", menuCountry: "কাণ্ট্ৰী", menuRock: "ৰক", menuSoul: "সৌল" },
  az: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  bg: { menuChill: "Чил", menuCountry: "Кънтри", menuRock: "Рок", menuSoul: "Соул" },
  bn: { menuChill: "চিল", menuCountry: "কান্ট্রি", menuRock: "রক", menuSoul: "সোল" },
  bo: { menuChill: "ཅིལ", menuCountry: "ཁོན་ཊི", menuRock: "རོཀ", menuSoul: "སོལ" },
  cs: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  da: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  de: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  el: { menuChill: "Τσιλ", menuCountry: "Κάντρι", menuPop: "Ποπ", menuRock: "Ροκ", menuSoul: "Σόουλ" },
  es: { menuChill: "Chill", menuCountry: "Country", menuPop: "Pop", menuRock: "Rock", menuSoul: "Soul" },
  et: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  fa: { menuChill: "چیل", menuCountry: "کانتری", menuRock: "راک", menuSoul: "سول" },
  fi: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  fr: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  gu: { menuCountry: "કન્ટ્રી", menuRock: "રોક", menuSoul: "સોલ" },
  ha: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  he: { menuChill: "צִ'יל", menuCountry: "קאנטרי", menuRock: "רוֹק", menuSoul: "סוֹל" },
  hi: { menuChill: "चिल", menuCountry: "कंट्री", menuPop: "पॉप", menuRock: "रॉक", menuSoul: "सोल" },
  hr: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  hu: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  hy: { menuChill: "Չիլ", menuCountry: "Քանթրի", menuRock: "Ռոք", menuSoul: "Սոուլ" },
  id: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  ig: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  it: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  ja: { menuCountry: "カントリー", menuRock: "ロック", menuSoul: "ソウル" },
  jv: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  ka: { menuChill: "ჩილი", menuCountry: "კანტრი", menuRock: "როკი", menuSoul: "სოული" },
  kk: { menuChill: "Чилл", menuCountry: "Кантри", menuRock: "Рок", menuSoul: "Соул" },
  km: { menuChill: "ឈិល", menuCountry: "ខោនទ្រី", menuRock: "រ៉ុក", menuSoul: "សូល" },
  kn: { menuCountry: "ಕಂಟ್ರಿ", menuRock: "ರಾಕ್", menuSoul: "ಸೋಲ್" },
  ko: { menuChill: "칠", menuCountry: "컨트리", menuRock: "록", menuSoul: "소울" },
  ku: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  lo: { menuChill: "ຊິວ", menuCountry: "ຄັນທຣີ", menuRock: "ຣັອກ", menuSoul: "ໂຊລ" },
  lt: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  lv: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  ml: { menuChill: "ചിൽ", menuCountry: "കൺട്രি", menuRock: "റോക്ക്", menuSoul: "സോൾ" },
  mn: { menuChill: "Чилл", menuCountry: "Кантри", menuRock: "Рок", menuSoul: "Соул" },
  mr: { menuCountry: "कंट्री", menuRock: "रॉक", menuSoul: "सोल" },
  ms: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  my: { menuChill: "ချစ်လ်", menuCountry: "ကွမ်းထရီ", menuPop: "ပော့ပ်", menuRock: "ရော့ခ်", menuSoul: "ဆိုးလ်" },
  ne: { menuCountry: "कन्ट्री", menuRock: "रक", menuSoul: "सोल" },
  nl: { menuChill: "Chill", menuCountry: "Country", menuPop: "Pop", menuRock: "Rock", menuSoul: "Soul" },
  no: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  or: { menuChill: "ଚିଲ", menuCountry: "କାଣ୍ଟ୍ରି", menuRock: "ରକ୍", menuSoul: "ସୋଲ" },
  pa: { menuChill: "ਚਿੱਲ", menuCountry: "ਕੰਟਰੀ", menuRock: "ਰੌਕ", menuSoul: "ਸੋਲ" },
  pl: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  ps: { menuCountry: "کانټري", menuRock: "راک", menuSoul: "سول" },
  pt: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  ro: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  ru: { menuChill: "Чилл", menuCountry: "Кантри", menuRock: "Рок", menuSoul: "Соул" },
  si: { menuChill: "චිල්", menuCountry: "කන්ට්‍රි", menuRock: "රොක්", menuSoul: "සෝල්" },
  sk: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  sl: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  so: { menuChill: "Chill", menuCountry: "Country", menuPop: "Pop", menuRock: "Rock", menuSoul: "Soul" },
  sr: { menuChill: "Чил", menuCountry: "Кантри", menuRock: "Рок" },
  sv: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  sw: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  ta: { menuChill: "சில்", menuCountry: "கண்ட்ரி", menuRock: "ராக்", menuSoul: "சோல்" },
  te: { menuChill: "చిల్", menuCountry: "కంట్రీ", menuRock: "రాక్", menuSoul: "సోల్" },
  th: { menuChill: "ชิล", menuCountry: "คันทรี", menuPop: "ป็อป", menuRock: "ร็อก", menuSoul: "โซล" },
  tl: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  tr: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  ua: { menuChill: "Чилл", menuCountry: "Кантрі", menuRock: "Рок", menuSoul: "Соул" },
  ur: { menuChill: "چل", menuCountry: "کنٹری", menuRock: "راک", menuSoul: "سول" },
  uz: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  vi: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  xh: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  yo: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
  zh: { menuChill: "Chill", menuCountry: "乡村音乐", menuRock: "摇滚", menuSoul: "Soul" },
  zu: { menuChill: "Chill", menuCountry: "Country", menuRock: "Rock", menuSoul: "Soul" },
};

// Folder code -> code the translation API understands (only where they differ).
const API_LANG = { ua: "uk", zh: "zh-CN", jv: "jw" };
const fellBack = {}; // lang -> number of strings that had to fall back to English
const keptOld = {};  // lang -> number of strings that kept their previous translation because the retry failed

const BATCH_SIZE = 50; // strings per API call
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

// ---- helpers ----------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Flatten {a:{b:"x"}} -> {"a.b": "x"} */
function flatten(obj, prefix = "") {
  const out = {};
  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (val && typeof val === "object" && !Array.isArray(val)) {
      Object.assign(out, flatten(val, fullKey));
    } else {
      out[fullKey] = val;
    }
  }
  return out;
}

/** Un-flatten {"a.b": "x"} -> {a:{b:"x"}} */
function unflatten(flat) {
  const out = {};
  for (const [key, val] of Object.entries(flat)) {
    const parts = key.split(".");
    let node = out;
    for (let i = 0; i < parts.length - 1; i++) {
      node = node[parts[i]] = node[parts[i]] || {};
    }
    node[parts[parts.length - 1]] = val;
  }
  return out;
}

/** Replace {placeholder} tokens with translator-safe markers; returns
 *  [protectedText, restoreFn]. */
function protectPlaceholders(text) {
  const found = [];
  const protectedText = text.replace(PROTECTED_RE, (match) => {
    found.push(match);
    // A token unlikely to be split/translated by MT engines.
    return ` __PH${found.length - 1}__ `;
  });
  return {
    protectedText,
    restore(translatedText) {
      return found
        .reduce(
          (acc, original, i) =>
            acc.replace(new RegExp(`__PH${i}__`, "gi"), original),
          translatedText
        )
        // Collapse any extra spacing the placeholder swap introduced.
        .replace(/\s{2,}/g, " ")
        .trim();
    },
  };
}

/** The {placeholders} in a string, sorted, as one comparable string ("" if none). */
function placeholderSignature(text) {
  return (String(text).match(/\{[^}]+\}/g) || []).slice().sort().join("|");
}
/** {placeholders} AND protected names/URLs, sorted, as one comparable string. */
function protectedSignature(text) {
  return (String(text).match(PROTECTED_RE) || []).slice().sort().join("|");
}
/** Structurally usable: not empty, exactly the English {placeholders}, no leftover or
 *  mangled __PHn__ markers (e.g. "_PH0__", "__ПХ0__"). */
function structureOk(enText, translated) {
  return typeof translated === "string" && translated.trim() !== "" &&
    !/_{1,2}[^\s{}_]{1,3}\d+_{1,2}/.test(translated) &&
    placeholderSignature(enText) === placeholderSignature(translated);
}
/** Fully valid: structurally usable AND every protected name/URL is unchanged. */
function placeholdersIntact(enText, translated) {
  return structureOk(enText, translated) &&
    protectedSignature(enText) === protectedSignature(translated);
}

/** Last-resort translation that cannot damage placeholders: translate only the
 *  text BETWEEN placeholders, then put the real {placeholders} back in place.
 *  Word order around a placeholder can be slightly less natural, but the page
 *  is guaranteed to render correctly. Returns null if it cannot be done. */
async function translateSegments(enText, targetLang) {
  const found = enText.match(PROTECTED_RE) || [];
  const segments = enText.split(PROTECTED_RE);
  const toSend = [];
  segments.forEach((seg, i) => { if (/\p{L}/u.test(seg)) toSend.push({ i, seg }); });
  const out = await translateBatch(toSend.map((x) => x.seg.trim()), targetLang);
  if (!out) return null;
  const byIndex = {};
  toSend.forEach((x, n) => {
    const lead = (x.seg.match(/^\s*/) || [""])[0];
    const trail = (x.seg.match(/\s*$/) || [""])[0];
    byIndex[x.i] = lead + String(out[n]).trim() + trail;
  });
  let result = "";
  segments.forEach((seg, i) => {
    result += (i in byIndex ? byIndex[i] : seg) + (i < found.length ? found[i] : "");
  });
  return result.replace(/\s{2,}/g, " ").trim();
}

async function translateBatch(strings, targetLang) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await translate(strings, { from: "en", to: API_LANG[targetLang] || targetLang });
      // google-translate-api-x returns a single object for a single string
      // input, or an array for array input — normalize to array.
      const arr = Array.isArray(res) ? res : [res];
      return arr.map((r) => r.text);
    } catch (err) {
      console.warn(
        `  [${targetLang}] batch attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`
      );
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  return null; // signal total failure for this batch
}

// ---- main ---------------------------------------------------------------

async function main() {
  const en = JSON.parse(fs.readFileSync(EN_PATH, "utf8"));
  const langs = JSON.parse(fs.readFileSync(LANGS_PATH, "utf8"));
  const cache = fs.existsSync(CACHE_PATH)
    ? JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"))
    : {};

  const flatEn = flatten(en);
  const langCodes = Object.keys(langs);

  console.log(`Source strings: ${Object.keys(flatEn).length}`);
  console.log(`Target languages: ${langCodes.length}`);

  for (const lang of langCodes) {
    cache[lang] = cache[lang] || {};
    const langCache = cache[lang];

    // Heal old damage: drop cached translations whose placeholders don't match the
    // English source, so they get re-translated below.
    let purged = 0;
    const stale = {}; // key -> previous translation that is structurally fine (e.g. only the brand name was altered)
    for (const key of Object.keys(langCache)) {
      const c = langCache[key];
      if (!c || !placeholdersIntact(c.en, c.translated)) {
        if (c && structureOk(c.en, c.translated)) stale[key] = { en: c.en, translated: c.translated };
        delete langCache[key];
        purged++;
      }
    }
    if (purged) console.warn(`  [${lang}] purged ${purged} cached string(s) (broken placeholders or altered brand names)`);

    const overrides = MANUAL_OVERRIDES[lang] || {};
    let overrideCount = 0;

    // Work out which keys actually need (re)translating.
    const toTranslate = []; // [{key, enText}]
    const resultFlat = {};

    for (const [key, enText] of Object.entries(flatEn)) {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) {
        // Manual correction always wins — never sent to the API, never read from
        // cache, and re-applied every run so a fresh machine translation can't
        // quietly replace it later.
        resultFlat[key] = overrides[key];
        langCache[key] = { en: enText, translated: overrides[key], override: true };
        overrideCount++;
        continue;
      }
      const cached = langCache[key];
      if (cached && cached.en === enText) {
        resultFlat[key] = cached.translated; // reuse — English hasn't changed
      } else {
        toTranslate.push({ key, enText });
      }
    }
    if (overrideCount) console.log(`  [${lang}] applied ${overrideCount} manual override(s)`);

    if (toTranslate.length === 0) {
      console.log(`[${lang}] up to date, nothing to translate.`);
    } else {
      console.log(`[${lang}] translating ${toTranslate.length} string(s)...`);

      for (let i = 0; i < toTranslate.length; i += BATCH_SIZE) {
        const batch = toTranslate.slice(i, i + BATCH_SIZE);
        const protections = batch.map((item) => protectPlaceholders(item.enText));
        const inputs = protections.map((p) => p.protectedText);

        const translated = await translateBatch(inputs, lang);

        for (let idx = 0; idx < batch.length; idx++) {
          const item = batch[idx];
          let value = translated && translated[idx] != null ? protections[idx].restore(translated[idx]) : null;
          let ok = value !== null && placeholdersIntact(item.enText, value);

          if (translated && !ok) {
            // The engine damaged a placeholder: redo this string segment by segment.
            console.warn(`  [${lang}] placeholder damaged in "${item.key}" -> retrying by segments`);
            value = await translateSegments(item.enText, lang);
            ok = value !== null && placeholdersIntact(item.enText, value);
          }

          if (ok) {
            resultFlat[item.key] = value;
            langCache[item.key] = { en: item.enText, translated: value };   // only valid results are cached
          } else {
            // Total failure — fall back to English so the site never ships a broken
            // or missing string, and don't cache it (so it is retried next run).
            const old = stale[item.key];
            if (old && old.en === item.enText) {
              console.warn(`  [${lang}] keeping previous translation for "${item.key}" (retry failed)`);
              resultFlat[item.key] = old.translated;   // not cached, so it is retried next run
              keptOld[lang] = (keptOld[lang] || 0) + 1;
            } else {
              console.warn(`  [${lang}] falling back to English for "${item.key}"`);
              resultFlat[item.key] = item.enText;
              fellBack[lang] = (fellBack[lang] || 0) + 1;
            }
          }
        }

        // Be polite to the (unofficial) API between batches.
        await sleep(300);
      }
    }

    // Safety net: never write a string whose placeholders differ from the English source.
    // Applies to manual overrides too — if you override a key that has {placeholders}, your
    // replacement text must include the exact same ones, or it's rejected here and this
    // logs it so the mistake is visible instead of silently falling back to English.
    for (const [key, enText] of Object.entries(flatEn)) {
      if (!structureOk(enText, resultFlat[key])) {
        if (Object.prototype.hasOwnProperty.call(overrides, key)) {
          console.warn(`  [${lang}] manual override for "${key}" rejected (placeholders don't match English) — using English instead`);
          delete langCache[key];
        }
        resultFlat[key] = enText;
      }
    }

    const outPath = path.join(LOCALES_DIR, `${lang}.json`);
    fs.writeFileSync(outPath, JSON.stringify(unflatten(resultFlat), null, 2) + "\n");
  }

  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));

  // Make silent English fallbacks visible in the Actions log (they used to pass unnoticed).
  const bad = Object.entries(fellBack);
  const kept = Object.entries(keptOld);
  for (const [lang, n] of bad) {
    console.log(`::warning title=Untranslated strings::[${lang}] ${n} string(s) fell back to English`);
  }
  for (const [lang, n] of kept) {
    console.log(`::warning title=Retry needed::[${lang}] ${n} string(s) kept their previous translation (retry failed, will be retried next run)`);
  }
  if (!bad.length && !kept.length) console.log("All languages fully translated.");
  console.log("Done.");
}

main().catch((err) => {
  console.error("Translation run failed:", err);
  process.exit(1);
});
