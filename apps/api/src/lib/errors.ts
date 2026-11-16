import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '../generated/prisma/client';
import type { Logger } from './logger';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, 'not_found', 'Route not found'));
};

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, req, res, _next) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    if (err instanceof ZodError) {
      // Paths and messages only; zod v4 issues do not echo the (possibly PHI) input.
      const issues = err.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      res
        .status(400)
        .json({ error: { code: 'validation_error', message: 'Invalid request', issues } });
      return;
    }
    // P2025: the record to update/delete doesn't exist. Under RLS that includes another tenant's
    // row, which must look exactly like a missing one.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
      return;
    }
    // Log the error (type, stack) but never the request body: it may contain PHI.
    logger.error({ err, reqId: req.id }, 'unhandled error');
    res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } });
  };
}
