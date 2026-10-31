// src/modules/agent/agent-http.ts
//
// One response/error contract for every agent route (agent portal, agent
// auth and admin agent management):
//   success → { success: true, data, meta? }
//   failure → { success: false, message, code?, errors? }
// AppError (the project's operational error) carries the status code; zod
// validation failures become 400 with per-field messages; Prisma unique
// violations become 409; anything else is logged and answered 500 without
// internals.

import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { AppError } from "../../middlewares/error.middleware.ts";

export { AppError };

/** AppError with a machine-readable code and optional details. */
export class AgentError extends AppError {
  code: string;
  details?: unknown;
  constructor(message: string, statusCode: number, code: string, details?: unknown) {
    super(message, statusCode);
    this.code = code;
    this.details = details;
    this.name = "AgentError";
  }
}

export const notFound = (what: string) => new AgentError(`${what} not found`, 404, "NOT_FOUND");
export const conflict = (message: string, code = "CONFLICT", details?: unknown) =>
  new AgentError(message, 409, code, details);
export const badRequest = (message: string, code = "BAD_REQUEST", details?: unknown) =>
  new AgentError(message, 400, code, details);

export function zodFieldErrors(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.length ? issue.path.join(".") : "_";
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

export function sendError(res: Response, err: unknown): void {
  if (err instanceof ZodError) {
    res.status(400).json({ success: false, message: "Validation failed", code: "VALIDATION_ERROR", errors: zodFieldErrors(err) });
    return;
  }
  if (err instanceof AgentError) {
    res.status(err.statusCode).json({
      success: false,
      message: err.message,
      code: err.code,
      ...(err.details !== undefined ? { details: err.details } : {}),
    });
    return;
  }
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ success: false, message: err.message });
    return;
  }
  const code = (err as any)?.code;
  if (code === "P2002") {
    res.status(409).json({ success: false, message: "A record with these values already exists", code: "DUPLICATE" });
    return;
  }
  if (code === "P2025") {
    res.status(404).json({ success: false, message: "Record not found", code: "NOT_FOUND" });
    return;
  }
  console.error("[agent] unexpected error:", (err as any)?.message ?? err);
  res.status(500).json({ success: false, message: "Internal server error" });
}

/** Wrap an async controller so every failure goes through sendError. */
export function handle<Req extends Request = Request>(
  fn: (req: Req, res: Response) => Promise<unknown>,
) {
  return (req: Request, res: Response, _next: NextFunction) => {
    fn(req as Req, res).catch((err) => sendError(res, err));
  };
}

export function ok(res: Response, data: unknown, meta?: Record<string, unknown>, status = 200) {
  res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });
}

/** Client IP and user agent for audit rows. */
export function requestOrigin(req: Request): { ip: string | null; userAgent: string | null } {
  const ua = req.headers["user-agent"];
  return {
    ip: (req.ip || (req.socket as any)?.remoteAddress || null) ?? null,
    userAgent: typeof ua === "string" ? ua.slice(0, 500) : null,
  };
}
