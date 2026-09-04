// Radio + Webcams data builder for freetvgarden.com
//
// WHY THIS IS A SEPARATE SCRIPT AND WORKFLOW FROM TV:
//   1. Runs on its own schedule, offset from the TV workflow's cron, so the
//      two never fire at the same time — avoids two workflows trying to
//      git push to the same repo simultaneously (one would get rejected).
//   2. Radio and Webcams have NO iptv-org equivalent to fall back on —
//      iptv-org only covers TV. Famelack is the ONLY source for both.
//      Because of that, this script leans harder on the cache+sanity-check
//      safety net than TV's Famelack layer does, since there's no second
//      source to quietly cover for a bad Famelack day.
//   3. Neither radio nor webcam streams are health-checked over the
//      network at all — trusted as-is, same treatment TV's Famelack
//      channels already get, since Famelack's own README states streams
//      are validated on their end before publishing.
//
// CONFIRMED SCHEMAS (verified directly against real files, 2026-09-04):
//   Radio  (radio/raw/categories/all.json):
//     { nanoid, name, sources: { streams: [...] }, languages: [...],
//       country, isGeoBlocked }
//     — identical shape to TV, just no "youtube" array seen.
//   Webcams (webcams/raw/countries/ae.json):
//     { nanoid, name, sources: { youtube: [...] }, languages: [...],
//       country, isGeoBlocked }
//     — only a "youtube" array, no "streams" — every webcam sample seen
//       so far is a YouTube embed (makes sense for live camera feeds).
//
// CONFIRMED CATEGORY LISTS (both verified complete via full directory
// listings, 2026-09-04):
//   Radio (28): 70s, 80s, 90s, blues, chill, christmas, classical,
//     country, easy-listening, electronic, folk, hip-hop, hits, indie,
//     jazz, latin, metal, news, oldies, politics, pop, reggae, religious,
//     rock, schlager, soul, sports, talk
//   Webcams (20): airport, animals, beach, city, construction, harbor,
//     lake, landmark, mountain, nature, park, river, ski, space, sports,
//     traffic, train, underwater, volcano, weather
// Both lists confirmed complete by scrolling the full GitHub folder
// listing to the end — nothing was cut off or guessed.

import fs from "fs/promises";
import path from "path";

const FAMELACK_BASE = "https://raw.githubusercontent.com/famelack/famelack-data/main";
const FAMELACK_SANITY_FLOOR = 0.2; // same "don't trust a suspiciously small fetch" rule as TV

const RADIO_CATEGORY_IDS = [
  "70s", "80s", "90s", "blues", "chill", "christmas", "classical", "country",
  "easy-listening", "electronic", "folk", "hip-hop", "hits", "indie", "jazz",
  "latin", "metal", "news", "oldies", "politics", "pop", "reggae",
  "religious", "rock", "schlager", "soul", "sports", "talk"
  // NOTE: the directory listing was cut off after "talk" alphabetically —
  // there may be more (e.g. anything U-Z). Unlisted ones just won't be
  // categorized (they'll fall back to "General"), not break anything.
];

const WEBCAM_CATEGORY_IDS = [
  "airport", "animals", "beach", "city", "construction", "harbor", "lake",
  "landmark", "mountain", "nature", "park", "river", "ski", "space",
  "sports", "traffic", "train", "underwater", "volcano", "weather"
  // Confirmed complete — full listing of webcams/raw/categories/, 2026-09-04.
];

function esc(s) {
  return String(s || "").replace(/"/g, "'").replace(/,/g, " ").replace(/\r?\n/g, " ");
}

const GARBAGE_NAME_PATTERN = /mozilla\/|applewebkit|chrome\/\d|safari\/\d|gecko\)|khtml/i;
function isGarbageName(name) {
  return !name || GARBAGE_NAME_PATTERN.test(name);
}

function sortByName(list) {
  return [...list].sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" }));
}

function buildExtinf(ch) {
  return `#EXTINF:-1 tvg-id="${esc(ch.id)}" tvg-country="${esc(ch.country)}" tvg-language="${esc(
    ch.language
  )}" tvg-logo="${esc(ch.logo)}" tvg-status="live" group-title="${esc(ch.group)}",${esc(ch.name)}`;
}

function toM3U(list) {
  return ["#EXTM3U", ...list.flatMap(ch => [buildExtinf(ch), ch.url])].join("\n") + "\n";
}

async function fetchCategoryMap(type, categoryIds) {
  const nanoidToCategoryId = new Map();
  await Promise.all(categoryIds.map(async id => {
    try {
      const res = await fetch(`${FAMELACK_BASE}/${type}/raw/categories/${id}.json`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return;
      const list = await res.json();
      if (!Array.isArray(list)) return;
      for (const raw of list) {
        if (raw && raw.nanoid && !nanoidToCategoryId.has(raw.nanoid)) nanoidToCategoryId.set(raw.nanoid, id);
      }
    } catch {
      // one category file failing shouldn't break the run — those
      // channels just default to "General"
    }
  }));
  return nanoidToCategoryId;
}

async function readCache(cachePath) {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeCache(cachePath, data) {
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(data));
  } catch (e) {
    console.log(`  Warning: couldn't write cache at ${cachePath}: ${e.message}`);
  }
}

