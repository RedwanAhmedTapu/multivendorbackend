// utils/response.ts
import type { Response } from "express";

export interface Meta {
  [key: string]: any;
}

export interface PaginationMeta {
  currentPage?: number;
  totalPages?: number;
  totalItems?: number;
  hasNext: boolean;
  hasPrevious?: boolean;
  nextCursor?: string | null;
  limit?: number;
}

/**
 * Standardized success envelope used across every controller in this module.
 * { success, message, data, pagination?, meta? }
 */
export function ok(
  res: Response,
  data: unknown,
  opts: {
    message?: string;
    status?: number;
    pagination?: PaginationMeta;
    meta?: Meta;
  } = {}
) {
  return res.status(opts.status ?? 200).json({
    success: true,
    message: opts.message ?? "",
    data,
    ...(opts.pagination ? { pagination: opts.pagination } : {}),
    ...(opts.meta ? { meta: opts.meta } : {}),
  });
}

/**
 * Standardized error envelope.
 * { success, message, errors }
 */
export function fail(
  res: Response,
  message: string,
  opts: { status?: number; errors?: unknown[] } = {}
) {
  return res.status(opts.status ?? 400).json({
    success: false,
    message,
    errors: opts.errors ?? [],
  });
}

/**
 * Normalizes thrown errors (Zod, known app errors, Prisma errors, unknown)
 * into the fail() envelope. Use inside every controller catch block.
 */
export function handleError(res: Response, error: any, fallbackMessage: string) {
  console.error(fallbackMessage, error);

  // Zod validation error
  if (error?.name === "ZodError") {
    return fail(res, "Validation failed", {
      status: 422,
      errors: error.issues?.map((i: any) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }

  // App-level known errors (thrown with .statusCode)
  if (error?.statusCode) {
    return fail(res, error.message, { status: error.statusCode });
  }

  // Known "not found / unauthorized" string errors used across services
  if (typeof error?.message === "string") {
    if (error.message.includes("not found")) {
      return fail(res, error.message, { status: 404 });
    }
    if (error.message.includes("unauthorized") || error.message.includes("Unauthorized")) {
      return fail(res, error.message, { status: 403 });
    }
  }

  return fail(res, error?.message || fallbackMessage, { status: 500 });
}

/**
 * App-level error carrying an explicit HTTP status code.
 */
export class AppError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}
