import type { Request, Response, NextFunction } from "express";
import { prisma } from "../config/prisma.ts";
import { PATHAO_WEBHOOK_SECRET } from "./webhook.middleware.ts";
import type { CourierOrderStatus, CourierShipmentKind } from "@prisma/client";

// ============================================================
// SHARED: resolve our internal CourierOrder.id from whatever
// identifier the provider sent (consignment_id / tracking_number),
// then stash it on req.body so the controller's shape is uniform
// regardless of which provider called.
// ============================================================

async function resolveCourierOrderId(consignmentOrTrackingId: string): Promise<string | null> {
  const courierOrder = await prisma.courierOrder.findFirst({
    where: {
      OR: [
        { courierTrackingId: consignmentOrTrackingId },
        { consignmentId: consignmentOrTrackingId },
        { returnConsignmentId: consignmentOrTrackingId },
      ],
    },
    select: { id: true },
  });
  return courierOrder?.id ?? null;
}

// ============================================================
// PATHAO NORMALIZER
//
// Pathao's event field is a dotted string like "order.created",
// "order.delivered", "order.return-in-transit". We map each to our
// internal CourierOrderStatus, and separately derive shipmentKind
// from the event name / return_type field for accounting routing.
// ============================================================

const PATHAO_EVENT_TO_STATUS: Record<string, CourierOrderStatus> = {
  "order.created": "PENDING_PICKUP",
  "order.updated": "PENDING_PICKUP",
  "order.pickup-requested": "PENDING_PICKUP",
  "order.assigned-for-pickup": "READY_FOR_PICKUP",
  "order.pickup": "PICKED_UP",
  "order.pickup-failed": "PICKUP_FAILED",
  "order.pickup-cancelled": "PICKUP_CANCELLED",
  "order.at-the-sorting-hub": "IN_TRANSIT",
  "order.in-transit": "IN_TRANSIT",
  "order.received-at-last-mile-hub": "IN_TRANSIT",
  "order.assigned-for-delivery": "OUT_FOR_DELIVERY",
  "order.delivered": "DELIVERED",
  "order.partial-delivery": "PARTIAL_DELIVERED",
  "order.delivery-failed": "FAILED_DELIVERY",
  "order.on-hold": "ON_HOLD",
  "order.return-id-created": "RETURNING",
  "order.return-in-transit": "RETURNING",
  "order.returned-to-merchant": "RETURNED",
  "order.exchange": "DELIVERED", // exchange delivery leg — shipmentKind carries the nuance
  "order.paid": "DELIVERED", // payment-invoice event; status doesn't change, only courierStatus/raw logged
  "order.paid-return": "RETURNED",
};

function derivePathaoShipmentKind(event: string, returnType?: string): CourierShipmentKind {
  if (returnType) {
    switch (returnType) {
      case "return": return "REVERSE_RETURN";
      case "paid-return": return "PAID_RETURN";
      case "exchange": return "EXCHANGE_RETURN";
      case "partial-delivery": return "PARTIAL_DELIVERY";
    }
  }
  if (event === "order.exchange") return "EXCHANGE_DELIVERY";
  if (event === "order.partial-delivery") return "PARTIAL_DELIVERY";
  if (event === "order.paid-return") return "PAID_RETURN";
  return "REGULAR";
}

