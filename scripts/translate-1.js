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
 */

const fs = require("fs");
const path = require("path");
const translate = require("google-translate-api-x");

const ROOT = path.join(__dirname, "..");
const LOCALES_DIR = path.join(ROOT, "locales");
const EN_PATH = path.join(LOCALES_DIR, "en.json");
const LANGS_PATH = path.join(LOCALES_DIR, "_langs.json");
const CACHE_PATH = path.join(LOCALES_DIR, "_cache.json");

// Folder code -> code the translation API understands (only where they differ).
const API_LANG = { ua: "uk", zh: "zh-CN", jv: "jw" };
const fellBack = {}; // lang -> number of strings that had to fall back to English

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
  const protectedText = text.replace(/\{[^}]+\}/g, (match) => {
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
function placeholdersIntact(enText, translated) {
  return typeof translated === "string" && translated.trim() !== "" &&
    placeholderSignature(enText) === placeholderSignature(translated);
}

/** Last-resort translation that cannot damage placeholders: translate only the
 *  text BETWEEN placeholders, then put the real {placeholders} back in place.
 *  Word order around a placeholder can be slightly less natural, but the page
 *  is guaranteed to render correctly. Returns null if it cannot be done. */
async function translateSegments(enText, targetLang) {
  const found = enText.match(/\{[^}]+\}/g) || [];
  const segments = enText.split(/\{[^}]+\}/);
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
    for (const key of Object.keys(langCache)) {
      const c = langCache[key];
      if (!c || !placeholdersIntact(c.en, c.translated)) { delete langCache[key]; purged++; }
    }
    if (purged) console.warn(`  [${lang}] purged ${purged} cached string(s) with broken placeholders`);

    // Work out which keys actually need (re)translating.
    const toTranslate = []; // [{key, enText}]
    const resultFlat = {};

    for (const [key, enText] of Object.entries(flatEn)) {
      const cached = langCache[key];
      if (cached && cached.en === enText) {
        resultFlat[key] = cached.translated; // reuse — English hasn't changed
      } else {
        toTranslate.push({ key, enText });
      }
    }

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
            console.warn(`  [${lang}] falling back to English for "${item.key}"`);
            resultFlat[item.key] = item.enText;
            fellBack[lang] = (fellBack[lang] || 0) + 1;
          }
        }

        // Be polite to the (unofficial) API between batches.
        await sleep(300);
      }
    }

    // Safety net: never write a string whose placeholders differ from the English source.
    for (const [key, enText] of Object.entries(flatEn)) {
      if (!placeholdersIntact(enText, resultFlat[key])) resultFlat[key] = enText;
    }

    const outPath = path.join(LOCALES_DIR, `${lang}.json`);
    fs.writeFileSync(outPath, JSON.stringify(unflatten(resultFlat), null, 2) + "\n");
  }

  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));

  // Make silent English fallbacks visible in the Actions log (they used to pass unnoticed).
  const bad = Object.entries(fellBack);
  if (bad.length) {
    for (const [lang, n] of bad) {
      console.log(`::warning title=Untranslated strings::[${lang}] ${n} string(s) fell back to English`);
    }
  } else {
    console.log("All languages fully translated.");
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error("Translation run failed:", err);
  process.exit(1);
});
