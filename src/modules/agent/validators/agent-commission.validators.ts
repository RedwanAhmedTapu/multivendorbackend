// src/modules/agent/validators/agent-commission.validators.ts
import { z } from "zod";
import { idSchema, pageQuery } from "./agent-primitives.ts";
import { COMMISSION_FILTER_STATUSES } from "../services/agent-commission-read.service.ts";

/** Asia/Dhaka calendar day. */
const day = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { error: "Use YYYY-MM-DD" })
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00+06:00`)), { error: "Invalid date" });

const filterShape = {
  status: z.enum(COMMISSION_FILTER_STATUSES).default("ALL"),
  vendorId: idSchema.optional(),
  from: day.optional(),
  to: day.optional(),
};
const fromBeforeTo = (q: { from?: string; to?: string }) => !q.from || !q.to || q.from <= q.to;

export const agentCommissionListQuery = z.object({ ...filterShape, ...pageQuery }).refine(fromBeforeTo, { error: "from must be on or before to", path: ["from"] });
export const agentCommissionExportQuery = z.object(filterShape).refine(fromBeforeTo, { error: "from must be on or before to", path: ["from"] });
export const agentCommissionTrendQuery = z.object({ range: z.enum(["7d", "1m", "1y"]).default("1m") });

export const adminCommissionListQuery = z
  .object({ ...filterShape, agentId: idSchema.optional(), ...pageQuery })
  .refine(fromBeforeTo, { error: "from must be on or before to", path: ["from"] });
export const adminCommissionExportQuery = z
  .object({ ...filterShape, agentId: idSchema.optional() })
  .refine(fromBeforeTo, { error: "from must be on or before to", path: ["from"] });
