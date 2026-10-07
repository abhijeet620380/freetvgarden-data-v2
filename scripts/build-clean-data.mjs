import fs from "fs/promises";
import path from "path";

const IPTV_ORG_API = "https://iptv-org.github.io/api";
const FAMELACK_BASE = "https://raw.githubusercontent.com/famelack/famelack-data/main";

const OUT_DIR = "iptv";
const CHECK_TIMEOUT_MS = 8000; 
const CHECK_RETRIES = 2; 
const CONCURRENCY = 40;
const CONSECUTIVE_FAILS_TO_MARK_DOWN = 6; 

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
  return r.json();
}

async function fetchIptvOrg() {
  console.log("Fetching iptv-org data...");
  const [channels, streams, categoriesData, logos, feeds, languagesData] = await Promise.all([
    fetchJSON(`${IPTV_ORG_API}/channels.json`),
    fetchJSON(`${IPTV_ORG_API}/streams.json`),
    fetchJSON(`${IPTV_ORG_API}/categories.json`),
    fetchJSON(`${IPTV_ORG_API}/logos.json`),
    fetchJSON(`${IPTV_ORG_API}/feeds.json`),
    fetchJSON(`${IPTV_ORG_API}/languages.json`)
  ]);
  return { channels, streams, categoriesData, logos, feeds, languagesData };
}

const hasNonLatinLetters = s => /\p{L}/u.test(String(s).replace(/\p{Script=Latin}/gu, ""));

function pickNativeName(ch) {
  if (ch.native_name && String(ch.native_name).trim()) return String(ch.native_name).trim();
  const alts = Array.isArray(ch.alt_names) ? ch.alt_names : [];
  const found = alts.find(a => a && hasNonLatinLetters(a));
  return found ? String(found).trim() : "";
}

function normalizeFamelackEntry(raw, categoryId, categoryName) {
  const regularStreams = raw.sources && Array.isArray(raw.sources.streams) ? raw.sources.streams : [];
  const youtubeStreams = raw.sources && Array.isArray(raw.sources.youtube) ? raw.sources.youtube : [];
  const streams = [...regularStreams, ...youtubeStreams];
  if (!raw.name || !streams.length) return null;
  if (raw.isGeoBlocked) return null;

  const isYouTube = youtubeStreams.length > 0;

  return {
    id: `famelack-${raw.nanoid}`,
    name: raw.name,
    native_name: raw.native_name || "",
    country: (raw.country || "").toUpperCase(),
    languageCode: ((raw.languages && raw.languages[0]) || "").toLowerCase(),
    logo: "",
    group: categoryName || "General",
    categories: categoryId ? [categoryId] : [],
    candidateUrls: streams,
    url: streams[0],
    source: "famelack",
    isYouTube
  };
}

