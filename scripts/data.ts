import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { toExport } from '../src/records.ts';
import { openStore } from '../src/store.ts';

// Data commands only need DATABASE_PATH, so skip the full app config.
const databasePath = process.env.DATABASE_PATH || 'var/summit-air.db';
const [command, flag] = process.argv.slice(2);

const store = openStore(databasePath);
try {
  if (command === 'export') {
    const records = store.listRecords(10_000).map(toExport);
    const file = join(dirname(databasePath), 'exports', `calls-${new Date().toISOString().replaceAll(':', '-')}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(records, null, 2));
    console.log(`Exported ${records.length} call(s) to ${file}`);
  } else if (command === 'cleanup' && flag === '--yes') {
    console.log(`Deleted ${store.deleteAll()} call(s) and their requests.`);
  } else {
    console.log('Usage: npm run data -- export | cleanup --yes');
    process.exitCode = command ? 1 : 0;
  }
} finally {
  store.close();
}
