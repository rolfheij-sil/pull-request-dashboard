import Fastify from 'fastify';
import { loadConfig } from '../config.js';
import { notificationsSupported } from '../notify/osascript.js';
import { openStore } from '../store/db.js';
import { createSessionService } from '../sessions/service.js';
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

const sessionsConfig = config.sessions?.enabled === false ? undefined : config.sessions;
const sessionService = sessionsConfig === undefined ? undefined : createSessionService(sessionsConfig);

const app = Fastify({ logger: { level: 'warn' } });
registerRoutes(app, poller, store, {
  sessions: sessionService === undefined || sessionsConfig === undefined
    ? undefined
    : { service: sessionService, config: sessionsConfig },
});

poller.start();
sessionService?.start();

const port = Number(process.env.PORT ?? 5174);
await app.listen({ port, host: '127.0.0.1' });
console.log(`PR dashboard API on http://127.0.0.1:${port}`);
