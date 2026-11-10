-- Phase 4 (H-2 / D3): READ-ONLY detection of refunds that have no RefundRecord.
--
-- Such a refund consumes the order's refundable balance but can never be
-- approved or rejected (approveRefund / rejectRefund require the record).
-- Before Phase 4 every cancellation refund was created this way.
--
-- SELECT statements only — nothing is written. Run only with the owner's
-- approval, against a database the operator is allowed to read.

-- 1) Summary by refund status.
SELECT r."status", count(*) AS orphan_refunds, sum(r."amount") AS total_amount
FROM "refunds" r
LEFT JOIN "refund_records" rr ON rr."refundId" = r."id"
WHERE rr."id" IS NULL
GROUP BY r."status"
ORDER BY r."status";

-- 2) The individual refunds (ids and amounts only — no customer data).
SELECT r."id" AS refund_id, r."orderId" AS order_id, r."amount", r."status", r."createdAt"
FROM "refunds" r
LEFT JOIN "refund_records" rr ON rr."refundId" = r."id"
WHERE rr."id" IS NULL
ORDER BY r."createdAt";
