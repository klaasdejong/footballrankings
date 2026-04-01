/**
 * Fetches the latest FIFA Men's World Ranking and writes data/rankings.json.
 *
 * Strategy (tries each approach in order until one returns ≥50 teams):
 *  1. Hit the ranking API directly with no dateId — FIFA may serve latest data.
 *  2. Probe recent numeric dateIds (counts down from a known-recent ceiling).
 *  3. Scrape __NEXT_DATA__ from the ranking HTML page (may be blocked by CF).
 *  4. Fallback scrape from football-ranking.com paginated ranking table.
 *
 * Exits with code 1 on failure so the GitHub Actions workflow fails visibly.
 */

import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIFA_API_BASE = 'https://www.fifa.com/api/ranking-overview';
const OUTPUT_PATH   = join(__dirname, '..', 'data', 'rankings.json');
const FALLBACK_RANKING_URL = 'https://football-ranking.com/fifa-world-rankings';

// WC2026 display names — used only for the diagnostic check at the end.
const WC2026_TEAMS = [
  'Mexico','South Africa','South Korea','Czech Republic',
  'Canada','Bosnia and Herzegovina','Qatar','Switzerland',
  'Brazil','Morocco','Haiti','Scotland',
  'United States','Paraguay','Australia','Turkey',
  'Germany','Curaçao','Ivory Coast','Ecuador',
  'Netherlands','Japan','Sweden','Tunisia',
  'Belgium','Egypt','Iran','New Zealand',
  'Spain','Cape Verde','Saudi Arabia','Uruguay',
  'France','Senegal','Iraq','Norway',
  'Argentina','Algeria','Austria','Jordan',
  'Portugal','DR Congo','Uzbekistan','Colombia',
  'England','Croatia','Ghana','Panama',
];

const API_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.5',
};

