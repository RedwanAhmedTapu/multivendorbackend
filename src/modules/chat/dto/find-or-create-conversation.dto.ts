import { z } from "zod";

const ParticipantTypeEnum = z.enum(["CUSTOMER", "VENDOR", "ADMIN", "EMPLOYEE", "DELIVERY"]);
const ConversationTypeEnum = z.enum([
  "PRODUCT_INQUIRY",
  "VENDOR_SUPPORT",
  "USER_SUPPORT",
  "DELIVERY_CHAT",
  "GENERAL_CHAT",
]);

export const FindOrCreateConversationSchema = z
  .object({
    type: ConversationTypeEnum,
    productId: z.string().cuid().optional(),
    orderId: z.string().cuid().optional(),
    otherParticipant: z.object({
      id: z.string().cuid(),
      type: ParticipantTypeEnum,
      displayName: z.string().min(1),
      displayImage: z.string().url().optional().nullable(),
    }),
  })
  // PRODUCT_INQUIRY must carry a productId, DELIVERY_CHAT must carry an orderId —
  // catches a malformed request before it ever reaches the service/dedupeKey logic.
  .refine(
    (data) => data.type !== "PRODUCT_INQUIRY" || !!data.productId,
    { message: "productId is required for PRODUCT_INQUIRY conversations", path: ["productId"] }
  )
  .refine(
    (data) => data.type !== "DELIVERY_CHAT" || !!data.orderId,
    { message: "orderId is required for DELIVERY_CHAT conversations", path: ["orderId"] }
  );

export type FindOrCreateConversationInput = z.infer<typeof FindOrCreateConversationSchema>;