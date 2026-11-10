// services/product/review-eligibility.service.ts
//
// Server-enforced review eligibility (Phase 1 of the review system).
//
// A customer may review a product only when the SERVER can see a delivered,
// kept purchase of that product for the authenticated user:
//
//   order_items.variant.productId = <product>
//   vendorOrder.order.userId      = <authenticated user>   ← never a client value
//   vendorOrder.status            = DELIVERED
//   deliveredQuantity             > 0
//   deliveredQuantity − returnedQuantity > 0               ← returned units don't count
//
// The "purchase-verification" flag, the order status and the user id are never
// taken from the request body: the only inputs are the authenticated user and
// the product id, and the purchase is looked up in the database.
//
// `AppError(message, statusCode)` matches the module's existing error contract
// (utils/response.ts), so controllers render it through handleError unchanged.

import { prisma } from "../../../../config/prisma.ts";
import { AppError } from "../../utils/response.ts";

/** Why a customer cannot review a product (stable codes for the UI). */
export type ReviewIneligibilityReason =
  | "NOT_PURCHASED"
  | "NOT_DELIVERED"
  | "RETURNED";

export type ReviewEligibility =
  | { eligible: true; orderItemId: string; vendorOrderId: string; deliveredAt: Date | null }
  | { eligible: false; reason: ReviewIneligibilityReason };

export const REVIEW_INELIGIBILITY_COPY: Record<ReviewIneligibilityReason, string> = {
  NOT_PURCHASED: "You can review this product after buying it.",
  NOT_DELIVERED: "You can review this product once your order has been delivered.",
  RETURNED: "This item was returned, so it can't be reviewed.",
};

/** Select the fields the rule needs — nothing else leaves the database. */
const eligibilitySelect = {
  id: true,
  vendorOrderId: true,
  deliveredQuantity: true,
  returnedQuantity: true,
  vendorOrder: { select: { deliveredAt: true } },
} as const;

export const ReviewEligibilityService = {
  /**
   * The rule itself. Returns the delivered line that entitles the user to
   * review, or the reason they cannot. Never throws for a normal "not eligible".
   */
  async check(userId: string, productId: string): Promise<ReviewEligibility> {
    if (!userId) throw new AppError("Login required", 401);

    // 1. A delivered line kept by the customer (the happy path).
    const delivered = await prisma.orderItem.findFirst({
      where: {
        variant: { productId },
        vendorOrder: { status: "DELIVERED", order: { userId } },
        deliveredQuantity: { gt: 0 },
      },
      select: eligibilitySelect,
      orderBy: { vendorOrder: { deliveredAt: "desc" } },
    });

    if (delivered) {
      const kept = delivered.deliveredQuantity - delivered.returnedQuantity;
      if (kept > 0) {
        return {
          eligible: true,
          orderItemId: delivered.id,
          vendorOrderId: delivered.vendorOrderId,
          deliveredAt: delivered.vendorOrder.deliveredAt,
        };
      }
      // Delivered once, but every unit has since been returned.
      return { eligible: false, reason: "RETURNED" };
    }

    // 2. Did the customer buy it at all? Only used to give a precise message;
    //    any status counts here, because the point is "purchased but not
    //    delivered yet" versus "never bought".
    const purchased = await prisma.orderItem.findFirst({
      where: { variant: { productId }, vendorOrder: { order: { userId } } },
      select: { id: true },
    });

    return { eligible: false, reason: purchased ? "NOT_DELIVERED" : "NOT_PURCHASED" };
  },

  /** Same rule, throwing a 403 with the customer-facing copy when it fails. */
  async assert(userId: string, productId: string) {
    const result = await this.check(userId, productId);
    if (!result.eligible) {
      throw new AppError(REVIEW_INELIGIBILITY_COPY[result.reason], 403);
    }
    return result;
  },
};
