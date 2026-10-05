import { buildApp } from './app.ts';
import { googleCalendarClient, reconcileBookings } from './calendar.ts';
import { loadConfig, type Config } from './config.ts';
import { refreshSummary } from './intake.ts';
import { openStore } from './store.ts';

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const store = openStore(config.databasePath);
// Calls still marked active cannot survive a restart; record them as incomplete.
const recovered = store.recoverStaleCalls();
for (const id of recovered) refreshSummary(store, id);
if (recovered.length) console.log(`Marked ${recovered.length} interrupted call(s) incomplete.`);

const calendar = googleCalendarClient(config.google);
const app = await buildApp(config, store, { calendar });
await app.listen({ port: config.port, host: 'localhost' });
console.log(`Summit Air voice listening on port ${config.port}; public origin ${config.publicOrigin}`);
console.log(`Demo view: http://localhost:${config.port}/demo (user "demo")`);

// Calendar writes left pending or uncertain by a restart are settled by looking them up by ID.
reconcileBookings({ store, calendar, config }).catch((error: Error) =>
  console.error(`Booking reconciliation failed (${error.name}).`),
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => {
      store.close();
      process.exit(0);
    });
  });
}
