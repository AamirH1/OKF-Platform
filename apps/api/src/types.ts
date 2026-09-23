import type { FastifyBaseLogger, FastifyInstance, RawReplyDefaultExpression, RawRequestDefaultExpression, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppDeps } from './deps';

export type ZodApp = FastifyInstance<RawServerDefault, RawRequestDefaultExpression, RawReplyDefaultExpression, FastifyBaseLogger, ZodTypeProvider>;
export type RoutePlugin = (app: ZodApp, opts: { deps: AppDeps }) => Promise<void>;

/** Shared OpenAPI response schemas. */
export const errorSchema = z
  .object({ error: z.object({ code: z.string(), message: z.string(), requestId: z.string(), details: z.unknown().optional() }) })
  .meta({ id: 'Error' });

export const errorResponses = {
  400: errorSchema,
  401: errorSchema,
  403: errorSchema,
  404: errorSchema,
  409: errorSchema,
  429: errorSchema,
} as const;

export const uuidParam = z.object({ id: z.uuid() });
export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