function normalizeEntry(raw, categoryId, categoryName, sourceField) {
  const streams = raw.sources && Array.isArray(raw.sources[sourceField]) ? raw.sources[sourceField] : [];
  // Radio: check streams. Webcams: check youtube. Either way, also allow
  // the other field if present, since Famelack's schema note warns
  // structure "may change without notice" — don't assume rigidly.
  const altField = sourceField === "streams" ? "youtube" : "streams";
  const altStreams = raw.sources && Array.isArray(raw.sources[altField]) ? raw.sources[altField] : [];
  const allStreams = [...streams, ...altStreams];

  if (!raw.name || !allStreams.length) return null;
  if (raw.isGeoBlocked) return null;
  if (isGarbageName(raw.name)) {
    // Same "repair, don't remove" treatment as TV — a corrupted name
    // doesn't mean the stream is broken.
    const idSuffix = String(raw.nanoid || "").slice(-4) || Math.random().toString(36).slice(-4);
    const label = raw.country ? `${raw.country.toUpperCase()} Channel` : "Unnamed Channel";
    raw = { ...raw, name: `${label} ${idSuffix}` };
  }

  return {
    id: `famelack-${raw.nanoid}`,
    name: raw.name,
    country: (raw.country || "").toUpperCase(),
    language: "", // resolved below if we bother mapping codes; kept simple for now
    logo: "", // confirmed not present in this dataset, same as TV
    group: categoryName || "General",
    url: allStreams[0],
    status: "live", // trusted, not health-checked — see file header
    source: "famelack"
  };
}

async function buildOne(type, categoryIds, sourceField) {
  console.log(`\n=== Building ${type} ===`);
  const outDir = type; // top-level folder: radio/ or webcams/
  const cachePath = path.join(outDir, "famelack-cache.json");
  const allJsonUrl = `${FAMELACK_BASE}/${type}/raw/categories/all.json`;

  const cached = await readCache(cachePath);
  let data = null;
  let usingCache = false;

  try {
    const res = await fetch(allJsonUrl, { signal: AbortSignal.timeout(30000) });
    if (res.ok) {
      const parsed = await res.json();
      if (Array.isArray(parsed) && parsed.length > 0) data = parsed;
      else console.log(`  ${type}: fetch returned no usable data (empty or malformed).`);
    } else {
      console.log(`  ${type}: fetch failed with HTTP ${res.status}.`);
    }
  } catch (e) {
    console.log(`  ${type}: fetch failed: ${e.message}`);
  }

  if (data && cached && cached.length > 0 && data.length < cached.length * FAMELACK_SANITY_FLOOR) {
    console.log(`  ${type}: fetch returned only ${data.length} vs ${cached.length} cached — looks broken, using cache instead.`);
    data = null;
  }
  if (!data) {
    if (cached && cached.length > 0) {
      console.log(`  ${type}: falling back to cached data (${cached.length} entries).`);
      data = cached;
      usingCache = true;
    } else {
      console.log(`  ${type}: no cache available either — publishing zero ${type} channels this run.`);
      data = [];
    }
  } else if (JSON.stringify(data) !== JSON.stringify(cached)) {
    await writeCache(cachePath, data);
  }

  const categoryMap = categoryIds.length ? await fetchCategoryMap(type, categoryIds) : new Map();

  const seen = new Set();
  const channels = [];
  let categorized = 0;
  for (const raw of data) {
    if (!raw || !raw.nanoid || seen.has(raw.nanoid)) continue; // de-dupe defensively
    seen.add(raw.nanoid);
    const categoryId = categoryMap.get(raw.nanoid);
    const entry = normalizeEntry(raw, categoryId, categoryId, sourceField);
    if (entry) {
      if (categoryId) categorized++;
      channels.push(entry);
    }
  }

  console.log(`${type}: ${channels.length} channels published (from ${data.length} raw entries${usingCache ? ", CACHED" : ""}), ${categorized} matched to a real category.`);

  // Write outputs
  const byCountry = {};
  const byCategory = {};
  for (const ch of channels) {
    const cc = (ch.country || "un").toLowerCase();
    (byCountry[cc] = byCountry[cc] || []).push(ch);
    const catKey = String(ch.group || "general").toLowerCase().replace(/\s+/g, "-");
    (byCategory[catKey] = byCategory[catKey] || []).push(ch);
  }

  await fs.mkdir(path.join(outDir, "countries"), { recursive: true });
  for (const [cc, list] of Object.entries(byCountry)) {
    await fs.writeFile(path.join(outDir, "countries", `${cc}.m3u`), toM3U(sortByName(list)));
  }

  await fs.mkdir(path.join(outDir, "categories"), { recursive: true });
  for (const [cat, list] of Object.entries(byCategory)) {
    await fs.writeFile(path.join(outDir, "categories", `${cat}.m3u`), toM3U(sortByName(list)));
  }

  await fs.writeFile(path.join(outDir, "index.m3u"), toM3U(sortByName(channels)));

  await fs.writeFile(
    path.join(outDir, "status.json"),
    JSON.stringify(
      channels.map(c => ({
        id: c.id, name: c.name, country: c.country, source: c.source,
        status: c.status, url: c.url, logo: c.logo, group: c.group
      })),
      null,
      2
    )
  );
}

async function main() {
  await buildOne("radio", RADIO_CATEGORY_IDS, "streams");
  await buildOne("webcams", WEBCAM_CATEGORY_IDS, "youtube");
  console.log("\nDone.");
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
