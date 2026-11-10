import { z } from "zod";

export const CreateConversationSchema = z.object({
  type: z.enum(["PRODUCT_INQUIRY", "VENDOR_SUPPORT", "USER_SUPPORT", "DELIVERY_CHAT", "GENERAL_CHAT"]),
  productId: z.string().optional(),
  orderId: z.string().optional(),
  title: z.string().max(255).optional(),
  participantIds: z.array(z.object({
    id: z.string(),
    type: z.enum(["CUSTOMER", "VENDOR", "ADMIN", "EMPLOYEE", "DELIVERY"]),
    // ✅ FIX: Add .nullable() to allow null values from the frontend
    displayName: z.string().nullable().optional(),
    displayImage: z.string().nullable().optional(),
  })).min(1, "At least one participant is required"),
});

export type CreateConversationInput = z.infer<typeof CreateConversationSchema>;