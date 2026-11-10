import { z } from "zod";

// Phase 3: the whitelist a vendor may write. Ownership and scope are never
// taken from the body — the service writes scope VENDOR and the caller's
// vendorId. Unknown or protected fields (scope other than VENDOR, vendorId,
// employeeId, counters, ids, timestamps) make the request invalid (400), so a
// client can't believe a promotion to GLOBAL or a move to another vendor worked.
const nonBlank = (max: number) => z.string().max(max).refine((s) => s.trim().length > 0, "must not be blank");
const editable = {
  name: nonBlank(100),
  content: nonBlank(2000),
  category: z.string().max(100).optional(),
  shortcut: z.string().max(50).optional(),
  keywords: z.array(nonBlank(100)).max(50).optional(),
};

export const CreateQuickReplySchema = z
  .object({
    ...editable,
    // accepted for client compatibility (the frontend type allows it); VENDOR is the only value a vendor may write
    scope: z.literal("VENDOR").optional(),
  })
  .strict();

export const UpdateQuickReplySchema = z
  .object({
    ...editable,
    isActive: z.boolean(),
    sortOrder: z.number().int().min(0).max(100000),
    scope: z.literal("VENDOR"),
  })
  .partial()
  .strict()
  .refine((d) => Object.keys(d).some((k) => k !== "scope"), "no updatable field");

export type CreateQuickReplyInput = z.infer<typeof CreateQuickReplySchema>;
export type UpdateQuickReplyInput = z.infer<typeof UpdateQuickReplySchema>;
