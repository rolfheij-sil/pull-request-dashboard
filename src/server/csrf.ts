import type { FastifyReply, FastifyRequest } from 'fastify';
import { WEB_PORT } from '../web-port.js';

/**
 * Any web page can make a browser send a request to localhost. Requiring this
 * header on state-changing routes defeats that: a custom header makes the
 * request non-simple, so the browser sends a CORS preflight first, and the API
 * sends no CORS headers, so the preflight fails and the real request never goes out.
 */
export const CSRF_HEADER = 'x-pr-dashboard';

/** The browser origins the board is served from. */
export const allowedOrigins = (webPort: number = WEB_PORT): string[] => [
  `http://localhost:${webPort}`,
  `http://127.0.0.1:${webPort}`,
];

/**
 * A Fastify `preHandler` that rejects state-changing requests that did not come
 * from the board: it needs the CSRF header, and an `Origin` header, when the
 * browser sends one, must be the board's own. Non-browser clients (curl, the
 * pr-attention skill) send no Origin and are accepted with the header alone.
 */
export function requireDashboardRequest(webPort: number = WEB_PORT) {
  const origins = allowedOrigins(webPort);
  return async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    const origin = request.headers.origin;
    const headerOk = request.headers[CSRF_HEADER] === '1';
    const originOk = origin === undefined || origins.includes(origin);
    if (!headerOk || !originOk) {
      // Returning the reply tells Fastify the response is already sent.
      return reply.code(403).send({ error: 'forbidden' });
    }
    return undefined;
  };
}
