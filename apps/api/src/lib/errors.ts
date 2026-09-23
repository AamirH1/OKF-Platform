import type { FastifyError, FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';
import { PG_CHECK_VIOLATION, PG_FOREIGN_KEY_VIOLATION, PG_UNIQUE_VIOLATION, pgErrorCode } from '@okf/db';
import { QueryError } from '@okf/query';
import type { ErrorReporter } from './observability';

/** An expected error whose message is safe to return to clients. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Authentication required.') => new AppError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have permission to perform this action.') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found.`);
export const conflict = (message: string, code = 'CONFLICT') => new AppError(409, code, message);
export const unprocessable = (message: string, code = 'UNPROCESSABLE') => new AppError(422, code, message);

const QUERY_STATUS: Record<QueryError['code'], number> = {
  INVALID_QUERY: 400,
  FORBIDDEN_STATEMENT: 400,
  EXECUTION_ERROR: 400,
  TIMEOUT: 408,
  ARTIFACTS_MISSING: 409,
};

export function registerErrorHandler(app: FastifyInstance, reporter: ErrorReporter): void {
  app.setNotFoundHandler((req, reply) => {
    void reply.code(404).send({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.url.split('?')[0]} not found.`, requestId: req.id } });
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const requestId = req.id;
    const send = (status: number, code: string, message: string, details?: unknown) =>
      reply.code(status).send({ error: { code, message, requestId, ...(details !== undefined ? { details } : {}) } });

    if (hasZodFastifySchemaValidationErrors(err)) {
      return send(400, 'VALIDATION_ERROR', 'Request validation failed.', {
        issues: err.validation.map((v) => ({ path: v.instancePath.replace(/^\//, '').replace(/\//g, '.'), message: v.message })),
        context: err.validationContext,
      });
    }
    if (err instanceof AppError) return send(err.statusCode, err.code, err.message, err.details);
    if (err instanceof QueryError) return send(QUERY_STATUS[err.code], `QUERY_${err.code}`, err.message);

    const pg = pgErrorCode(err);
    if (pg === PG_UNIQUE_VIOLATION) return send(409, 'CONFLICT', 'A resource with the same unique value already exists.');
    if (pg === PG_FOREIGN_KEY_VIOLATION) return send(409, 'CONFLICT', 'The operation references a resource that does not exist.');
    if (pg === PG_CHECK_VIOLATION) return send(409, 'IMMUTABLE', 'This resource is immutable in its current state.');

    const status = err.statusCode ?? 500;
    if (status === 429) return send(429, 'RATE_LIMITED', err.message || 'Too many requests.');
    if (status === 413) return send(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
    if (status === 415) return send(415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported content type.');
    if (status >= 400 && status < 500 && !isResponseSerializationError(err)) {
      return send(status, err.code ?? 'BAD_REQUEST', err.message);
    }

    req.log.error({ err }, 'unhandled error');
    reporter.capture(err, { requestId, route: req.routeOptions.url, method: req.method });
    return send(500, 'INTERNAL_ERROR', 'An unexpected error occurred. Quote the request ID when reporting it.');
  });
}
