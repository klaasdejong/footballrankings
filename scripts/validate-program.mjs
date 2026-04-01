/**
 * Validates data/program.json structure for simulator readiness.
 *
 * Exits with code 1 on validation failure.
 */

import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROGRAM_PATH = join(__dirname, '..', 'data', 'program.json');

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(errors) {
  console.error('Program validation failed:');
  for (const err of errors) {
    console.error(`- ${err}`);
  }
  process.exit(1);
}

function validateMatch(match, index, errors) {
  const where = `matches[${index}]`;

  if (!isObject(match)) {
    errors.push(`${where} must be an object`);
    return;
  }

  const requiredStringFields = ['id', 'stage', 'round', 'date', 'localTime', 'homeTeam', 'awayTeam', 'status'];
  for (const field of requiredStringFields) {
    if (typeof match[field] !== 'string' || !match[field].trim()) {
      errors.push(`${where}.${field} must be a non-empty string`);
    }
  }

  if (match.group !== null && typeof match.group !== 'string') {
    errors.push(`${where}.group must be string or null`);
  }

  if (match.matchNumber !== null && !Number.isInteger(match.matchNumber)) {
    errors.push(`${where}.matchNumber must be integer or null`);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(match.date ?? '')) {
    errors.push(`${where}.date must match YYYY-MM-DD`);
  }

  if (!isObject(match.venue)) {
    errors.push(`${where}.venue must be an object`);
  } else {
    if (typeof match.venue.name !== 'string') {
      errors.push(`${where}.venue.name must be a string`);
    }
    if (typeof match.venue.city !== 'string') {
      errors.push(`${where}.venue.city must be a string`);
    }
  }

  if (!isObject(match.source)) {
    errors.push(`${where}.source must be an object`);
  } else {
    if (typeof match.source.provider !== 'string' || !match.source.provider.trim()) {
      errors.push(`${where}.source.provider must be a non-empty string`);
    }
    if (typeof match.source.page !== 'string' || !match.source.page.trim()) {
      errors.push(`${where}.source.page must be a non-empty string`);
    }
    if (typeof match.source.sectionAnchor !== 'string') {
      errors.push(`${where}.source.sectionAnchor must be a string`);
    }
    if (typeof match.source.confidence !== 'string' || !match.source.confidence.trim()) {
      errors.push(`${where}.source.confidence must be a non-empty string`);
    }
  }
}

async function main() {
  const errors = [];

  let raw;
  try {
    raw = await readFile(PROGRAM_PATH, 'utf8');
  } catch (err) {
    fail([`Unable to read data/program.json: ${err.message}`]);
  }

  let program;
  try {
    program = JSON.parse(raw);
  } catch (err) {
    fail([`Invalid JSON in data/program.json: ${err.message}`]);
  }

  if (!isObject(program)) {
    errors.push('Root must be an object');
  } else {
    if (typeof program.tournament !== 'string' || !program.tournament.trim()) {
      errors.push('tournament must be a non-empty string');
    }

    if (!isObject(program.source)) {
      errors.push('source must be an object');
    } else {
      if (typeof program.source.provider !== 'string' || !program.source.provider.trim()) {
        errors.push('source.provider must be a non-empty string');
      }
      if (typeof program.source.page !== 'string' || !program.source.page.trim()) {
        errors.push('source.page must be a non-empty string');
      }
      if (typeof program.source.fetchedAt !== 'string' || !program.source.fetchedAt.trim()) {
        errors.push('source.fetchedAt must be a non-empty string');
      }
      if (typeof program.source.reliability !== 'string' || !program.source.reliability.trim()) {
        errors.push('source.reliability must be a non-empty string');
      }
    }

    if (!Array.isArray(program.matches)) {
      errors.push('matches must be an array');
    } else {
      if (typeof program.matchCount !== 'number') {
        errors.push('matchCount must be a number');
      } else if (program.matchCount !== program.matches.length) {
        errors.push('matchCount must equal matches.length');
      }

      const ids = new Set();
      const matchNumbers = new Set();

      for (let i = 0; i < program.matches.length; i++) {
        const match = program.matches[i];
        validateMatch(match, i, errors);

        if (isObject(match) && typeof match.id === 'string') {
          if (ids.has(match.id)) {
            errors.push(`Duplicate match id: ${match.id}`);
          }
          ids.add(match.id);
        }

        if (isObject(match) && Number.isInteger(match.matchNumber)) {
          if (matchNumbers.has(match.matchNumber)) {
            errors.push(`Duplicate matchNumber: ${match.matchNumber}`);
          }
          matchNumbers.add(match.matchNumber);
        }
      }

      if (program.matches.length < 70) {
        errors.push('matches must contain at least 70 entries to guard against parser breakage');
      }
    }
  }

  if (errors.length > 0) {
    fail(errors);
  }

  console.log(`Program validation passed (${program.matches.length} matches).`);
}

main().catch((err) => {
  console.error(`Validation crashed: ${err.message}`);
  process.exit(1);
});
