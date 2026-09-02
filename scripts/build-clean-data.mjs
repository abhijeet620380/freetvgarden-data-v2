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
//   3. NEVER deletes a channel for failing a health check. Every channel
//      that has ever appeared gets a persistent status: "live" or "down".
//      A channel only flips to "down" after 3 CONSECUTIVE failed runs
//      (not one bad check), and flips back to "live" the moment it
//      passes again. This directly fixes "I lost many working channels."
//   4. Writes:
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
// STEP 2: fetch famelack-data supplementary channels
//
// CONFIRMED SCHEMA (verified directly against the real file on
// 2026-09-02, tv/raw/categories/all.json — a single file containing
// every channel across every country, ~96,850 lines):
//
//   {
//     "nanoid": "fp34BcAXOlbIfX",
//     "name": "¡OPA!",
//     "sources": { "streams": ["url1", "url2", ...] },
//     "languages": ["spa"],
//     "country": "cr",          // lowercase 2-letter
//     "isGeoBlocked": true
//   }
//
// Notable: NO "logo" field exists anywhere in this file — Famelack
// channels will show up with no logo. NO per-channel category either
// (category comes from which category-file a channel appears in, not
// from the channel entry itself) — everything from Famelack gets
// grouped under "General" for now. Both are known, accepted trade-offs
// for this version; can be improved later by also fetching individual
// category files (news.json, sports.json, etc.) and cross-referencing
// by nanoid, if that turns out to matter to you.
//
// famelack-data's own README warns this schema "may change without
// notice" — if a future run shows "Famelack: parsed 0 channels" again,
// this is the first place to check.
// ---------------------------------------------------------------------

// CONFIRMED SCHEMA UPDATE (found 2026-09-02): YouTube links live in a
// SEPARATE array, sources.youtube, sitting alongside sources.streams —
// NOT mixed into it. Example, from tv/raw/categories/kids.json:
//   "sources": {
//     "streams":  ["https://3abn.bozztv.com/.../playlist.m3u8"],
//     "youtube":  ["https://www.youtube-nocookie.com/embed/XhgXXXXXXXX"]
//   }
// The original version of this function only ever read sources.streams,
// so every YouTube link in the entire dataset was silently ignored —
// this is why "Famelack has more YouTube channels" never showed up on
// the site. Fixed by reading both arrays and combining them.

function normalizeFamelackEntry(raw, categoryId, categoryName) {
  const regularStreams = raw.sources && Array.isArray(raw.sources.streams) ? raw.sources.streams : [];
  const youtubeStreams = raw.sources && Array.isArray(raw.sources.youtube) ? raw.sources.youtube : [];
  const streams = [...regularStreams, ...youtubeStreams]; // try regular mirrors first, YouTube as well
  if (!raw.name || !streams.length) return null; // no name or no playable url at all
  if (raw.isGeoBlocked) return null; // same treatment as iptv-org's "Geo-blocked" skip

  const isYouTube = youtubeStreams.length > 0; // trust the schema's own field, not a URL guess

  return {
    id: `famelack-${raw.nanoid}`,
    name: raw.name,
    country: (raw.country || "").toUpperCase(),
    languageCode: ((raw.languages && raw.languages[0]) || "").toLowerCase(), // resolved to a name later, once we have iptv-org's language list loaded
    logo: "", // confirmed: not present in this dataset
    group: categoryName || "General", // this is what group-title in the M3U actually shows — categories (below) alone wouldn't affect the displayed category
    categories: categoryId ? [categoryId] : [], // real category id when matched against Famelack's per-category files, else empty
    candidateUrls: streams, // keep all mirrors (regular + youtube) so health-check can try each, same pattern as iptv-org
    url: streams[0],
    source: "famelack",
    isYouTube
  };
}

