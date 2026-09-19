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

async function translateBatch(strings, targetLang) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await translate(strings, { from: "en", to: targetLang });
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

        batch.forEach((item, idx) => {
          if (translated) {
            resultFlat[item.key] = protections[idx].restore(translated[idx]);
          } else {
            // Total failure for this batch — fall back to English so the
            // site never ships a broken/missing string, and don't cache
            // the failure (so it's retried next run).
            console.warn(`  [${lang}] falling back to English for "${item.key}"`);
            resultFlat[item.key] = item.enText;
          }
          if (translated) {
            langCache[item.key] = { en: item.enText, translated: resultFlat[item.key] };
          }
        });

        // Be polite to the (unofficial) API between batches.
        await sleep(300);
      }
    }

    const outPath = path.join(LOCALES_DIR, `${lang}.json`);
    fs.writeFileSync(outPath, JSON.stringify(unflatten(resultFlat), null, 2) + "\n");
  }

  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  console.log("Done.");
}

main().catch((err) => {
  console.error("Translation run failed:", err);
  process.exit(1);
});
