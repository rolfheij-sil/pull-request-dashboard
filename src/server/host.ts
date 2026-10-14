import type { FastifyInstance } from 'fastify';
import { WEB_PORT } from '../web-port.js';

/** The `Host` values a request from the board, or from a local tool, carries. */
export function allowedHosts(apiPort: number, webPort: number = WEB_PORT): string[] {
  return [apiPort, webPort].flatMap((port) => [
    `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`,
  ]);
}

/**
 * Refuses any request whose `Host` header is not this machine's loopback
 * address on the API or web port. A page on another site can make the browser
 * resolve its own hostname to 127.0.0.1 (DNS rebinding) and then read the API
 * as if it were same-origin; such a request still carries the attacker's
 * hostname in `Host`. Vite's proxy forwards the browser's original `Host`
 * (`changeOrigin` is off), so board requests arrive as `localhost:<web port>`.
 * `apiPort` may be a function for servers whose port is only known once listening.
 */
export function registerHostGuard(
  app: FastifyInstance, apiPort: number | (() => number), webPort: number = WEB_PORT,
): void {
  app.addHook('onRequest', async (request, reply) => {
    const port = typeof apiPort === 'function' ? apiPort() : apiPort;
    const host = request.headers.host?.toLowerCase();
    if (host === undefined || !allowedHosts(port, webPort).includes(host)) {
      // Returning the reply tells Fastify the response is already sent.
      return reply.code(403).send({ error: 'forbidden' });
    }
    return undefined;
  });
}
