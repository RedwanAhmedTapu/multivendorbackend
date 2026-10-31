// src/modules/agent/validators/agent-auth.validators.ts
import { z } from "zod";
import { bdPhoneSchema, emailSchema, nameSchema, passwordSchema } from "./agent-primitives.ts";

export const agentRegisterSchema = z
  .object({
    name: nameSchema,
    email: emailSchema,
    phone: bdPhoneSchema.optional(),
    password: passwordSchema,
  })
  .strict();

/** Sign in with email OR Bangladeshi mobile number. */
export const agentLoginSchema = z
  .object({
    identifier: z.string({ error: "Email or phone is required" }).trim().min(3).max(254),
    password: z.string({ error: "Password is required" }).min(1).max(128),
  })
  .strict();

export const agentForgotPasswordSchema = z.object({ email: emailSchema }).strict();

export const agentResetTokenSchema = z.object({ token: z.string().trim().min(20).max(200) }).strict();

export const agentResetPasswordSchema = z
  .object({ token: z.string().trim().min(20).max(200), password: passwordSchema })
  .strict();

export const agentChangePasswordSchema = z
  .object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema })
  .strict()
  .refine((v) => v.currentPassword !== v.newPassword, { path: ["newPassword"], error: "New password must be different" });

export const agentProfileUpdateSchema = z
  .object({ name: nameSchema, phone: bdPhoneSchema.nullable() })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { error: "Nothing to update" });

export const NOTIFICATION_PREF_KEYS = ["newOrderAlerts", "lowStockAlerts", "commissionCredited", "vendorPerformanceAlerts"] as const;

export const agentNotificationPrefsSchema = z
  .object(Object.fromEntries(NOTIFICATION_PREF_KEYS.map((k) => [k, z.boolean()])) as Record<(typeof NOTIFICATION_PREF_KEYS)[number], z.ZodBoolean>)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { error: "Nothing to update" });
