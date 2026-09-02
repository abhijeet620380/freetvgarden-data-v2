// Combined channel data builder for freetvgarden.com
//
// WHAT THIS DOES DIFFERENTLY FROM THE OLD VERSION:
//   1. Still pulls the full dataset from iptv-org (your primary source).
//   2. ALSO pulls supplementary channels from famelack-data — mainly to
//      pick up their broader YouTube Live coverage that iptv-org doesn't
//      have. Famelack channels are only added if they don't already
//      overlap with an iptv-org channel (matched by name+country).
//   3. NEVER deletes a channel for failing a health check. Every channel
//      that has ever appeared gets a persistent status: "live" or "down".
//      A channel only flips to "down" after 3 CONSECUTIVE failed runs
//      (not one bad check), and flips back to "live" the moment it
//      passes again. This directly fixes "I lost many working channels."
//   4. Writes BOTH:
//        - iptv/*.m3u        (all channels, always — even ones marked
//                              "down" — tagged with a custom
//                              tvg-status="live"/"down" attribute AND
//                              "(Offline)" appended to the display name
//                              as a plain-text fallback for players that
//                              ignore custom attributes)
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
const CONSECUTIVE_FAILS_TO_MARK_DOWN = 3; // don't punish one bad run

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
// IMPORTANT: famelack-data's own README says field names/structure "may
// change without notice." This function is written defensively — it
// tries several likely file paths and several likely field names per
// entry, and SKIPS anything it can't confidently parse rather than
// crashing the whole build. If famelack's schema turns out different
// from what's guessed here, this function will quietly return fewer
// channels than expected rather than breaking your site — check the
// console log line "Famelack: parsed N channels" after a run to see if
// that number looks too low, and we'll adjust the field-name guesses.
// ---------------------------------------------------------------------

const FAMELACK_COUNTRY_CANDIDATES = [
  // We don't know the exact list of country files without seeing the
  // repo's real directory listing, so this build starts from a known
  // set of common ones. Expand this list once you confirm the real
  // filenames (see the discovery script from earlier).
  "us", "gb", "ca", "au", "in", "fr", "de", "es", "it", "br",
  "mx", "jp", "kr", "cn", "ru", "za", "ng", "eg", "ae", "pk"
];

function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== "") return v;
  return "";
}

function normalizeFamelackEntry(raw, countryHint) {
  // Try a range of plausible field names since the real schema isn't
  // confirmed. This is intentionally permissive.
  const name = firstDefined(raw.name, raw.channel_name, raw.title);
  const url = firstDefined(raw.url, raw.stream_url, raw.link, raw.embed_url);
  if (!name || !url) return null; // can't use an entry with no name or no playable url

  const logo = firstDefined(raw.logo, raw.logo_url, raw.icon, "");
  const country = firstDefined(raw.country, raw.country_code, countryHint, "").toUpperCase();
  const category = firstDefined(
    raw.category,
    Array.isArray(raw.categories) ? raw.categories[0] : undefined,
    "General"
  );
  const isYouTube = /youtube\.com|youtu\.be/i.test(url);

  return {
    id: `famelack-${(name + country).replace(/\s+/g, "-").toLowerCase()}`,
    name,
    country,
    language: "",
    logo,
    group: category,
    categories: [],
    url,
    source: "famelack",
    isYouTube
  };
}

async function fetchFamelackSupplementary() {
  console.log("Fetching Famelack supplementary data...");
  const collected = [];

  for (const cc of FAMELACK_COUNTRY_CANDIDATES) {
    const url = `${FAMELACK_BASE}/tv/raw/countries/${cc}.json`;
    try {
      const res = await fetch(url);
      if (!res.ok) continue; // this country file just doesn't exist under this name, skip quietly
      const data = await res.json();
      const list = Array.isArray(data) ? data : Object.values(data || {}).flat();
      for (const raw of list) {
        const entry = normalizeFamelackEntry(raw, cc);
        if (entry) collected.push(entry);
      }
    } catch (e) {
      console.log(`  Famelack fetch failed for ${cc}: ${e.message}`);
    }
  }

  console.log(`Famelack: parsed ${collected.length} channels.`);
  return collected;
}

// ---------------------------------------------------------------------
// STEP 3: health check with in-run retries (no longer a pass/fail
// gate for inclusion — just an input to the persistent status system)
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
  return String(s || "").replace(/"/g, "'").replace(/\r?\n/g, " ");
}

function buildExtinf(ch) {
  const statusSuffix = ch.status === "down" ? " (Offline)" : "";
  return `#EXTINF:-1 tvg-id="${esc(ch.id)}" tvg-country="${esc(ch.country)}" tvg-language="${esc(
    ch.language
  )}" tvg-logo="${esc(ch.logo)}" tvg-status="${esc(ch.status)}" group-title="${esc(ch.group)}",${esc(
    ch.name
  )}${statusSuffix}`;
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
  const famelackChannels = await fetchFamelackSupplementary();

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
      logo: getLogo(ch.id),
      group: (ch.categories && ch.categories[0] && categoryNameById.get(ch.categories[0])) || "General",
      categories: ch.categories || [],
      url,
      source: "iptv-org",
      passedThisRun: workingUrl !== null
    };
  });

  // Health-check Famelack supplementary channels too (same rules)
  console.log(`Checking ${famelackChannels.length} Famelack supplementary channels...`);
  const famelackResults = await mapWithConcurrency(famelackChannels, CONCURRENCY, async ch => {
    // YouTube embed URLs aren't meaningfully HEAD-checkable the same way
    // — treat them as always "passed" at the transport level; actual
    // liveness is YouTube's problem, not a dead-link problem.
    const passedThisRun = ch.isYouTube ? true : await checkStream(ch.url);
    return { ...ch, passedThisRun };
  });

  // Dedupe: don't add a Famelack channel if an iptv-org channel with the
  // same name+country already exists
  const iptvOrgKeySet = new Set(iptvOrgResults.map(c => `${c.name}|${c.country}`.toLowerCase()));
  const famelackDeduped = famelackResults.filter(c => !iptvOrgKeySet.has(`${c.name}|${c.country}`.toLowerCase()));
  console.log(`Famelack: ${famelackDeduped.length}/${famelackResults.length} channels are new (not already in iptv-org).`);

  const allChecked = [...iptvOrgResults, ...famelackDeduped];

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

  await fs.writeFile(path.join(OUT_DIR, "index.m3u"), toM3U(finalChannels));

  // status.json: THIS is what your website should read to show live/down
  // badges reliably, since M3U attributes aren't universally respected
  await fs.writeFile(
    path.join(OUT_DIR, "status.json"),
    JSON.stringify(
      finalChannels.map(c => ({
        id: c.id,
        name: c.name,
        country: c.country,
        source: c.source,
        status: c.status,
        url: c.url
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
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

