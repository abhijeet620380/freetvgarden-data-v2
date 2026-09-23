// build-epg.mjs - Isolated EPG processor (strict channel-ID matching)
//
// Put this file in scripts/ (or the repo root) of the data repo - it finds the
// repo root by itself, and it DOWNLOADS the guide itself, so the workflow only
// needs one line:   node scripts/build-epg.mjs
//
// Reads:   iptv/status.json          (which channel IDs we carry)
//          the XMLTV guide           (downloaded here; a local guide.xml.gz in the
//                                     repo root is used instead if one exists)
// Writes:  iptv/epg/{cc}.json  ->  { "<channel id>": [ {title,start,stop}, ... ] }
//
// It never touches the .m3u playlists or status.json. If anything goes wrong
// (download fails, corrupt guide, no matches) it leaves the previous epg/ files
// untouched instead of overwriting them with empty data.

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import readline from 'node:readline';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- settings --------------------------------------------------------
const GUIDE_URLS = (process.env.EPG_GUIDE_URL
  ? process.env.EPG_GUIDE_URL.split(',')
  : [
      'https://epgshare01.online/epgshare01/epg_ripper_ALL_SOURCES1.xml.gz',
      'https://github.com/epgshare01/share01/raw/master/epg_ripper_ALL_SOURCES1.xml.gz'
    ]).map(s => s.trim()).filter(Boolean);
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const WINDOW_HOURS = 24; // keep shows that are on now or start within this many hours

// ---- locate the repo root (works from scripts/ or from the root) -----
const HERE = path.dirname(fileURLToPath(import.meta.url));
const candidates = [HERE, path.resolve(HERE, '..'), process.cwd()];
const ROOT = candidates.find(d => existsSync(path.join(d, 'iptv', 'status.json'))) || path.resolve(HERE, '..');
const STATUS_FILE = path.join(ROOT, 'iptv', 'status.json');
const OUT_DIR = path.join(ROOT, 'iptv', 'epg');
const LOCAL_GUIDE = path.join(ROOT, 'guide.xml.gz');

// ---- helpers ---------------------------------------------------------
// XMLTV dates look like "20260924183000 +0530" (space before the offset is
// optional in the wild). Returns epoch ms, or NaN if unparseable.
function parseXmltvDate(str) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(str || '');
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s = '00', tz = '+0000'] = m;
  return Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}${tz.slice(0, 3)}:${tz.slice(3)}`);
}

function codePoint(n) {
  try { return String.fromCodePoint(n); } catch { return ''; }
}

function decodeXml(s) {
  return s
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&') // last, so "&amp;lt;" decodes to "&lt;" and not "<"
    .trim();
}

// Turn any byte stream into a stream of plain XML. Looks at the first two
// bytes: gzip files are unzipped, anything else is passed through. (Some
// servers already unzip the download for us, so we can't trust the file name.)
async function decodeGuide(source) {
  const it = source[Symbol.asyncIterator]();
  const first = await it.next();
  if (first.done) throw new Error('guide is empty');
  const head = Buffer.from(first.value);
  async function* rebuilt() {
    yield head;
    for (;;) {
      const n = await it.next();
      if (n.done) return;
      yield n.value;
    }
  }
  const raw = Readable.from(rebuilt());
  const isGzip = head[0] === 0x1f && head[1] === 0x8b;
  if (!isGzip) return raw;
  const gunzip = zlib.createGunzip();
  raw.on('error', e => gunzip.destroy(e));
  return raw.pipe(gunzip);
}

async function openGuide() {
  if (existsSync(LOCAL_GUIDE)) {
    console.log(`Using local guide file ${LOCAL_GUIDE}`);
    return decodeGuide(createReadStream(LOCAL_GUIDE));
  }
  for (const url of GUIDE_URLS) {
    try {
      console.log(`Downloading guide: ${url}`);
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!res.ok || !res.body) {
        console.log(`  HTTP ${res.status}, trying next source...`);
        continue;
      }
      return await decodeGuide(Readable.fromWeb(res.body));
    } catch (e) {
      console.log(`  failed (${e.message}), trying next source...`);
    }
  }
  return null;
}

// ---- main ------------------------------------------------------------
async function main() {
  if (!existsSync(STATUS_FILE)) {
    console.log(`status.json not found at ${STATUS_FILE}. Skipping EPG build.`);
    return;
  }

  console.log('Reading status.json for channel IDs...');
  const statusData = JSON.parse(await readFile(STATUS_FILE, 'utf8'));

  // Channels we carry, keyed by lowercase ID (guide IDs are matched case-insensitively)
  const validChannelsById = new Map();
  for (const c of statusData) {
    if (c.id && c.country && c.status === 'live') {
      validChannelsById.set(String(c.id).toLowerCase(), {
        originalId: c.id,
        country: String(c.country).toLowerCase()
      });
    }
  }
  console.log(`Tracking ${validChannelsById.size} live channel IDs.`);

  const input = await openGuide();
  if (!input) {
    console.log('Could not get the guide from any source. Keeping existing EPG files.');
    return;
  }

  console.log('Streaming guide data and matching by channel ID...');
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  const now = Date.now();
  const windowEnd = now + WINDOW_HOURS * 60 * 60 * 1000;
  const countryEpg = {};
  let cur = null;
  let programmesKept = 0;
  let streamError = null;

  try {
    for await (const line of rl) {
      if (line.includes('<programme ')) {
        cur = null;
        const startM = /start=["']([^"']+)["']/.exec(line);
        const stopM = /stop=["']([^"']+)["']/.exec(line);
        const chM = /channel=["']([^"']+)["']/.exec(line);
        if (startM && stopM && chM) {
          const ours = validChannelsById.get(chM[1].toLowerCase());
          if (ours) {
            const start = parseXmltvDate(startM[1]);
            const stop = parseXmltvDate(stopM[1]);
            if (stop > now && start < windowEnd) {
              cur = { ourId: ours.originalId, country: ours.country, start, stop, title: '' };
            }
          }
        }
      }

      if (cur && !cur.title && line.includes('<title')) {
        const t = /<title[^>]*>([\s\S]*?)<\/title>/.exec(line);
        if (t) cur.title = decodeXml(t[1]); // first <title> only (later ones are other languages)
      }

      if (cur && line.includes('</programme>')) {
        if (cur.title) {
          const byChannel = (countryEpg[cur.country] ||= {});
          (byChannel[cur.ourId] ||= []).push({ title: cur.title, start: cur.start, stop: cur.stop });
          programmesKept++;
        }
        cur = null;
      }
    }
  } catch (e) {
    streamError = e;
  }

  if (streamError) {
    console.log(`Guide read failed (${streamError.message}). Keeping existing EPG files.`);
    return;
  }
  if (programmesKept === 0) {
    console.log('No matching programmes found. Keeping existing EPG files.');
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });

  let matchedChannels = 0;
  for (const [cc, channels] of Object.entries(countryEpg)) {
    for (const chId of Object.keys(channels)) {
      const sorted = channels[chId].sort((a, b) => a.start - b.start);
      // the combined guide can list the same show more than once
      channels[chId] = sorted.filter((p, i) => i === 0 || p.start !== sorted[i - 1].start || p.title !== sorted[i - 1].title);
      matchedChannels++;
    }
    await writeFile(path.join(OUT_DIR, `${cc}.json`), JSON.stringify(channels));
  }

  console.log(`EPG complete: ${matchedChannels} channels matched by ID, ${programmesKept} programmes, ${Object.keys(countryEpg).length} country files in ${OUT_DIR}/`);
}

main().catch(e => { console.error(e); });
