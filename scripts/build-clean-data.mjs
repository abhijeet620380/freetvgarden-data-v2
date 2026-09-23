// Combined channel data builder for freetvgarden.com
//
// WHAT THIS DOES DIFFERENTLY FROM THE OLD VERSION:
//   1. Still pulls the full dataset from iptv-org (your primary source).
//   2. ALSO pulls supplementary channels from famelack-data — mainly to
//      pick up their broader YouTube Live coverage that iptv-org doesn't
//      have. A Famelack channel is only skipped if an iptv-org channel
//      with the same name+country is ACTUALLY WORKING this run — a dead
//      iptv-org duplicate gets replaced by a working Famelack channel
//      (e.g. a YouTube-sourced feed) instead of silently winning by
//      default just for having the same name.
//   2b. Famelack's own raw data is cached to iptv/famelack-cache.json on
//      every successful, sane fetch. If Famelack's site goes down, changes
//      its API, or returns a suspiciously truncated response one run, the
//      script falls back to this cache instead of losing every Famelack
//      channel that run — same "don't punish the site for a source's bad
//      day" philosophy as the status-tracking system below.
//   3. Famelack channels are NOT health-checked at all — trusted as always
//      "live" (same treatment the curated YOUTUBE_LIVE list already got).
//      Only iptv-org channels get network-checked each run.
//   4. NEVER deletes an iptv-org channel for failing a health check. Every
//      channel that has ever appeared gets a persistent status: "live" or
//      "down".
//      A channel only flips to "down" after N CONSECUTIVE failed runs
//      (not one bad check), and flips back to "live" the moment it
//      passes again. This directly fixes "I lost many working channels."
//   5. NATIVE NAMES: each channel can carry a native-script name (Arabic,
//      Persian, Hindi, Chinese, ...). Famelack provides `native_name`
//      directly; iptv-org does NOT have that field (its channels.json uses
//      `alt_names`), so for iptv-org we pick the first alias that is written
//      in a non-Latin script. The native name is published:
//        - in every M3U as the custom attribute  tvg-native-name="..."
//          (only when it exists and differs from the display name) — this
//          is what app.js actually reads, because the site parses M3U files
//        - in status.json as "native_name"
//   6. Writes:
//        - iptv/countries/{cc}.m3u   (one file per 2-letter country code)
//        - iptv/categories/{slug}.m3u (one file per category)
//        - iptv/languages/{code}.m3u (one file per language code — matches
//                              the same code space app.js already gets
//                              independently from iptv-org's languages.json;
//                              channels with no known language are skipped
//                              here, not dumped into a bogus "" file)
//        - iptv/index.m3u    (all channels combined)
//        All of the above include channels marked "down", tagged with a
//        custom tvg-status="live"/"down" attribute. The display name is
//        left clean (no "(Offline)" text) — the website reads tvg-status /
//        status.json to show its own OFFLINE badge instead.
//        - iptv/status.json  (channel id -> status, source, fail count —
//                              this is what your WEBSITE should read to
//                              actually show a live/down badge in the UI,
//                              since M3U itself can't represent that
//                              reliably for arbitrary players)
//
// Run on a schedule via the GitHub Actions workflow in this repo.

import fs from "fs/promises";
import path from "path";

const IPTV_ORG_API = "https://iptv-org.github.io/api";
const FAMELACK_BASE = "https://raw.githubusercontent.com/famelack/famelack-data/main";

const OUT_DIR = "iptv";
const CHECK_TIMEOUT_MS = 8000; // bumped from 6s, gives slow-but-alive streams more room
const CHECK_RETRIES = 2; // retry within a single run before counting as a fail
const CONCURRENCY = 40;
const CONSECUTIVE_FAILS_TO_MARK_DOWN = 6; // raised from 3 — see note below on why this alone can't fully solve false-offline flags

