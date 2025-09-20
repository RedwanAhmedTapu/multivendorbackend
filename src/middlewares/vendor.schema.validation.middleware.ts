// middlewares/validation.middleware.ts
import type { Request, Response, NextFunction } from "express";
import { ZodObject, ZodError } from "zod";

/**
 * Generic validation middleware for Zod schemas.
 * It automatically validates req.body, req.query, and req.params.
 */
export const validate =
  (schema: ZodObject) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });

      return next();
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({
          success: false,
          message: "Validation error",
          errors: err.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        });
      }

      return res.status(500).json({
        success: false,
        message: "Internal server error during validation",
      });
    }
  };
