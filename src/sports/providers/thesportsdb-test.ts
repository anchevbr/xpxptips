/**
 * Quick test — run with: npx ts-node src/sports/providers/thesportsdb-test.ts
 * Verifies TheSportsDB free API returns the expected fixtures for a given date.
 */
import 'dotenv/config';
import { fetchFixturesViaTheSportsDB } from './thesportsdb-fixtures';

const DATE = process.argv[2] ?? '2026-04-10';

(async () => {
  console.log(`\nFetching fixtures from TheSportsDB for ${DATE}...\n`);
  const fixtures = await fetchFixturesViaTheSportsDB(DATE);

  if (fixtures.length === 0) {
    console.log('No fixtures found.');
    return;
  }

  for (const f of fixtures) {
    const time = new Date(f.date).toUTCString().slice(17, 22);
    console.log(`  [${f.league}] ${f.homeTeam} vs ${f.awayTeam} @ ${time} UTC  (${f.status})`);
  }
  console.log(`\nTotal: ${fixtures.length} fixtures`);
})();
