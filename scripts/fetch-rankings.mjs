/**
 * Fetches the latest FIFA Men's World Ranking from FIFA's internal API
 * and writes the result to data/rankings.json.
 *
 * Designed to run in a GitHub Actions workflow (Node 20, zero npm dependencies).
 * Exits with code 1 on any failure so the workflow fails loudly
 * rather than silently overwriting good data with empty/broken data.
 */

import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const RANKING_PAGE_URLS = [
  'https://inside.fifa.com/fifa-world-ranking/men',
  'https://www.fifa.com/fifa-world-ranking/men',
];

const FIFA_API_BASE = 'https://www.fifa.com/api/ranking-overview';
const OUTPUT_PATH = join(__dirname, '..', 'data', 'rankings.json');

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

async function safeFetch(url, options = {}) {
  const res = await fetch(url, { headers: HEADERS, ...options });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  return res;
}

/**
 * Tries each ranking page URL until one returns valid __NEXT_DATA__ with a
 * dates list, then returns the latest dateId and its human-readable label.
 */
async function getLatestDateId() {
  for (const pageUrl of RANKING_PAGE_URLS) {
    try {
      console.log(`Trying ranking page: ${pageUrl}`);
      const res = await safeFetch(pageUrl);
      const html = await res.text();

      const match = html.match(
        /<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/
      );
      if (!match) {
        console.warn(`  __NEXT_DATA__ not found on ${pageUrl}, trying next...`);
        continue;
      }

      const nextData = JSON.parse(match[1]);
      const dates =
        nextData?.props?.pageProps?.pageData?.ranking?.dates;

      if (!Array.isArray(dates) || dates.length === 0) {
        console.warn(`  dates array missing/empty on ${pageUrl}, trying next...`);
        continue;
      }

      const latest = dates[0];
      console.log(
        `  Found ${dates.length} ranking dates. Latest: ${latest.text} (${latest.id})`
      );
      return { dateId: latest.id, dateText: latest.text };
    } catch (err) {
      console.warn(`  Failed on ${pageUrl}: ${err.message}`);
    }
  }

  throw new Error(
    'Could not retrieve a valid dateId from any FIFA ranking page. ' +
      'FIFA may have changed their page structure.'
  );
}

async function fetchRankings(dateId) {
  const url = `${FIFA_API_BASE}?locale=en&dateId=${dateId}`;
  console.log(`Fetching rankings API: ${url}`);

  const res = await safeFetch(url, {
    headers: {
      ...HEADERS,
      Accept: 'application/json, text/plain, */*',
    },
  });

  const data = await res.json();

  if (!Array.isArray(data?.rankings)) {
    throw new Error(
      `Unexpected API response — missing "rankings" array. ` +
        `Keys found: ${Object.keys(data ?? {}).join(', ')}`
    );
  }

  return data.rankings;
}

async function main() {
  console.log('=== FIFA Rankings Fetcher ===');

  const { dateId, dateText } = await getLatestDateId();
  const rawRankings = await fetchRankings(dateId);

  if (rawRankings.length < 50) {
    throw new Error(
      `Suspiciously few rankings returned (${rawRankings.length}). ` +
        'Refusing to overwrite existing data.'
    );
  }

  const rankings = rawRankings.map((r) => ({
    rank: r.rankingItem.rank,
    name: r.rankingItem.name,
    points: r.rankingItem.totalPoints,
    confederation: r.tag?.text ?? '',
    flagUrl: r.rankingItem.flag?.src ?? '',
  }));

  const output = {
    updatedAt: dateText,
    fetchedAt: new Date().toISOString(),
    rankings,
  };

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf8');

  console.log(`\n✓ Wrote ${rankings.length} team rankings to data/rankings.json`);
  console.log(`  Rankings date: ${dateText}`);
}

main().catch((err) => {
  console.error('\n✗ FATAL:', err.message);
  process.exit(1);
});