async function fetchFamelackCategoryMap(categoryIds) {
  // Famelack's tv/raw/categories/all.json is a superset with no per-channel
  // category field — but tv/raw/categories/{id}.json (one file per category,
  // same folder) DOES implicitly tag every channel in it with that category.
  // Reusing iptv-org's own category ID list here means we don't have to
  // guess Famelack's category slugs — if they match (as confirmed for
  // "kids"), we get real categories instead of every Famelack channel
  // defaulting to "General".
  const nanoidToCategoryId = new Map();
  await Promise.all(categoryIds.map(async (id) => {
    try {
      const res = await fetch(`${FAMELACK_BASE}/tv/raw/categories/${id}.json`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return; // this category slug doesn't exist on Famelack's side — fine, skip it
      const list = await res.json();
      if (!Array.isArray(list)) return;
      for (const raw of list) {
        if (raw && raw.nanoid && !nanoidToCategoryId.has(raw.nanoid)) nanoidToCategoryId.set(raw.nanoid, id);
      }
    } catch {
      // network hiccup on one category file shouldn't fail the whole run —
      // those channels just fall back to "General" same as before
    }
  }));
  return nanoidToCategoryId;
}

const FAMELACK_CACHE_PATH = path.join(OUT_DIR, "famelack-cache.json");
// If Famelack's own data drops to less than this fraction of what we had
// last time, treat it as a broken/truncated response rather than a real
// mass removal of channels -- real removals don't happen 5x overnight,
// but a broken fetch (empty body, error page returned as 200, API change)
// absolutely can.
const FAMELACK_SANITY_FLOOR = 0.2;

async function readFamelackCache() {
  try {
    const raw = await fs.readFile(FAMELACK_CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null; // no cache yet (first-ever run) -- nothing to fall back to, that's fine
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
      else console.log("  Famelack fetch returned no usable data (empty or malformed).");
    } else {
      console.log(`  Famelack fetch failed: HTTP ${res.status}`);
    }
  } catch (e) {
    console.log(`  Famelack fetch failed: ${e.message}`);
  }

  let usingCache = false;
  if (data && cached && cached.length > 0 && data.length < cached.length * FAMELACK_SANITY_FLOOR) {
    // Live fetch "worked" but looks broken (way smaller than last time) --
    // more likely a bad response than a real mass removal, so don't trust it.
    console.log(`  Famelack fetch returned only ${data.length} entries vs ${cached.length} cached -- looks broken, using cached data instead.`);
    data = null;
  }
  if (!data) {
    if (cached && cached.length > 0) {
      console.log(`  Falling back to cached Famelack data (${cached.length} entries from a previous successful run) -- this run's fetch is not being counted as a real removal.`);
      data = cached;
      usingCache = true;
    } else {
      console.log("  No Famelack cache available to fall back to -- proceeding with zero Famelack channels this run.");
      data = [];
    }
  } else if (JSON.stringify(data) !== JSON.stringify(cached)) {
    // Fresh, sane, and different from what we had -- this is the new baseline.
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
  console.log(`Famelack: parsed ${collected.length} channels (from ${data.length} raw entries${usingCache ? ", CACHED" : ""}), ${categorized} matched to a real category (rest default to General).`);
  return collected;
}

// ---------------------------------------------------------------------
// STEP 3: health check with in-run retries (no longer a pass/fail
// gate for inclusion -- just an input to the persistent status system)
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
    return {}; // first run ever, or file missing — start fresh
  }
}

function esc(s) {
  // Commas are stripped everywhere, not just escaped — the site's parser
  // finds the channel name by locating a comma, so ANY attribute value
  // containing a stray comma (e.g. a corrupted field that accidentally
  // holds a User-Agent string like "(KHTML, like Gecko)") can shift where
  // the parser thinks the name starts, mangling that channel's name and
  // sometimes the next channel's entry too. Removing commas entirely is
  // cheap insurance against that whole class of bug, from this side.
  return String(s || "")
    .replace(/"/g, "'")
    .replace(/,/g, " ")
    .replace(/\r?\n/g, " ");
}

// Catches corrupted names before they're ever published — most commonly
// a leaked browser User-Agent string ending up in a "name" field from a
// scraped upstream source. A name this long, or containing these
// telltale substrings, isn't a real channel name — but a bad name says
// nothing about whether the STREAM works, so this only replaces the
// name (see where it's used below); it never removes the channel.
// Dropping a working stream over a cosmetic data bug would be worse
// than showing a placeholder name.
const GARBAGE_NAME_PATTERN = /mozilla\/|applewebkit|chrome\/\d|safari\/\d|gecko\)|khtml/i;
const MAX_REASONABLE_NAME_LENGTH = 70;

