import Fastify from 'fastify';
import { loadConfig } from '../config.js';
import { notificationsSupported } from '../notify/osascript.js';
import { openStore } from '../store/db.js';
import { createSessionService, type SessionService } from '../sessions/service.js';
import { createSetupService } from '../setup/service.js';
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
await setup.redetect();
sessionService = createSessionService(() => setup.effective().sessions);

const app = Fastify({ logger: { level: 'warn' } });
registerRoutes(app, poller, store, { sessions: sessionService, setup });

poller.start();
sessionService.start();
// Once the first listing is in, look again so clones that live sessions run in are found.
void sessionService.refresh().then(() => setup.redetect());

const port = Number(process.env.PORT ?? 5174);
await app.listen({ port, host: '127.0.0.1' });
console.log(`PR dashboard API on http://127.0.0.1:${port}`);
