// blog-module/utils/response.ts
// Same envelope shape as product-module/utils/response.ts — kept
// identical so frontend clients don't need a second response parser.
import type { Response } from "express";

export function ok<T>(res: Response, data: T, message = "", extra: Record<string, unknown> = {}) {
  return res.json({ success: true, message, data, ...extra });
}

export function created<T>(res: Response, data: T, message = "Created successfully") {
  return res.status(201).json({ success: true, message, data });
}

export function fail(res: Response, message: string, status = 400, errors: unknown[] = []) {
  return res.status(status).json({ success: false, message, errors });
}

export function handleError(res: Response, err: unknown, fallbackMessage = "Something went wrong") {
  // eslint-disable-next-line no-console
  console.error(err);
  const message = err instanceof Error ? err.message : fallbackMessage;
  return res.status(500).json({ success: false, message: fallbackMessage, errors: [message] });
}
