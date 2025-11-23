import { z } from "zod";

export const createOrderSchema = z.object({
  provider: z.string().min(1),
  recipientName: z.string().min(3),
  recipientPhone: z.string().regex(/^01[3-9]\d{8}$/, "Invalid Bangladeshi phone number"),
  recipientAddress: z.string().min(5),
  deliveryArea: z.string().min(1),
  deliveryAreaId: z.number().int(),
  cashCollectionAmount: z.number().nonnegative(),
  parcelWeight: z.number().positive(),
  merchantInvoiceId: z.string().min(1),
  instruction: z.string().optional(),
  itemDescription: z.string().optional(),
  pickupStoreId: z.number().optional()
});