// ---------------------------------------------------------------------
// STEP 1: fetch iptv-org data (unchanged from before)
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// NATIVE NAME helper
// iptv-org's channels.json has no `native_name`; it has `alt_names`
// (e.g. ["安徽卫视"]). We use the first alias that contains at least one
// letter that is NOT Latin script, so a French channel doesn't get a
// pointless accented duplicate of its own name. If a source ever does
// provide `native_name` directly, that wins.
// ---------------------------------------------------------------------

const hasNonLatinLetters = s => /\p{L}/u.test(String(s).replace(/\p{Script=Latin}/gu, ""));

function pickNativeName(ch) {
  if (ch.native_name && String(ch.native_name).trim()) return String(ch.native_name).trim();
  const alts = Array.isArray(ch.alt_names) ? ch.alt_names : [];
  const found = alts.find(a => a && hasNonLatinLetters(a));
  return found ? String(found).trim() : "";
}

// ---------------------------------------------------------------------
// STEP 2: fetch famelack-data supplementary channels
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// STEP 3: health check
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// STEP 4: persistent status tracking across runs
// ---------------------------------------------------------------------

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
  // Native name goes into a custom attribute (app.js reads tvg-native-name).
  // Skipped when empty or identical to the display name to keep files small.
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
      native_name: pickNativeName(ch), // native_name if ever present, else first non-Latin alt_name
      country: ch.country || "",
      language: getLanguage(ch.id),
      languageCode: getLanguageCode(ch.id),
      logo: getLogo(ch.id),
      group: (ch.categories && ch.categories[0] && categoryNameById.get(ch.categories[0])) || "General",
      categories: ch.categories || [],
      url,
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

  const byKey = new Map();
  for (const ch of iptvOrgResults) byKey.set(`${ch.name}|${ch.country}`.toLowerCase(), ch);
  let famelackAddedNew = 0, famelackReplacedDead = 0;
  for (const ch of famelackResults) {
    const key = `${ch.name}|${ch.country}`.toLowerCase();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, ch);
      famelackAddedNew++;
    } else if (!existing.passedThisRun && ch.passedThisRun) {
      // keep a native name from the iptv-org entry if Famelack has none
      if (!ch.native_name && existing.native_name) ch.native_name = existing.native_name;
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

  function sortByName(list) {
    return [...list].sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" }));
  }

  const byCountry = {};
  for (const ch of finalChannels) {
    const cc = (ch.country || "un").toLowerCase();
    (byCountry[cc] = byCountry[cc] || []).push(ch);
  }
  await fs.mkdir(path.join(OUT_DIR, "countries"), { recursive: true });
  for (const [cc, list] of Object.entries(byCountry)) {
    await fs.writeFile(path.join(OUT_DIR, "countries", `${cc}.m3u`), toM3U(sortByName(list)));
  }

  const byCategory = {};
  for (const ch of finalChannels) {
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
  for (const ch of finalChannels) {
    const code = (ch.languageCode || "").trim();
    if (!code) continue;
    (byLanguage[code] = byLanguage[code] || []).push(ch);
  }
  await fs.mkdir(path.join(OUT_DIR, "languages"), { recursive: true });
  for (const [code, list] of Object.entries(byLanguage)) {
    await fs.writeFile(path.join(OUT_DIR, "languages", `${code}.m3u`), toM3U(sortByName(list)));
  }

  await fs.writeFile(path.join(OUT_DIR, "index.m3u"), toM3U(sortByName(finalChannels)));

  // status.json: includes native_name for any frontend code that reads JSON
  await fs.writeFile(
    path.join(OUT_DIR, "status.json"),
    JSON.stringify(
      finalChannels.map(c => ({
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

  const liveCount = finalChannels.filter(c => c.status === "live").length;
  const downCount = finalChannels.filter(c => c.status === "down").length;
  const nativeCount = finalChannels.filter(c => c.native_name).length;
  console.log(`Done. ${finalChannels.length} total channels published (${liveCount} live, ${downCount} down, none deleted). ${nativeCount} have a native name.`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
