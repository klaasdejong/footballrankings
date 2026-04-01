/**
 * Fetches 2026 FIFA World Cup match program data and writes data/program.json.
 *
 * Primary source: Wikipedia parse API section HTML for 2026_FIFA_World_Cup.
 *
 * Exits with code 1 on failure so GitHub Actions fails visibly.
 */

import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, '..', 'data', 'program.json');

const WIKI_API_BASE = 'https://en.wikipedia.org/w/api.php';
const WIKI_PAGE = '2026_FIFA_World_Cup';

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.5',
};

const VALID_SECTION_TITLES = new Set([
  'Group A',
  'Group B',
  'Group C',
  'Group D',
  'Group E',
  'Group F',
  'Group G',
  'Group H',
  'Round of 32',
  'Round of 16',
  'Quarterfinals',
  'Semifinals',
  'Third place play-off',
  'Final',
]);

const FOOTBALLBOX_REGEX =
  /<div itemscope="" itemtype="http&#58;\/\/schema\.org\/SportsEvent" class="footballbox"[\s\S]*?<div class="fright">[\s\S]*?<\/div><\/div>/gi;

function decodeHtml(text) {
  return text
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(html) {
  return decodeHtml(html.replace(/<[^>]+>/g, ' '));
}

function toSlug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseVenue(venueRaw) {
  const cleaned = stripTags(venueRaw);
  const parts = cleaned
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return { name: '', city: '' };
  }

  if (parts.length === 1) {
    return { name: parts[0], city: '' };
  }

  return {
    name: parts[0],
    city: parts.slice(1).join(', '),
  };
}

function parseMatchNumber(scoreRaw) {
  const scoreText = stripTags(scoreRaw);
  const numberMatch = scoreText.match(/Match\s+(\d+)/i);
  if (numberMatch) {
    return Number(numberMatch[1]);
  }
  return null;
}

function parseFootballBox(boxHtml, stage, round, sectionAnchor, fallbackIndex) {
  const dateIso =
    (boxHtml.match(/class="bday[^>]*">([^<]+)</i) || [])[1]?.trim() ?? '';

  const timeRaw = (boxHtml.match(/<div class="ftime">([\s\S]*?)<\/div>/i) || [])[1] ?? '';
  const homeRaw = (boxHtml.match(/<th class="fhome"[\s\S]*?<\/th>/i) || [])[0] ?? '';
  const awayRaw = (boxHtml.match(/<th class="faway"[\s\S]*?<\/th>/i) || [])[0] ?? '';
  const venueRaw =
    (boxHtml.match(/itemprop="name address">([\s\S]*?)<\/span>/i) || [])[1] ?? '';
  const scoreRaw = (boxHtml.match(/<th class="fscore">([\s\S]*?)<\/th>/i) || [])[1] ?? '';

  const home = stripTags(homeRaw);
  const away = stripTags(awayRaw);
  const localTime = stripTags(timeRaw);
  const matchNumber = parseMatchNumber(scoreRaw);
  const venue = parseVenue(venueRaw);

  if (!home || !away || !dateIso) {
    return null;
  }

  const idNumber = matchNumber ?? fallbackIndex;

  return {
    id: `${toSlug(round)}-${String(idNumber).padStart(3, '0')}`,
    matchNumber,
    stage,
    round,
    group: stage === 'Group Stage' ? round.replace('Group ', '') : null,
    date: dateIso,
    localTime,
    homeTeam: home,
    awayTeam: away,
    venue,
    status: 'scheduled',
    source: {
      provider: 'Wikipedia',
      page: WIKI_PAGE,
      sectionAnchor,
      confidence: 'medium',
    },
  };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  return res.json();
}

async function fetchSections() {
  const url = `${WIKI_API_BASE}?action=parse&page=${WIKI_PAGE}&prop=sections&format=json&formatversion=2`;
  const data = await fetchJson(url);
  const sections = data?.parse?.sections;
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error('Wikipedia sections response is empty or invalid');
  }

  return sections.filter((section) => VALID_SECTION_TITLES.has(section.line));
}

async function fetchSectionHtml(index) {
  const url =
    `${WIKI_API_BASE}?action=parse&page=${WIKI_PAGE}` +
    `&prop=text&section=${index}&format=json&formatversion=2`;
  const data = await fetchJson(url);
  const html = data?.parse?.text;
  if (typeof html !== 'string' || html.length === 0) {
    throw new Error(`Section ${index} returned empty HTML`);
  }
  return html;
}

function parseSectionMatches(sectionTitle, anchor, html) {
  const isGroup = /^Group [A-H]$/.test(sectionTitle);
  const stage = isGroup ? 'Group Stage' : 'Knockout Stage';
  const round = sectionTitle;

  const boxes = [...html.matchAll(FOOTBALLBOX_REGEX)].map((m) => m[0]);

  return boxes
    .map((boxHtml, idx) =>
      parseFootballBox(boxHtml, stage, round, anchor ?? '', idx + 1)
    )
    .filter(Boolean);
}

async function main() {
  console.log('=== WC2026 Program Fetcher ===');
  console.log(`Node ${process.version}  |  ${new Date().toISOString()}\n`);

  const sections = await fetchSections();
  if (sections.length === 0) {
    throw new Error('No expected tournament sections found on Wikipedia page');
  }

  console.log(`Found ${sections.length} relevant sections.`);

  const allMatches = [];
  for (const section of sections) {
    console.log(`\n[Section] ${section.line} (index ${section.index})`);
    const html = await fetchSectionHtml(section.index);
    const matches = parseSectionMatches(section.line, section.anchor, html);
    console.log(`  -> Parsed ${matches.length} matches`);
    allMatches.push(...matches);
  }

  if (allMatches.length < 70) {
    throw new Error(
      `Parsed too few matches (${allMatches.length}). Aborting write to avoid bad data.`
    );
  }

  const output = {
    tournament: '2026 FIFA World Cup',
    source: {
      provider: 'Wikipedia',
      page: WIKI_PAGE,
      fetchedAt: new Date().toISOString(),
      reliability: 'medium',
      notes: 'Schedule placeholders from Wikipedia may change before kickoff.',
    },
    matchCount: allMatches.length,
    matches: allMatches,
  };

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf8');

  console.log(`\nWrote ${allMatches.length} matches to data/program.json`);
}

main().catch((err) => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
