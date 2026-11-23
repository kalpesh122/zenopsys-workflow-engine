import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { UniqueConstraintError } from 'sequelize';
import { ZodError } from 'zod';

/** An error that maps directly onto an HTTP response: { error: { code, message, details } }. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Express 4 does not forward rejected promises to the error handler; this does. */
export function wrap(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

function send(res: Response, status: number, code: string, message: string, details: unknown = null) {
  res.status(status).json({ error: { code, message, details } });
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ApiError) return send(res, err.status, err.code, err.message, err.details ?? null);
  if (err instanceof ZodError) {
    return send(res, 400, 'VALIDATION_ERROR', 'Request body is invalid', {
      issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  if (err?.type === 'entity.parse.failed') {
    return send(res, 400, 'INVALID_JSON', `Malformed JSON body: ${err.message}`);
  }
  // Other body-parser rejections (e.g. 413 entity.too.large) carry their own 4xx status.
  if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) {
    return send(res, err.status, 'BAD_REQUEST', err.message);
  }
  if (err instanceof UniqueConstraintError) {
    return send(res, 409, 'CONFLICT', 'Concurrent modification detected; retry the request');
  }
  console.error(err);
  return send(res, 500, 'INTERNAL', 'Internal server error');
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);