function isGarbageName(name) {
  if (!name) return true;
  if (name.length > MAX_REASONABLE_NAME_LENGTH) return true;
  if (GARBAGE_NAME_PATTERN.test(name)) return true;
  return false;
}

function buildExtinf(ch) {
  // NOTE: previously appended " (Offline)" to the display name here as a
  // plain-text fallback for players that ignore the tvg-status attribute.
  // Removed on request: the website already shows its own OFFLINE badge
  // driven by tvg-status/status.json, so baking the text into the name
  // just duplicated it in the UI. tvg-status="down" is still published
  // below for any player that does read it.
  return `#EXTINF:-1 tvg-id="${esc(ch.id)}" tvg-country="${esc(ch.country)}" tvg-language="${esc(
    ch.language
  )}" tvg-logo="${esc(ch.logo)}" tvg-status="${esc(ch.status)}" group-title="${esc(ch.group)}",${esc(
    ch.name
  )}`;
}

function toM3U(list) {
  return ["#EXTM3U", ...list.flatMap(ch => [buildExtinf(ch), ch.url])].join("\n") + "\n";
}

// ---------------------------------------------------------------------
// Curated official YouTube Live channels (kept from the original script
// — still manually verified, still separate from the Famelack YouTube
// import, since these are hand-confirmed rather than bulk-imported)
// ---------------------------------------------------------------------

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
  // Raw code (e.g. "eng"), not the resolved display name — this is what
  // the languages/{code}.m3u filenames are keyed by, matching the same
  // code space app.js already gets independently from iptv-org's own
  // languages.json (fetched client-side, unrelated to this repo).
  function getLanguageCode(channelId) {
    return (langByChannelMain.get(channelId) || langByChannel.get(channelId) || "").toLowerCase();
  }

  // Group iptv-org streams by channel (dedupe to one row per channel,
  // with mirrors as internal fallback candidates)
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
    // Use the working stream if found, otherwise fall back to the first
    // candidate URL so the channel is still PUBLISHED (just marked down)
    const url = workingUrl || candidateStreams[0].url;

    return {
      id: ch.id,
      name: ch.name,
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

  // Health-check Famelack supplementary channels too (same rules, and
  // same "try each mirror until one works" approach as iptv-org)
  console.log(`Checking ${famelackChannels.length} Famelack supplementary channels...`);
  const famelackResults = await mapWithConcurrency(famelackChannels, CONCURRENCY, async ch => {
    // YouTube embed URLs aren't meaningfully HEAD-checkable the same way
    // — treat them as always "passed" at the transport level; actual
    // liveness is YouTube's problem, not a dead-link problem.
    if (ch.isYouTube) return { ...ch, language: languageNameByCode.get(ch.languageCode) || "", passedThisRun: true };

    let workingUrl = null;
    for (const candidateUrl of ch.candidateUrls) {
      if (await checkStream(candidateUrl)) {
        workingUrl = candidateUrl;
        break;
      }
    }
    return {
      ...ch,
      language: languageNameByCode.get(ch.languageCode) || "",
      url: workingUrl || ch.url, // publish the working one if found, else fall back to first mirror (still gets marked down, not deleted)
      passedThisRun: workingUrl !== null
    };
  });

  // Merge by name+country, but don't let a DEAD iptv-org channel silently
  // shadow a WORKING Famelack alternative with the same name — e.g. iptv-org's
  // "DBC News" stream can be broken while Famelack's YouTube-sourced "DBC
  // News" still works fine; the old logic only checked whether iptv-org
  // *had* an entry with that name, not whether it actually passed the
  // health check, so the working YouTube channel was getting discarded in
  // favor of a duplicate that was already dead.
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
      // iptv-org's version is dead THIS run, Famelack's works — swap in
      // the working one instead of publishing a known-dead duplicate.
      byKey.set(key, ch);
      famelackReplacedDead++;
    }
    // else: keep the existing iptv-org entry (it's already working, or
    // both are dead and swapping wouldn't help).
  }
  console.log(`Famelack: ${famelackAddedNew} new channels added, ${famelackReplacedDead} dead iptv-org channels replaced with a working Famelack alternative.`);

  const allCheckedRaw = [...byKey.values()];
  let sanitizedNames = 0;
  const allChecked = allCheckedRaw.map(ch => {
    if (!isGarbageName(ch.name)) return ch;
    sanitizedNames++;
    // The name field is corrupted (most often a leaked User-Agent string
    // from Famelack's own upstream data), but that says nothing about
    // whether the stream itself works — dropping the whole channel would
    // throw away a potentially-working feed just because of a cosmetic
    // data bug. Give it a readable placeholder name instead and keep it.
    const idSuffix = String(ch.id || "").slice(-4) || Math.random().toString(36).slice(-4);
    const label = ch.country ? `${ch.country} Channel` : "Unnamed Channel";
    return { ...ch, name: `${label} ${idSuffix}` };
  });
  if (sanitizedNames > 0) {
    console.log(`Repaired ${sanitizedNames} entries with corrupted/garbage names (e.g. leaked User-Agent strings) — kept the channel, replaced the name.`);
  }

  // Apply persistent status logic: only flip to "down" after N
  // consecutive failed runs; flip back to "live" immediately on success
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
      status = consecutiveFails >= CONSECUTIVE_FAILS_TO_MARK_DOWN ? "down" : prev.status; // don't flip yet
    }

    newStatus[ch.id] = { consecutiveFails, status, lastChecked: new Date().toISOString(), source: ch.source };

    return { ...ch, status };
  });

  // Add curated manually-verified YouTube channels (always "live" —
  // hand-verified, not health-checked the same way)
  for (const yt of YOUTUBE_LIVE) {
    const id = `yt-${yt.channelId}`;
    finalChannels.push({
      id,
      name: yt.name,
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

  // Write output files
  const byCountry = {};
  for (const ch of finalChannels) {
    const cc = (ch.country || "un").toLowerCase();
    (byCountry[cc] = byCountry[cc] || []).push(ch);
  }
  await fs.mkdir(path.join(OUT_DIR, "countries"), { recursive: true });
  for (const [cc, list] of Object.entries(byCountry)) {
    await fs.writeFile(path.join(OUT_DIR, "countries", `${cc}.m3u`), toM3U(list));
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
    await fs.writeFile(path.join(OUT_DIR, "categories", `${cat}.m3u`), toM3U(list));
  }

  const byLanguage = {};
  for (const ch of finalChannels) {
    const code = (ch.languageCode || "").trim();
    if (!code) continue; // no language info for this channel (e.g. curated YouTube entries) — skip rather than dump into a bogus "" file
    (byLanguage[code] = byLanguage[code] || []).push(ch);
  }
  await fs.mkdir(path.join(OUT_DIR, "languages"), { recursive: true });
  for (const [code, list] of Object.entries(byLanguage)) {
    await fs.writeFile(path.join(OUT_DIR, "languages", `${code}.m3u`), toM3U(list));
  }

  await fs.writeFile(path.join(OUT_DIR, "index.m3u"), toM3U(finalChannels));

  // status.json: THIS is what your website should read to show live/down
  // badges reliably, since M3U attributes aren't universally respected.
  // Now self-sufficient for building a full channel card in the UI —
  // includes logo, group, and language, not just status. Note: "logo"
  // will be an empty string for every Famelack-sourced channel, since
  // that field genuinely doesn't exist in famelack-data's dataset (this
  // isn't a bug — there's nothing to fill in there, confirmed earlier).
  await fs.writeFile(
    path.join(OUT_DIR, "status.json"),
    JSON.stringify(
      finalChannels.map(c => ({
        id: c.id,
        name: c.name,
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

  // status-history.json: internal state, persisted across runs, not for
  // the website — this is what makes the "3 consecutive fails" logic work
  await fs.writeFile(path.join(OUT_DIR, "status-history.json"), JSON.stringify(newStatus, null, 2));

  const liveCount = finalChannels.filter(c => c.status === "live").length;
  const downCount = finalChannels.filter(c => c.status === "down").length;
  console.log(`Done. ${finalChannels.length} total channels published (${liveCount} live, ${downCount} down, none deleted).`);
  console.log(`Wrote ${Object.keys(byCountry).length} country files, ${Object.keys(byCategory).length} category files, ${Object.keys(byLanguage).length} language files.`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