async function fetchFamelackCategoryMap(categoryIds) {
  const nanoidToCategoryId = new Map();
  await Promise.all(categoryIds.map(async (id) => {
    try {
      const res = await fetch(`${FAMELACK_BASE}/tv/raw/categories/${id}.json`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return;
      const list = await res.json();
      if (!Array.isArray(list)) return;
      for (const raw of list) {
        if (raw && raw.nanoid && !nanoidToCategoryId.has(raw.nanoid)) nanoidToCategoryId.set(raw.nanoid, id);
      }
    } catch {}
  }));
  return nanoidToCategoryId;
}

const FAMELACK_CACHE_PATH = path.join(OUT_DIR, "famelack-cache.json");
const FAMELACK_SANITY_FLOOR = 0.2;

async function readFamelackCache() {
  try {
    const raw = await fs.readFile(FAMELACK_CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeFamelackCache(data) {
  try {
    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(FAMELACK_CACHE_PATH, JSON.stringify(data));
  } catch (e) {
    console.log(`  Warning: couldn't write Famelack cache: ${e.message}`);
  }
}

async function fetchFamelackSupplementary(categoriesData) {
  console.log("Fetching Famelack data (tv/raw/categories/all.json)...");
  const url = `${FAMELACK_BASE}/tv/raw/categories/all.json`;
  const categoryNameById = new Map(categoriesData.map(c => [c.id, c.name]));
  const cached = await readFamelackCache();

  let data = null;
  let nanoidToCategoryId = new Map();
  try {
    const [res, catMap] = await Promise.all([
      fetch(url),
      fetchFamelackCategoryMap(categoriesData.map(c => c.id))
    ]);
    nanoidToCategoryId = catMap;
    if (res.ok) {
      const parsed = await res.json();
      if (Array.isArray(parsed) && parsed.length > 0) data = parsed;
    }
  } catch (e) {
    console.log(`  Famelack fetch failed: ${e.message}`);
  }

  let usingCache = false;
  if (data && cached && cached.length > 0 && data.length < cached.length * FAMELACK_SANITY_FLOOR) {
    data = null;
  }
  if (!data) {
    if (cached && cached.length > 0) {
      data = cached;
      usingCache = true;
    } else {
      data = [];
    }
  } else if (JSON.stringify(data) !== JSON.stringify(cached)) {
    await writeFamelackCache(data);
  }

  const collected = [];
  let categorized = 0;
  for (const raw of data) {
    const categoryId = raw && raw.nanoid ? nanoidToCategoryId.get(raw.nanoid) : undefined;
    const categoryName = categoryId ? (categoryNameById.get(categoryId) || categoryId) : null;
    const entry = normalizeFamelackEntry(raw, categoryId, categoryName);
    if (entry) {
      if (categoryId) categorized++;
      collected.push(entry);
    }
  }
  console.log(`Famelack: parsed ${collected.length} channels (from ${data.length} raw entries${usingCache ? ", CACHED" : ""}), ${categorized} matched to a real category.`);
  return collected;
}

async function checkStreamOnce(url, referrer, userAgent) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  const headers = {};
  if (referrer) headers["Referer"] = referrer;
  if (userAgent) headers["User-Agent"] = userAgent;

  try {
    let res;
    try {
      res = await fetch(url, { method: "HEAD", headers, signal: controller.signal, redirect: "follow" });
    } catch {
      res = null;
    }
    if (!res || res.status >= 400) {
      res = await fetch(url, {
        method: "GET",
        headers: { ...headers, Range: "bytes=0-2048" },
        signal: controller.signal,
        redirect: "follow"
      });
    }
    return res.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function checkStream(url, referrer, userAgent) {
  for (let attempt = 0; attempt < CHECK_RETRIES; attempt++) {
    if (await checkStreamOnce(url, referrer, userAgent)) return true;
  }
  return false;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const current = idx++;
      results[current] = await fn(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function loadPreviousStatus() {
  try {
    const text = await fs.readFile(path.join(OUT_DIR, "status-history.json"), "utf-8");
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function esc(s) {
  return String(s || "")
    .replace(/"/g, "'")
    .replace(/,/g, " ")
    .replace(/\r?\n/g, " ");
}

const GARBAGE_NAME_PATTERN = /mozilla\/|applewebkit|chrome\/\d|safari\/\d|gecko\)|khtml/i;

function isGarbageName(name) {
  if (!name) return true;
  if (GARBAGE_NAME_PATTERN.test(name)) return true;
  return false;
}

function buildExtinf(ch) {
  const native = ch.native_name ? String(ch.native_name).trim() : "";
  const nat = native && native.toLowerCase() !== String(ch.name || "").trim().toLowerCase()
    ? ` tvg-native-name="${esc(native)}"`
    : "";
  return `#EXTINF:-1 tvg-id="${esc(ch.id)}" tvg-country="${esc(ch.country)}" tvg-language="${esc(
    ch.language
  )}" tvg-logo="${esc(ch.logo)}"${nat} tvg-status="${esc(ch.status)}" group-title="${esc(ch.group)}",${esc(
    ch.name
  )}`;
}

function toM3U(list) {
  return ["#EXTM3U", ...list.flatMap(ch => [buildExtinf(ch), ch.url])].join("\n") + "\n";
}

const YOUTUBE_LIVE = [
  { name: "Al Jazeera English", country: "QA", category: "News", channelId: "UCNye-wNBqNL5ZzHSJj3l8Bg" },
  { name: "Sky News Australia", country: "AU", category: "News", channelId: "UCO0akufu9MOzyz3nvGIXAAw" }
];

function ytEmbedUrl(channelId) {
  return `https://www.youtube.com/embed/live_stream?channel=${channelId}&autoplay=1&mute=1`;
}

// ---------------------------------------------------------------------
// CUSTOM M3U PARSER
// ---------------------------------------------------------------------
async function loadManualChannels() {
  const manualChannels = [];
  const customDir = "custom-channels";
  try {
    const stats = await fs.stat(customDir).catch(() => null);
    if (!stats || !stats.isDirectory()) return manualChannels;

    const files = await fs.readdir(customDir);
    for (const file of files) {
      if (!file.endsWith(".m3u")) continue;
      const content = await fs.readFile(path.join(customDir, file), "utf-8");
      const lines = content.split(/\r?\n/);
      let currentInf = null;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith("#EXTINF:")) {
          currentInf = trimmed;
        } else if (trimmed.startsWith("#")) {
          // Silently ignore tags like #EXTVLCOPT but keep the channel loaded
          continue; 
        } else if (currentInf) {
          // Parse the tags and the URL
          const idMatch = currentInf.match(/tvg-id="([^"]+)"/);
          const countryMatch = currentInf.match(/tvg-country="([^"]+)"/);
          const groupMatch = currentInf.match(/group-title="([^"]+)"/);
          const logoMatch = currentInf.match(/tvg-logo="([^"]+)"/);
          // Also read the language and native name from the custom entry, so custom channels
          // show their language tag and appear on the language pages like every other channel.
          const langMatch = currentInf.match(/tvg-language="([^"]+)"/);
          const nativeMatch = currentInf.match(/tvg-native-name="([^"]+)"/);
          
          const nameParts = currentInf.split(",");
          const name = nameParts.length > 1 ? nameParts.slice(1).join(",").trim() : "Unknown Channel";
          
          manualChannels.push({
            id: idMatch ? idMatch[1] : `manual-${Math.random().toString(36).slice(-6)}`,
            name: name,
            native_name: nativeMatch ? nativeMatch[1].trim() : "",
            country: countryMatch ? countryMatch[1].toUpperCase() : "UN",
            language: langMatch ? langMatch[1].trim() : "", 
            logo: logoMatch ? logoMatch[1] : "",
            group: groupMatch ? groupMatch[1] : "General",
            categories: [],
            url: trimmed,
            source: "custom-m3u",
            status: "live" 
          });
          currentInf = null; 
        }
      }
    }
    console.log(`Loaded ${manualChannels.length} custom channels from ${customDir}/`);
  } catch (e) {
    console.log(`Error reading custom channels: ${e.message}`);
  }
  return manualChannels;
}

// ---------------------------------------------------------------------
// UNPUBLISHED CHANNELS PARSER
// ---------------------------------------------------------------------
async function loadBlockedUrls() {
  const blockedUrls = new Set();
  const blockDir = "unpublished-channels";
  try {
    const stats = await fs.stat(blockDir).catch(() => null);
    if (!stats || !stats.isDirectory()) return blockedUrls;

    const files = await fs.readdir(blockDir);
    for (const file of files) {
      if (!file.endsWith(".txt")) continue;
      const content = await fs.readFile(path.join(blockDir, file), "utf-8");
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        // Ignore empty lines and lines starting with '#'
        if (!trimmed || trimmed.startsWith("#")) continue;
        blockedUrls.add(trimmed);
      }
    }
    console.log(`Loaded ${blockedUrls.size} blocked URLs from ${blockDir}/`);
  } catch (e) {
    console.log(`Error reading blocked channels: ${e.message}`);
  }
  return blockedUrls;
}