const HTML_HEADERS = {
  ...API_HEADERS,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// ---------------------------------------------------------------------------
// Shared JSON fetch helper
// ---------------------------------------------------------------------------
async function tryFetchJson(url) {
  try {
    console.log(`  GET ${url}`);
    const res = await fetch(url, { headers: API_HEADERS });
    if (!res.ok) {
      console.warn(`  → HTTP ${res.status} ${res.statusText}`);
      return null;
    }
    const text = await res.text();
    if (text.trimStart().startsWith('<')) {
      console.warn(`  → Got HTML instead of JSON (likely Cloudflare block)`);
      return null;
    }
    let data;
    try { data = JSON.parse(text); } catch {
      console.warn(`  → Response is not valid JSON`);
      return null;
    }
    if (!Array.isArray(data?.rankings) || data.rankings.length < 50) {
      console.warn(`  → Unexpected shape or too few entries (${data?.rankings?.length ?? 0})`);
      return null;
    }
    return data;
  } catch (err) {
    console.warn(`  → Error: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Strategy 1: No dateId param
// ---------------------------------------------------------------------------
async function tryWithoutDateId() {
  console.log('\n[Strategy 1] API call without dateId...');
  return tryFetchJson(`${FIFA_API_BASE}?locale=en`);
}

// ---------------------------------------------------------------------------
// Strategy 2: Probe recent numeric dateIds (counts down from known ceiling)
// ---------------------------------------------------------------------------
async function tryProbeRecentIds() {
  console.log('\n[Strategy 2] Probing recent numeric dateIds...');
  const PROBE_START    = 14350;
  const PROBE_ATTEMPTS = 6;
  for (let i = PROBE_START; i > PROBE_START - PROBE_ATTEMPTS; i--) {
    const data = await tryFetchJson(`${FIFA_API_BASE}?locale=en&dateId=id${i}`);
    if (data) {
      console.log(`  → Found valid data at id${i}`);
      return data;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Strategy 3: Scrape __NEXT_DATA__ from the HTML page for the exact dateId
// ---------------------------------------------------------------------------
async function tryScrapeHtmlPage() {
  const PAGES = [
    'https://inside.fifa.com/fifa-world-ranking/men',
    'https://www.fifa.com/fifa-world-ranking/men',
  ];

  console.log('\n[Strategy 3] Scraping __NEXT_DATA__ from HTML page...');
  for (const pageUrl of PAGES) {
    try {
      console.log(`  GET ${pageUrl}`);
      const res = await fetch(pageUrl, { headers: HTML_HEADERS });
      if (!res.ok) { console.warn(`  → HTTP ${res.status}`); continue; }

      const html = await res.text();
      if (!html.includes('__NEXT_DATA__')) {
        const snippet = html.slice(0, 400).replace(/\s+/g, ' ');
        console.warn(`  → __NEXT_DATA__ not found. Page preview: ${snippet}`);
        continue;
      }

      const match = html.match(
        /<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/
      );
      if (!match) { console.warn(`  → Could not extract __NEXT_DATA__ tag`); continue; }

      const nextData = JSON.parse(match[1]);
      const dates = nextData?.props?.pageProps?.pageData?.ranking?.dates;
      if (!Array.isArray(dates) || dates.length === 0) {
        console.warn(
          `  → dates array missing. pageData keys: ${Object.keys(nextData?.props?.pageProps?.pageData ?? {}).join(', ')}`
        );
        continue;
      }

      const latest = dates?.[0]?.dates?.[0] ?? dates?.[0] ?? null;
      if (!latest?.id) {
        console.warn('  → Could not find a valid dateId in ranking.dates');
        continue;
      }

      console.log(`  → dateId: ${latest.id}  (${latest.dateText ?? latest.text ?? 'n/a'})`);

      const data = await tryFetchJson(`${FIFA_API_BASE}?locale=en&dateId=${latest.id}`);
      if (data) {
        data._dateText = latest.dateText ?? latest.text ?? 'Unknown date';
        return data;
      }
    } catch (err) {
      console.warn(`  → Error on ${pageUrl}: ${err.message}`);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Strategy 4: Fallback HTML scrape from football-ranking.com
// ---------------------------------------------------------------------------
function decodeHtml(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function parseFallbackRows(html) {
  const rows = [];
  const rowRegex = /<tr>\s*<td[^>]*>\s*(\d+)\s*&nbsp;[\s\S]*?<\/td>\s*<td>[\s\S]*?<img[^>]+src="([^"]+)"[^>]*>[\s\S]*?&nbsp;&nbsp;([^<]+)\s*<span[\s\S]*?<\/td>\s*<td>[\s\S]*?<b>([0-9,]+\.[0-9]+)<\/b>/g;

  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    rows.push({
      rank: Number(match[1]),
      flagUrl: decodeHtml(match[2]),
      name: decodeHtml(match[3]),
      points: Number(match[4].replace(/,/g, '')),
      confederation: '',
    });
  }
  return rows;
}

function parseFallbackDateText(html) {
  const titleMatch = html.match(/<title>\s*FIFA world rankings[^<]*-\s*([^<]+?)\s*<\/title>/i);
  if (titleMatch?.[1]) return decodeHtml(titleMatch[1]);
  return 'Unknown date';
}

async function tryFallbackSource() {
  console.log('\n[Strategy 4] Fallback scrape from football-ranking.com...');
  const all = [];
  let dateText = 'Unknown date';

  for (let page = 1; page <= 8; page++) {
    const url = page === 1 ? FALLBACK_RANKING_URL : `${FALLBACK_RANKING_URL}?page=${page}`;
    try {
      console.log(`  GET ${url}`);
      const res = await fetch(url, { headers: HTML_HEADERS });
      if (!res.ok) {
        console.warn(`  → HTTP ${res.status} on page ${page}`);
        break;
      }

      const html = await res.text();
      if (page === 1) dateText = parseFallbackDateText(html);

      const rows = parseFallbackRows(html);
      console.log(`  → parsed ${rows.length} rows from page ${page}`);
      if (rows.length === 0) break;

      all.push(...rows);

      // Keep going until we hit an empty page.
    } catch (err) {
      console.warn(`  → Error on fallback page ${page}: ${err.message}`);
      break;
    }
  }

  if (all.length < 120) {
    console.warn(`  → Fallback source returned too few rows (${all.length})`);
    return null;
  }

  const deduped = Array.from(new Map(all.map((r) => [r.name.toLowerCase(), r])).values())
    .sort((a, b) => a.rank - b.rank);

  return {
    dateText,
    rankings: deduped,
    source: 'football-ranking.com fallback',
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== FIFA Rankings Fetcher ===');
  console.log(`Node ${process.version}  |  ${new Date().toISOString()}\n`);

  const data =
    (await tryWithoutDateId()) ??
    (await tryProbeRecentIds()) ??
    (await tryScrapeHtmlPage());

  let rankings;
  let dateText;
  let source = 'FIFA API';

  if (data) {
    dateText =
      data._dateText ??
      data.rankings[0]?.rankingItem?.date ??
      'Unknown date';

    rankings = data.rankings.map((r) => ({
      rank:          r.rankingItem.rank,
      name:          r.rankingItem.name,
      points:        r.rankingItem.totalPoints,
      confederation: r.tag?.text ?? '',
      flagUrl:       r.rankingItem.flag?.src ?? '',
    }));
  } else {
    const fallback = await tryFallbackSource();
    if (!fallback) {
      throw new Error(
        'All strategies exhausted — could not fetch rankings. ' +
          'Review the log output above for specific errors per strategy.'
      );
    }

    dateText = fallback.dateText;
    rankings = fallback.rankings;
    source = fallback.source;
  }

  if (!rankings || rankings.length < 50) {
    throw new Error(
      `Fetched too few rankings (${rankings?.length ?? 0}). Aborting write.`
    );
  }

  // ── Diagnostic: check WC2026 name coverage ─────────────────────────────────
  const apiNameSet = new Set(rankings.map((r) => r.name.toLowerCase().trim()));
  const unmatched  = WC2026_TEAMS.filter((t) => !apiNameSet.has(t.toLowerCase()));

  console.log(
    `\n=== WC2026 Name Coverage: ${WC2026_TEAMS.length - unmatched.length}/${WC2026_TEAMS.length} matched ===`
  );
  if (unmatched.length > 0) {
    console.warn(
      `\n⚠ These WC2026 display names are NOT in the API — add them to ALIASES in index.html:`
    );
    unmatched.forEach((t) => console.warn(`  - "${t}"`));
  }

  console.log(`\nAll team names returned by source (${source}) (sorted):`);
  [...rankings]
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((r) => console.log(`  ${String(r.rank).padStart(3)}.  ${r.name}`));

  // ── Write output ───────────────────────────────────────────────────────────
  const output = {
    updatedAt: dateText,
    fetchedAt: new Date().toISOString(),
    rankings,
  };

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf8');

  console.log(`\n✓ Wrote ${rankings.length} teams to data/rankings.json`);
  console.log(`  Rankings date: ${dateText}`);
  console.log(`  Data source: ${source}`);

  if (unmatched.length > 0) {
    console.warn(
      `\n⚠ ${unmatched.length} WC2026 team(s) will show as unranked until ALIASES are updated.`
    );
  }
}

main().catch((err) => {
  console.error('\n✗ FATAL:', err.message);
  process.exit(1);
});
