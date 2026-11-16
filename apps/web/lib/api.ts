import { apiErrorSchema } from '@slotfill/shared';
import type { z } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

async function send(method: Method, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });
  if (!res.ok) {
    const parsed = apiErrorSchema.safeParse(await res.json().catch(() => null));
    throw parsed.success
      ? new ApiError(res.status, parsed.data.error.code, parsed.data.error.message)
      : new ApiError(res.status, 'http_error', `Request failed (${res.status})`);
  }
  return res;
}

async function sendJson<T extends z.ZodType>(
  method: Method,
  path: string,
  schema: T,
  body?: unknown,
): Promise<z.infer<T>> {
  const res = await send(method, path, body);
  return schema.parse(await res.json());
}

/** All API calls go through these helpers; responses are validated with shared zod schemas. */
export const apiGet = <T extends z.ZodType>(path: string, schema: T) =>
  sendJson('GET', path, schema);
export const apiPost = <T extends z.ZodType>(path: string, schema: T, body?: unknown) =>
  sendJson('POST', path, schema, body);
export const apiPostNoContent = async (path: string, body?: unknown): Promise<void> => {
  await send('POST', path, body);
};