// =====================================================================
// LOGO + NATIVE-NAME BACKFILL FOR FAMELACK CHANNELS
// ---------------------------------------------------------------------
// Famelack entries arrive with no logo (and often no native name), while
// iptv-org already knows both for most well-known channels. So for every
// Famelack channel we look for the SAME channel in iptv-org and borrow its
// logo / native name.
//
// PRINCIPLE: a missing logo is better than a WRONG logo. Safeguards:
//   * matching happens inside the SAME country only
//   * names that are just a generic word ("News", "Sport", "Kids"...) never match
//   * if iptv-org has TWO different channels with the same name in a country
//     (different logos), the name is "ambiguous" and is skipped
//   * numbers must agree ("ABC 7" never borrows from "ABC 9")
//   * fuzzy matching is OFF by default (see ALLOW_FUZZY_LOGOS)
//   * native names are only copied from EXACT name matches
//   * every non-exact match is written to iptv/logo-audit.json for review
//
// Match tiers (first hit wins):
//   1. "exact" - same country + identical normalized name (or alt name)
//   2. "loose" - same country + equal after dropping words like "TV"/"Channel"
//   3. "fuzzy" - same country + very similar name (only if ALLOW_FUZZY_LOGOS)
// =====================================================================

// Fuzzy matches are the most likely source of wrong logos ("Star Sports 1" vs
// "Star Sports 2" look nearly identical to a similarity score). Keep OFF unless
// you review iptv/logo-audit.json after enabling it.
const ALLOW_FUZZY_LOGOS = false;

// Single-word names that many unrelated channels share; never match on these alone.
const GENERIC_NAMES = new Set([
  "news", "sport", "sports", "music", "kids", "movies", "movie", "film", "films", "tv",
  "live", "radio", "channel", "general", "entertainment", "comedy", "drama", "documentary",
  "documentaries", "cinema", "series", "family", "junior", "plus", "premium", "classic",
  "mix", "hits", "gold", "one", "two", "life", "world", "international", "online"
]);

// Every automatically-borrowed logo that is NOT an exact match is recorded here
// and written to iptv/logo-audit.json so wrong ones are easy to spot.
const LOGO_AUDIT = [];

// Only accept real web image URLs (no empty strings, data: URIs, relative paths).
const isHttpUrl = u => /^https?:\/\/\S+$/i.test(String(u || "").trim());

// Numbers inside a name, e.g. "ABC 7 Los Angeles" -> "7". Two names with different
// numbers are different channels.
const digitsOf = s => (String(s || "").match(/\d+/g) || []).join(",");

