// Radio Globe data builder for freetvgarden.com
//
// FULLY INDEPENDENT from the existing Famelack-based radio/webcams
// pipeline (build-radio-webcams-data.mjs). This script:
//   - Does not read from, write to, or depend on anything in radio/
//     or webcams/ folders.
//   - Sources from Radio Browser (radio-browser.info), a free,
//     open, community-maintained radio directory — chosen
//     specifically because it provides genuine per-station
//     geo_lat/geo_long coordinates, which Famelack's dataset does
//     not have at all (confirmed earlier — no city/lat/long field
//     exists in Famelack's radio schema).
//   - Runs on its own schedule (see the matching workflow file),
//     offset from every other existing workflow, so it never
//     collides on a git push.
//
// This dataset is ONLY for the satellite globe view (station dots +
// click-to-play via Radio Browser's own stream URLs) — it does not
// feed the existing country/category radio browsing UI, and is not
// merged with Famelack's station list at this stage. That merge is
// an intentional future step, not part of this script.

import fs from "fs/promises";
import path from "path";

// Radio Browser publishes multiple independent mirror servers. Per
// their own usage guidance, a well-behaved client should try more
// than one and fall back on failure, and always send a descriptive
// User-Agent identifying the calling application.
const RADIO_BROWSER_MIRRORS = [
  "https://de1.api.radio-browser.info",
  "https://de2.api.radio-browser.info",
  "https://fi1.api.radio-browser.info",
  "https://at1.api.radio-browser.info"
];

const USER_AGENT = "FreeTVGarden-RadioGlobe/1.0 (+https://freetvgarden.com)";
const PAGE_SIZE = 5000; // Radio Browser's search endpoint is paginated
const OUT_DIR = "radio-globe";
const SANITY_FLOOR = 0.5; // don't trust a fetch returning less than half of last time's count

async function fetchPage(mirror, offset) {
  const url = `${mirror}/json/stations/search?has_geo_info=true&hidebroken=true&order=clickcount&reverse=true&limit=${PAGE_SIZE}&offset=${offset}`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("unexpected response shape");
  return data;
}

async function fetchAllStations() {
  // Try each mirror in turn; once one works, stay on it for all pages
  // (switching mirrors mid-pagination could produce inconsistent
  // ordering/duplicates since 'order=clickcount' rankings can shift
  // slightly between servers).
  for (const mirror of RADIO_BROWSER_MIRRORS) {
    console.log(`Trying mirror: ${mirror}`);
    try {
      const all = [];
      let offset = 0;
      while (true) {
        const page = await fetchPage(mirror, offset);
        if (!page.length) break;
        all.push(...page);
        offset += PAGE_SIZE;
        console.log(`  fetched ${all.length} stations so far...`);
        if (page.length < PAGE_SIZE) break; // last page
      }
      console.log(`Mirror ${mirror} succeeded: ${all.length} total geo-tagged stations.`);
      return all;
    } catch (e) {
      console.log(`  Mirror ${mirror} failed: ${e.message}`);
      continue;
    }
  }
  return null; // every mirror failed
}

function normalizeStation(raw) {
  const lat = Number(raw.geo_lat);
  const lon = Number(raw.geo_long);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat === 0 && lon === 0) return null; // common placeholder for "not actually set"
  if (!raw.name || !(raw.url_resolved || raw.url)) return null;

  return {
    id: raw.stationuuid,
    name: raw.name,
    url: raw.url_resolved || raw.url,
    country: raw.countrycode || "",
    lat,
    lon,
    tags: raw.tags || "",
    favicon: raw.favicon || ""
  };
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

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const cachePath = path.join(OUT_DIR, "cache.json");
  const cached = await readCache(cachePath);

  const rawStations = await fetchAllStations();

  let stations;
  if (!rawStations) {
    console.log("All Radio Browser mirrors failed this run.");
    if (cached) {
      console.log(`Falling back to cached data (${cached.length} stations).`);
      stations = cached;
    } else {
      console.log("No cache available either — writing an empty dataset this run.");
      stations = [];
    }
  } else {
    const normalized = rawStations.map(normalizeStation).filter(Boolean);
    if (cached && cached.length > 0 && normalized.length < cached.length * SANITY_FLOOR) {
      console.log(`Fetch returned only ${normalized.length} vs ${cached.length} cached — looks broken, using cache instead.`);
      stations = cached;
    } else {
      stations = normalized;
      await fs.writeFile(cachePath, JSON.stringify(stations));
    }
  }

  // Output 1: full station list (id, name, url, country, lat, lon, tags)
  await fs.writeFile(
    path.join(OUT_DIR, "stations.json"),
    JSON.stringify(stations, null, 2)
  );

  // Output 2: lightweight GeoJSON, ready to drop straight into a MapLibre
  // GeoJSON source with no client-side transformation needed.
  const geojson = {
    type: "FeatureCollection",
    features: stations.map(s => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
      properties: { id: s.id, name: s.name, url: s.url, country: s.country, tags: s.tags, favicon: s.favicon }
    }))
  };
  await fs.writeFile(
    path.join(OUT_DIR, "stations.geojson"),
    JSON.stringify(geojson)
  );

  console.log(`Done. ${stations.length} geo-tagged stations written to ${OUT_DIR}/stations.json and stations.geojson.`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
