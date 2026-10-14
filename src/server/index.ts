import Fastify from 'fastify';
import { loadConfig } from '../config.js';
import { notificationsSupported } from '../notify/osascript.js';
import { openStore } from '../store/db.js';
import { createSessionService, type SessionService } from '../sessions/service.js';
import { createSetupService } from '../setup/service.js';
import { registerHostGuard } from './host.js';
import { createPoller } from './poller.js';
import { registerRoutes } from './routes.js';

const config = loadConfig(process.env.PRD_CONFIG ?? 'config.json');
const store = openStore(
  process.env.PRD_DB ?? 'pr-dashboard.db',
  `${config.owner}/${config.name}`,
);
const poller = createPoller(config, store);

const tracked = config.scope === 'org' ? `every repo of ${config.owner}` : `${config.owner}/${config.name}`;
console.log(`Tracking ${config.me} on ${tracked} (branches from ${config.repoPath})`);
if (!notificationsSupported()) {
  console.log(
    'Desktop notifications: open the board and click "Enable notifications" (browser notifications).',
  );
}

// Anything in config.json's `sessions` block wins over the panel's saved
// choices, which win over what is detected on this machine. The setup needs
// the live sessions (for clone discovery) and the sessions need the setup (for
// the CLI path), hence the late binding.
let sessionService: SessionService | undefined;
const setup = createSetupService({
  configSessions: config.sessions,
  repoPath: config.repoPath,
  store,
  liveSessions: () => sessionService?.snapshot().sessions ?? [],
});
sessionService = createSessionService(() => setup.effective().sessions);
const service = sessionService;

const port = Number(process.env.PORT ?? 5174);
const app = Fastify({ logger: { level: 'warn' } });
registerHostGuard(app, port);
registerRoutes(app, poller, store, { sessions: service, setup });

// Listen before any slow work: detection runs a handful of child processes.
// Until it finishes the setup API reports `detecting` and an empty detection.
await app.listen({ port, host: '127.0.0.1' });
console.log(`PR dashboard API on http://127.0.0.1:${port}`);

poller.start();

const logFailure = (what: string) => (error: unknown): void => {
  console.error(`${what} failed:`, error);
};

async function detectInBackground(): Promise<void> {
  await setup.redetect().catch(logFailure('Detecting this machine'));
  service.start();
  // Once the first listing is in, look again so clones that live sessions run in are found.
  await service.refresh()
    .then(() => setup.redetect())
    .catch(logFailure('The first session refresh'));
}
detectInBackground().catch(logFailure('Background detection'));