// Normalize a channel name so "Star Plus HD", "STAR PLUS (720p)" and
// "Star Plus" all collapse to the same key.
function normName(s) {
  return String(s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")  // strip Latin accents (e -> e)
    .toLowerCase()
    .replace(/[\(\[\{][^\)\]\}]*[\)\]\}]/g, " ")        // drop "(HD)", "[Geo-blocked]", ...
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")              // keep letters/marks/digits of ANY script
    .replace(/\b(hd|sd|fhd|uhd|4k|hevc|live|online|official)\b/g, " ") // quality / noise tags
    .replace(/\s+/g, " ")
    .trim();
}

// Looser key: additionally drop generic words that differ between sources.
function looseName(s) {
  return normName(s)
    .replace(/\b(tv|television|channel|canal|tele|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Character-bigram multiset, used for the (optional) fuzzy similarity score.
function bigramsOf(s) {
  const t = s.replace(/ /g, "");
  const m = new Map();
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}

// Sorensen-Dice coefficient between two bigram maps (0 = nothing shared, 1 = identical).
function diceScore(a, b) {
  let total = 0, shared = 0;
  for (const v of a.values()) total += v;
  for (const v of b.values()) total += v;
  if (!total) return 0;
  for (const [g, v] of a) if (b.has(g)) shared += Math.min(v, b.get(g));
  return (2 * shared) / total;
}

// Build lookup tables from iptv-org's channels.json.
// Only channels that can actually give us something (a logo or a native name)
// are indexed. Open channels are indexed before closed ones so they win ties.
function buildBrandIndex(channels, getLogo) {
  const exact = new Map();       // "CC|normalized name" -> entry
  const loose = new Map();       // "CC|loose name"      -> entry
  const ambExact = new Set();    // exact keys claimed by 2+ DIFFERENT channels -> never used
  const ambLoose = new Set();    // same, for loose keys
  const byCountry = new Map();   // "CC" -> [{ entry, loose, grams }] for the fuzzy tier

  // Register `entry` under `key`; flag the key as ambiguous if a different
  // channel with a different logo/native name already owns it.
  function put(map, amb, key, entry) {
    const prev = map.get(key);
    if (!prev) { map.set(key, entry); return; }
    if (prev.id !== entry.id && (prev.logo !== entry.logo || prev.native !== entry.native)) amb.add(key);
  }

  const ordered = [...channels].sort((a, b) => (a.closed ? 1 : 0) - (b.closed ? 1 : 0));

  for (const ch of ordered) {
    const cc = String(ch.country || "").toUpperCase();
    if (!cc) continue;
    const rawLogo = getLogo(ch.id);
    const logo = isHttpUrl(rawLogo) ? rawLogo : "";
    const native = pickNativeName(ch);
    if (!logo && !native) continue;                     // nothing useful to lend

    const entry = { id: ch.id, name: ch.name, logo, native };
    const names = [ch.name, ...(Array.isArray(ch.alt_names) ? ch.alt_names : [])];

    for (const nm of names) {
      const n = normName(nm);
      if (!n) continue;
      put(exact, ambExact, `${cc}|${n}`, entry);

      const l = looseName(nm);
      if (l.length >= 4) {
        put(loose, ambLoose, `${cc}|${l}`, entry);
        if (!byCountry.has(cc)) byCountry.set(cc, []);
        byCountry.get(cc).push({ entry, loose: l, grams: bigramsOf(l) });
      }
    }
  }
  return { exact, loose, ambExact, ambLoose, byCountry };
}

// Find the best iptv-org match for one Famelack channel (or null).
function findBrandMatch(ch, index) {
  const cc = String(ch.country || "").toUpperCase();
  if (!cc) return null;                                 // no country -> too risky to guess

  const myNorm = normName(ch.name);
  const myLoose = looseName(ch.name);
  const myDigits = digitsOf(ch.name);

  // Tier 1: exact (English and native name).
  for (const nm of [ch.name, ch.native_name]) {
    const n = normName(nm);
    if (!n || GENERIC_NAMES.has(n)) continue;           // "News" alone is never a match
    const key = `${cc}|${n}`;
    if (index.ambExact.has(key)) return null;           // two different channels share this name
    const hit = index.exact.get(key);
    if (hit) return { entry: hit, tier: "exact" };
  }

  // Tier 2: loose (generic words dropped). Numbers must agree.
  if (myLoose.length >= 4 && !GENERIC_NAMES.has(myLoose) && !GENERIC_NAMES.has(myNorm)) {
    const key = `${cc}|${myLoose}`;
    if (index.ambLoose.has(key)) return null;
    const hit = index.loose.get(key);
    if (hit && digitsOf(hit.name) === myDigits) return { entry: hit, tier: "loose" };
  }

  // Tier 3: fuzzy - disabled unless ALLOW_FUZZY_LOGOS is turned on.
  if (ALLOW_FUZZY_LOGOS && myLoose.length >= 6) {
    const cands = index.byCountry.get(cc) || [];
    const g = bigramsOf(myLoose);
    let best = null, bestScore = 0, second = 0;
    for (const c of cands) {
      if (digitsOf(c.entry.name) !== myDigits) continue;  // "Sports 1" != "Sports 2"
      const sc = diceScore(g, c.grams);
      if (sc > bestScore) { second = bestScore; bestScore = sc; best = c; }
      else if (sc > second && c.entry !== (best && best.entry)) second = sc;
    }
    if (best && bestScore >= 0.94 && bestScore - second >= 0.05) {
      return { entry: best.entry, tier: "fuzzy" };
    }
  }
  return null;
}

// Fill missing logo / native name on the Famelack channels, in place.
function backfillFamelackAssets(list, index) {
  const stats = { checked: 0, logo: { exact: 0, loose: 0, fuzzy: 0 }, native: 0, unmatched: 0 };

  for (const ch of list) {
    const needLogo = !ch.logo;
    const needNative = !ch.native_name;
    if (!needLogo && !needNative) continue;             // already complete
    stats.checked++;

    const m = findBrandMatch(ch, index);
    if (!m) { stats.unmatched++; continue; }

    if (needLogo && m.entry.logo) {
      ch.logo = m.entry.logo;
      stats.logo[m.tier]++;
      // Exact matches are trustworthy; everything else is logged for review.
      if (m.tier !== "exact") {
        LOGO_AUDIT.push({ name: ch.name, country: ch.country, via: m.tier, matchedTo: m.entry.name, matchedId: m.entry.id, logo: m.entry.logo });
      }
    }
    // Native names ONLY from exact matches - a wrong name is far more visible than a wrong logo.
    if (needNative && m.entry.native && m.tier === "exact") {
      ch.native_name = m.entry.native;
      stats.native++;
    }
  }

  console.log(
    `Famelack backfill: checked ${stats.checked} channels missing a logo/native name. ` +
    `Logos filled: ${stats.logo.exact} exact, ${stats.logo.loose} loose, ${stats.logo.fuzzy} fuzzy. ` +
    `Native names filled: ${stats.native}. No match: ${stats.unmatched}.`
  );
}

async function main() {
  const previousStatus = await loadPreviousStatus();

  const { channels, streams, categoriesData, logos, feeds, languagesData } = await fetchIptvOrg();
  const famelackChannels = await fetchFamelackSupplementary(categoriesData);

  const channelById = new Map(channels.map(c => [c.id, c]));
  const categoryNameById = new Map(categoriesData.map(c => [c.id, c.name]));
  const languageNameByCode = new Map(languagesData.map(l => [l.code, l.name]));

  const logoByChannel = new Map();
  const logoByChannelInUse = new Map();
  for (const l of logos) {
    if (!l.channel || !l.url) continue;
    if (!logoByChannel.has(l.channel)) logoByChannel.set(l.channel, l.url);
    if (l.in_use) logoByChannelInUse.set(l.channel, l.url);
  }
  function getLogo(channelId) {
    return logoByChannelInUse.get(channelId) || logoByChannel.get(channelId) || "";
  }

  const langByChannel = new Map();
  const langByChannelMain = new Map();
  for (const f of feeds) {
    if (!f.channel || !f.languages || !f.languages.length) continue;
    const code = f.languages[0];
    if (!langByChannel.has(f.channel)) langByChannel.set(f.channel, code);
    if (f.is_main) langByChannelMain.set(f.channel, code);
  }
  function getLanguage(channelId) {
    const code = langByChannelMain.get(channelId) || langByChannel.get(channelId);
    return code ? languageNameByCode.get(code) || "" : "";
  }
  function getLanguageCode(channelId) {
    return (langByChannelMain.get(channelId) || langByChannel.get(channelId) || "").toLowerCase();
  }

  const groups = new Map();
  for (const s of streams) {
    if (!s.channel || !s.url) continue;
    const ch = channelById.get(s.channel);
    if (!ch || ch.closed) continue;
    if (s.label === "Geo-blocked") continue;
    if (!groups.has(s.channel)) groups.set(s.channel, []);
    groups.get(s.channel).push(s);
  }

  const groupEntries = [...groups.entries()];
  console.log(`Checking ${groupEntries.length} iptv-org channels...`);

  let checkedCount = 0;
  const iptvOrgResults = await mapWithConcurrency(groupEntries, CONCURRENCY, async ([channelId, candidateStreams]) => {
    checkedCount++;
    if (checkedCount % 300 === 0) console.log(`  checked ${checkedCount}/${groupEntries.length}`);

    const ch = channelById.get(channelId);
    let workingUrl = null;
    for (const s of candidateStreams) {
      if (await checkStream(s.url, s.referrer, s.user_agent)) {
        workingUrl = s.url;
        break;
      }
    }
    const url = workingUrl || candidateStreams[0].url;

    return {
      id: ch.id,
      name: ch.name,
      native_name: pickNativeName(ch), 
      country: ch.country || "",
      language: getLanguage(ch.id),
      languageCode: getLanguageCode(ch.id),
      logo: getLogo(ch.id),
      group: (ch.categories && ch.categories[0] && categoryNameById.get(ch.categories[0])) || "General",
      categories: ch.categories || [],
      url,
      candidateUrls: candidateStreams.map(s => s.url),
      source: "iptv-org",
      passedThisRun: workingUrl !== null
    };
  });

  const famelackResults = famelackChannels.map(ch => ({
    ...ch,
    language: languageNameByCode.get(ch.languageCode) || "",
    url: ch.candidateUrls && ch.candidateUrls.length ? ch.candidateUrls[0] : ch.url,
    passedThisRun: true
  }));

  // Famelack sometimes lists the SAME stream under two different names (e.g. "Epic Bharat"
  // and "Epic Bharat Digital" both pointing at one identical URL). Publishing both makes the
  // site show two channels that are really one feed, and confuses anything that looks a
  // channel up by URL. Keep only the first one seen per (country, url); drop the rest.
  {
    const seenUrl = new Map();     // "CC|url" -> name of the one we kept
    const deduped = [];
    let dropped = 0;
    for (const ch of [...famelackResults]) {
      const key = `${ch.country}|${ch.url}`;
      const first = seenUrl.get(key);
      if (!first) { seenUrl.set(key, ch.name); deduped.push(ch); }
      else { dropped++; console.log(`  Famelack duplicate stream: "${ch.name}" [${ch.country}] shares its URL with "${first}" - dropped "${ch.name}".`); }
    }
    famelackResults.length = 0;
    famelackResults.push(...deduped);
    if (dropped) console.log(`Famelack same-URL duplicates removed: ${dropped}.`);
  }

  // Borrow logos / native names from iptv-org for Famelack channels that lack them.
  const brandIndex = buildBrandIndex(channels, getLogo);
  backfillFamelackAssets(famelackResults, brandIndex);

  const byKey = new Map();
  for (const ch of iptvOrgResults) byKey.set(`${ch.name}|${ch.country}`.toLowerCase(), ch);
  let famelackAddedNew = 0, famelackReplacedDead = 0;
  for (const ch of famelackResults) {
    const key = `${ch.name}|${ch.country}`.toLowerCase();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, ch);
      famelackAddedNew++;
    } else {
      // Famelack is a curated source, so it always wins over iptv-org for the same
      // name+country - even when iptv-org's stream is technically still "alive". This
      // matters because iptv-org sometimes has a generic/outdated URL (e.g. a shared
      // Airtel Xstream link) that many differently-named channels default to, which is
      // "live" but wrong, and previously blocked Famelack's correct, distinct URL from
      // ever replacing it.
      if (!ch.native_name && existing.native_name) ch.native_name = existing.native_name;
      if (!ch.logo && existing.logo) ch.logo = existing.logo;   // don't lose the logo when swapping the stream
      byKey.set(key, ch);
      famelackReplacedDead++;
    }
  }

  const allCheckedRaw = [...byKey.values()];
  let sanitizedNames = 0;
  const allChecked = allCheckedRaw.map(ch => {
    if (!isGarbageName(ch.name)) return ch;
    sanitizedNames++;
    const idSuffix = String(ch.id || "").slice(-4) || Math.random().toString(36).slice(-4);
    const label = ch.country ? `${ch.country} Channel` : "Unnamed Channel";
    return { ...ch, name: `${label} ${idSuffix}` };
  });

  const newStatus = {};
  const finalChannels = allChecked.map(ch => {
    const prev = previousStatus[ch.id] || { consecutiveFails: 0, status: "live" };
    let consecutiveFails = prev.consecutiveFails;
    let status;

    if (ch.passedThisRun) {
      consecutiveFails = 0;
      status = "live";
    } else {
      consecutiveFails = prev.consecutiveFails + 1;
      status = consecutiveFails >= CONSECUTIVE_FAILS_TO_MARK_DOWN ? "down" : prev.status;
    }

    newStatus[ch.id] = { consecutiveFails, status, lastChecked: new Date().toISOString(), source: ch.source };

    return { ...ch, status };
  });

  for (const yt of YOUTUBE_LIVE) {
    const id = `yt-${yt.channelId}`;
    finalChannels.push({
      id,
      name: yt.name,
      native_name: "",
      country: yt.country,
      language: "",
      logo: "",
      group: yt.category,
      categories: [],
      url: ytEmbedUrl(yt.channelId),
      source: "curated-youtube",
      status: "live"
    });
    newStatus[id] = { consecutiveFails: 0, status: "live", lastChecked: new Date().toISOString(), source: "curated-youtube" };
  }

  // INJECT CUSTOM M3U CHANNELS HERE
  const manualChannels = await loadManualChannels();
  {
    // Index what's already published (Famelack + iptv-org + curated YouTube) by EXACT
    // name+country (no "HD"/"Digital" stripping - a custom "Zee Cinema HD" entry SHOULD
    // have a different URL than "Zee Cinema", so treating them as "the same channel, no
    // need to check" would hide the exact bug we're looking for) and by URL, so a
    // custom-channels entry that duplicates one of them gets flagged BEFORE it's added.
    const existingByNameCC = new Map();   // "cc|exact name" -> "Existing Name [source]"
    const existingByUrl = new Map();      // url -> "Existing Name [source]"
    const exactKey = (name, cc) => `${String(cc).toUpperCase()}|${String(name || '').trim().toLowerCase()}`;
    for (const c of finalChannels) {
      if (c.name && c.country) existingByNameCC.set(exactKey(c.name, c.country), `${c.name} [${c.source}]`);
      if (c.url) existingByUrl.set(c.url, `${c.name} [${c.source}]`);
    }
    for (const custom of manualChannels) {
      const nameHit = custom.country && existingByNameCC.get(exactKey(custom.name, custom.country));
      const urlHit = custom.url && existingByUrl.get(custom.url);
      // Same name AND same URL as one existing channel -> it's a legitimate re-publish of
      // that exact channel (e.g. a working replacement for a broken source), not a mistake.
      const isIntentionalSameChannel = nameHit && urlHit && nameHit === urlHit;
      if (nameHit && !isIntentionalSameChannel) {
        console.log(`  Custom channel "${custom.name}" [${custom.country}] has the exact same name as an existing channel: ${nameHit}. Check this is meant to replace it, not duplicate it.`);
      }
      if (urlHit && !isIntentionalSameChannel) {
        console.log(`  Custom channel "${custom.name}" [${custom.country || '?'}] uses the SAME stream URL as an existing channel: ${urlHit}. Two different channel names should not share one URL - check for a copy-paste mistake.`);
      }
    }
  }
  for (const custom of manualChannels) {
    // Resolve the custom entry's language name ("Hindi") to its iptv-org code ("hin"), which is
    // what the language pages (languages/hin.m3u) and the language tag are built from.
    if (custom.language && !custom.languageCode) {
      const wantLang = custom.language.trim().toLowerCase();
      for (const [code, langName] of languageNameByCode) {
        if (String(langName).toLowerCase() === wantLang) {
          custom.languageCode = code;
          custom.language = langName;   // use the canonical spelling
          break;
        }
      }
    }
    // Replace, don't duplicate, if a channel with this exact name+country is already
    // published (from Famelack/iptv-org/YouTube, or an earlier custom entry).
    const existingIndex = finalChannels.findIndex(
      c => String(c.name || "").toLowerCase() === String(custom.name || "").toLowerCase() && c.country === custom.country
    );
    if (existingIndex !== -1) finalChannels[existingIndex] = custom;
    else finalChannels.push(custom);
    newStatus[custom.id] = { consecutiveFails: 0, status: "live", lastChecked: new Date().toISOString(), source: "custom-m3u" };
  }

  // Warn about any tvg-id OR stream URL used by more than one PUBLISHED channel, from ANY
  // source (Famelack, iptv-org, custom-channels, curated YouTube). This is what actually
  // catches things like a custom-channels entry accidentally reusing another channel's URL:
  // the website looks a channel up by id in a few places (e.g. re-syncing the live URL when
  // you press play), and by URL in others (e.g. highlighting which row is "now playing"), so
  // either kind of collision can make the site show the wrong channel. Log-only - it does not
  // change which channels get published, and does not touch which one "wins" on the site.
  {
    const byId = new Map(), byUrl = new Map();
    for (const c of finalChannels) {
      if (c.id) { if (!byId.has(c.id)) byId.set(c.id, []); byId.get(c.id).push(c.name); }
      if (c.url) { if (!byUrl.has(c.url)) byUrl.set(c.url, []); byUrl.get(c.url).push(`${c.name} [${c.source}]`); }
    }
    const idDupes = [...byId.entries()].filter(([, names]) => names.length > 1);
    if (idDupes.length) {
      console.log(`WARNING: ${idDupes.length} tvg-id(s) are shared by more than one channel:`);
      for (const [id, names] of idDupes.slice(0, 30)) console.log(`  id "${id}" used by: ${names.join(' | ')}`);
      if (idDupes.length > 30) console.log(`  ...and ${idDupes.length - 30} more.`);
    }
    const urlDupes = [...byUrl.entries()].filter(([, names]) => names.length > 1);
    if (urlDupes.length) {
      console.log(`WARNING: ${urlDupes.length} stream URL(s) are shared by more than one channel - each pair is playing the exact same stream:`);
      for (const [url, names] of urlDupes.slice(0, 30)) console.log(`  ${names.join(' | ')}\n    -> ${url}`);
      if (urlDupes.length > 30) console.log(`  ...and ${urlDupes.length - 30} more.`);
    }
    if (!idDupes.length && !urlDupes.length) console.log("No shared tvg-ids or stream URLs found across published channels.");
  }

  // --- FILTER OUT UNPUBLISHED CHANNELS ---
  const blockedUrls = await loadBlockedUrls();
  const isBlocked = ch => {
    const urls = [ch.url, ...(ch.candidateUrls || [])];
    return urls.some(u => u && blockedUrls.has(String(u).trim()));
  };
  const approvedChannels = finalChannels.filter(ch => !isBlocked(ch));
  const removedCount = finalChannels.length - approvedChannels.length;

  function sortByName(list) {
    return [...list].sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" }));
  }

  const byCountry = {};
  for (const ch of approvedChannels) {
    const cc = (ch.country || "un").toLowerCase();
    (byCountry[cc] = byCountry[cc] || []).push(ch);
  }
  await fs.mkdir(path.join(OUT_DIR, "countries"), { recursive: true });
  for (const [cc, list] of Object.entries(byCountry)) {
    await fs.writeFile(path.join(OUT_DIR, "countries", `${cc}.m3u`), toM3U(sortByName(list)));
  }

  const byCategory = {};
  for (const ch of approvedChannels) {
    const cats = ch.categories && ch.categories.length
      ? ch.categories.map(id => categoryNameById.get(id) || id)
      : [ch.group];
    for (const catName of cats) {
      const key = String(catName).toLowerCase().replace(/\s+/g, "-");
      (byCategory[key] = byCategory[key] || []).push(ch);
    }
  }
  await fs.mkdir(path.join(OUT_DIR, "categories"), { recursive: true });
  for (const [cat, list] of Object.entries(byCategory)) {
    await fs.writeFile(path.join(OUT_DIR, "categories", `${cat}.m3u`), toM3U(sortByName(list)));
  }

  const byLanguage = {};
  for (const ch of approvedChannels) {
    const code = (ch.languageCode || "").trim();
    if (!code) continue;
    (byLanguage[code] = byLanguage[code] || []).push(ch);
  }
  await fs.mkdir(path.join(OUT_DIR, "languages"), { recursive: true });
  for (const [code, list] of Object.entries(byLanguage)) {
    await fs.writeFile(path.join(OUT_DIR, "languages", `${code}.m3u`), toM3U(sortByName(list)));
  }

  await fs.writeFile(path.join(OUT_DIR, "index.m3u"), toM3U(sortByName(approvedChannels)));

  await fs.writeFile(
    path.join(OUT_DIR, "status.json"),
    JSON.stringify(
      approvedChannels.map(c => ({
        id: c.id,
        name: c.name,
        native_name: c.native_name || "",
        country: c.country,
        source: c.source,
        status: c.status,
        url: c.url,
        logo: c.logo || "",
        group: c.group || "",
        language: c.language || ""
      })),
      null,
      2
    )
  );

  await fs.writeFile(path.join(OUT_DIR, "status-history.json"), JSON.stringify(newStatus, null, 2));

  // Report of channels that STILL have no logo after all matching, so the
  // biggest gaps can be fixed by hand (e.g. via a manual override list).
  const noLogo = approvedChannels
    .filter(c => !c.logo)
    .map(c => ({ id: c.id, name: c.name, country: c.country, source: c.source }));
  await fs.writeFile(
    path.join(OUT_DIR, "missing-logos.json"),
    JSON.stringify({ total: noLogo.length, channels: noLogo }, null, 2)
  );
  console.log(`${noLogo.length} published channels still have no logo (see ${OUT_DIR}/missing-logos.json).`);

  // Every logo that was NOT an exact iptv-org match (loose/fuzzy), so a human can
  // quickly scan for wrong ones.
  await fs.writeFile(
    path.join(OUT_DIR, "logo-audit.json"),
    JSON.stringify({ total: LOGO_AUDIT.length, matches: LOGO_AUDIT }, null, 2)
  );
  console.log(`${LOGO_AUDIT.length} non-exact logo matches written to ${OUT_DIR}/logo-audit.json for review.`);

  const liveCount = approvedChannels.filter(c => c.status === "live").length;
  const downCount = approvedChannels.filter(c => c.status === "down").length;
  const nativeCount = approvedChannels.filter(c => c.native_name).length;
  console.log(`Done. ${approvedChannels.length} total channels published (${liveCount} live, ${downCount} down, none deleted). ${nativeCount} have a native name.`);
  console.log(`${removedCount} channels were on the blocklist and removed from the final output.`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