export async function normalizePathaoWebhook(req: Request, res: Response, next: NextFunction) {
  const payload = req.body;
  const event: string = payload.event;

  // Handshake already handled+returned by verifyPathaoSignature; this
  // middleware only runs for real events.
  const trackingId: string | undefined = payload.consignment_id;
  if (!trackingId) {
    // Nothing we can resolve to a CourierOrder — ack fast so Pathao
    // doesn't retry, but skip processing.
    res.setHeader("X-Pathao-Merchant-Webhook-Integration-Secret", PATHAO_WEBHOOK_SECRET);
    return res.status(202).json({ received: true, skipped: "no consignment_id" });
  }

  const courierOrderId = await resolveCourierOrderId(trackingId);
  if (!courierOrderId) {
    res.setHeader("X-Pathao-Merchant-Webhook-Integration-Secret", PATHAO_WEBHOOK_SECRET);
    return res.status(202).json({ received: true, skipped: "unknown consignment_id" });
  }

  const newStatus = PATHAO_EVENT_TO_STATUS[event];
  if (!newStatus) {
    res.setHeader("X-Pathao-Merchant-Webhook-Integration-Secret", PATHAO_WEBHOOK_SECRET);
    return res.status(202).json({ received: true, skipped: `unmapped event: ${event}` });
  }

  req.body = {
    courierOrderId,
    newStatus,
    courierStatus: event,
    shipmentKind: derivePathaoShipmentKind(event, payload.return_type),
    messageEn: undefined,
    messageBn: undefined,
    location: undefined,
    timestamp: payload.timestamp ? new Date(payload.timestamp) : new Date(),
    rawData: payload,
    // Carried through for the controller to persist on CourierOrder if needed
    returnConsignmentId: payload.return_consignment_id,
    collectedAmount: payload.collected_amount,
    invoiceId: payload.invoice_id,
  };

  next();
}

// ============================================================
// REDX NORMALIZER
//
// RedX's status field is a flat lowercase-hyphen string
// (ready-for-delivery, delivery-in-progress, delivered, agent-hold,
// agent-returning, returned, agent-area-change, paid), and
// delivery_type carries the shipment-kind info (regular, reverse,
// exchange-delivery, exchange-return, partial-delivery, partial-return).
// ============================================================

const REDX_STATUS_TO_COURIER_STATUS: Record<string, CourierOrderStatus> = {
  "ready-for-delivery": "PENDING_PICKUP",
  "delivery-in-progress": "OUT_FOR_DELIVERY",
  "delivered": "DELIVERED",
  "agent-hold": "ON_HOLD",
  "agent-returning": "RETURNING",
  "returned": "RETURNED",
  "agent-area-change": "IN_TRANSIT", // internal reassignment, closest bucket
  "paid": "DELIVERED", // COD remittance-status ping; not a shipment-state change
};

const REDX_DELIVERY_TYPE_TO_SHIPMENT_KIND: Record<string, CourierShipmentKind> = {
  "regular": "REGULAR",
  "reverse": "REVERSE_RETURN",
  "exchange-delivery": "EXCHANGE_DELIVERY",
  "exchange-return": "EXCHANGE_RETURN",
  "partial-delivery": "PARTIAL_DELIVERY",
  "partial-return": "PARTIAL_RETURN",
};

export async function normalizeRedxWebhook(req: Request, res: Response, next: NextFunction) {
  const payload = req.body;
  const trackingId: string | undefined = payload.tracking_number;

  if (!trackingId) {
    return res.status(202).json({ received: true, skipped: "no tracking_number" });
  }

  const courierOrderId = await resolveCourierOrderId(trackingId);
  if (!courierOrderId) {
    return res.status(202).json({ received: true, skipped: "unknown tracking_number" });
  }

  const newStatus = REDX_STATUS_TO_COURIER_STATUS[payload.status];
  if (!newStatus) {
    return res.status(202).json({ received: true, skipped: `unmapped status: ${payload.status}` });
  }

  const shipmentKind = REDX_DELIVERY_TYPE_TO_SHIPMENT_KIND[payload.delivery_type] ?? "REGULAR";

  req.body = {
    courierOrderId,
    newStatus,
    courierStatus: payload.status,
    shipmentKind,
    messageEn: payload.message_en,
    messageBn: payload.message_bn,
    location: undefined,
    timestamp: payload.timestamp ? new Date(payload.timestamp) : new Date(),
    rawData: payload,
    invoiceId: payload.invoice_number,
  };

  next();
}