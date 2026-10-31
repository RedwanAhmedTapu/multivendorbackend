// src/modules/agent/validators/agent-wallet.validators.ts
//
// Phase 7 request schemas: payout methods, withdrawals, wallet ledger and the
// admin withdrawal actions. Money is validated as exact decimals (money()).

import { z } from "zod";
import { bdPhoneSchema, idSchema, money, nameSchema, pageQuery } from "./agent-primitives.ts";

export const WITHDRAWAL_STATUSES = ["REQUESTED", "APPROVED", "REJECTED", "PAID", "CANCELLED"] as const;
export const WALLET_TX_TYPES = [
  "COMMISSION_CREDIT",
  "COMMISSION_REVERSAL",
  "BONUS_CREDIT",
  "WITHDRAWAL_HOLD",
  "WITHDRAWAL_RELEASE",
  "WITHDRAWAL_PAID",
  "ADJUSTMENT",
] as const;

const bankAccountNumber = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const digits = v.replace(/[\s-]/g, "");
    if (!/^\d{6,20}$/.test(digits)) {
      ctx.addIssue({ code: "custom", message: "Enter a valid bank account number (6–20 digits)" });
      return z.NEVER;
    }
    return digits;
  });

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { error: `At most ${max} characters` })
    .optional()
    .transform((v) => (v ? v : null));

const routingNumber = z
  .string()
  .trim()
  .optional()
  .transform((v, ctx) => {
    if (!v) return null;
    if (!/^\d{9}$/.test(v)) {
      ctx.addIssue({ code: "custom", message: "Routing number must be 9 digits" });
      return z.NEVER;
    }
    return v;
  });

const walletMethod = (type: "BKASH" | "NAGAD") =>
  z.object({ type: z.literal(type), accountName: nameSchema, accountNumber: bdPhoneSchema }).strict();

export const payoutMethodCreateSchema = z.discriminatedUnion("type", [
  walletMethod("BKASH"),
  walletMethod("NAGAD"),
  z
    .object({
      type: z.literal("BANK"),
      accountName: nameSchema,
      accountNumber: bankAccountNumber,
      bankName: z.string().trim().min(2, { error: "Bank name is required" }).max(100),
      branch: optionalText(100),
      routingNumber,
    })
    .strict(),
]);
export type PayoutMethodCreate = z.infer<typeof payoutMethodCreateSchema>;

/**
 * The type never changes; omitted fields stay as they are ("" clears an
 * optional bank field). The merged method is re-validated with the create
 * rules for its type (agent-payout.service.ts).
 */
export const payoutMethodUpdateSchema = z
  .object({
    accountName: nameSchema.optional(),
    accountNumber: z.string().trim().min(1).max(40).optional(),
    bankName: z.string().trim().min(2).max(100).optional(),
    branch: z.string().trim().max(100).optional(),
    routingNumber: z.string().trim().max(20).optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { error: "Nothing to update" });

export const withdrawalRequestSchema = z
  .object({
    clientRequestId: z
      .string()
      .trim()
      .min(8, { error: "clientRequestId must be at least 8 characters" })
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/, { error: "clientRequestId may contain letters, digits, - and _ only" }),
    amount: money({ positive: true, label: "Withdrawal amount" }),
    payoutMethodId: idSchema,
  })
  .strict();

export const withdrawalListQuery = z.object({
  ...pageQuery,
  status: z.enum(WITHDRAWAL_STATUSES).optional(),
});

export const adminWithdrawalListQuery = z.object({
  ...pageQuery,
  status: z.enum(WITHDRAWAL_STATUSES).optional(),
  agentId: idSchema.optional(),
});

export const walletTransactionsQuery = z.object({
  ...pageQuery,
  type: z.enum(WALLET_TX_TYPES).optional(),
});

export const withdrawalRejectSchema = z
  .object({ reason: z.string().trim().min(3, { error: "Give a reason (at least 3 characters)" }).max(500) })
  .strict();

export const withdrawalMarkPaidSchema = z
  .object({
    transactionRef: z.string().trim().min(3, { error: "The transaction reference is required" }).max(120),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
