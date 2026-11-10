import { Router } from "express";
import { prisma } from "../../config/prisma.ts";
import { AdminOrderService } from "../../services/admin.order.service.ts";

const router = Router();

router.post("/sslcommerz", async (req, res) => {
  try {
    const { val_id, status, tran_id } = req.body;

    // TODO: verify signature/val_id with SSLCommerz validation API
    // before trusting this payload (prevent spoofed webhook calls).

    const payment = await prisma.payment.findFirst({
      where: { /* tran_id mapping — e.g. transactionId: tran_id */ },
      include: { order: { select: { id: true, status: true } } },
    });
    if (!payment) return res.status(404).end();

    if (status !== "VALID" /* SSLCommerz success status */) {
      // handle FAILED/CANCELLED cases separately
      return res.status(200).end();
    }

    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: "PAID", paidAt: new Date() },
    });

    await AdminOrderService.confirmOrderBySystem(payment.order.id, "PAYMENT_WEBHOOK");

    res.status(200).end();
  } catch (err) {
    console.error("[SSLCommerz Webhook Error]", err);
    res.status(500).end();
  }
});

export default router;