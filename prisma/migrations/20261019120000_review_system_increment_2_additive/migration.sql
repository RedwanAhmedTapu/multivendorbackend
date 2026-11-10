-- Migration A — Review System Increment 2, strictly additive.
--
-- Prepared and reviewed by hand; NOT APPLIED.
-- Companion migration B (20261019120100_review_system_uniqueness_transition)
-- completes the uniqueness transition once the dependent code is live.
--
-- Adds only, and rewrites nothing that exists:
--   • ReviewStatus enum (PUBLISHED, HIDDEN — no moderation state without its workflow)
--   • reviews.orderItemId   nullable — legacy rows keep NULL and are never backfilled
--   • reviews.status        defaults to PUBLISHED, so no rating changes
--   • reviews.vendorReply*  one seller response per review
--   • review_images         at most three per review (unique position + CHECK)
--   • review_comments       threads; same-review parent via the composite FK
--   • reviews(orderItemId)   unique — the new per-order-line key (see migration B)
--   • reviews(userId, productId) non-unique — the lookup index that survives the
--     swap; redundant with the old unique index until migration B removes it
--
-- Every new column is nullable or defaulted; no row is rewritten. The existing
-- unique index reviews_userId_productId_key is intentionally left in place:
-- only migration B touches it, and only after the dependent code is ready.

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PUBLISHED', 'HIDDEN');

-- AlterTable
ALTER TABLE "reviews" ADD COLUMN "orderItemId" TEXT,
ADD COLUMN "status" "ReviewStatus" NOT NULL DEFAULT 'PUBLISHED',
ADD COLUMN "vendorReply" TEXT,
ADD COLUMN "vendorReplyAt" TIMESTAMP(3),
ADD COLUMN "vendorReplyByUserId" TEXT;

-- CreateIndex
CREATE INDEX "reviews_productId_status_createdAt_idx" ON "reviews"("productId", "status", "createdAt");
CREATE INDEX "reviews_status_idx" ON "reviews"("status");

-- CreateIndex (uniqueness transition, additive half)
-- Both live here, not in migration B, so that B is nothing but the index removal
-- and the database never passes through a state without an enforcement key.
-- orderItemId is NULL on every existing row and PostgreSQL treats NULLs as
-- distinct in a unique index, so this build cannot fail on legacy reviews.
-- The (userId, productId) index duplicates the still-present unique index for
-- now (one is redundant to the planner); the pair exists so that B can remove
-- the old key without leaving the lookup uncovered for a single moment.
CREATE UNIQUE INDEX "reviews_orderItemId_key" ON "reviews"("orderItemId");
CREATE INDEX "reviews_userId_productId_idx" ON "reviews"("userId", "productId");

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "review_images" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "review_images_reviewId_position_key" ON "review_images"("reviewId", "position");

-- AddCheckConstraint
-- Three-image maximum: positions are 0, 1, 2 and unique per review, so a fourth
-- row violates either this CHECK or the unique index above. Prisma's schema
-- language cannot express CHECK; the database can — this is the enforcement.
ALTER TABLE "review_images" ADD CONSTRAINT "review_images_position_range" CHECK ("position" >= 0 AND "position" < 3);

-- AddForeignKey
ALTER TABLE "review_images" ADD CONSTRAINT "review_images_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "review_comments" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "parentId" TEXT,
    "body" TEXT NOT NULL,
    "hiddenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Unique criterion the composite parent FK points at (id, reviewId).
CREATE UNIQUE INDEX "review_comments_id_reviewId_key" ON "review_comments"("id", "reviewId");
CREATE INDEX "review_comments_reviewId_createdAt_idx" ON "review_comments"("reviewId", "createdAt");
CREATE INDEX "review_comments_parentId_idx" ON "review_comments"("parentId");

-- AddForeignKey
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (same-review parenting)
-- The parent row must belong to the same review: (parentId, reviewId) points at
-- (id, reviewId). Depth ≤ 1 is NOT expressible in SQL here and stays a service
-- rule (review-write-rules.ts). MATCH SIMPLE (PostgreSQL's default) means a NULL
-- parentId — a top-level comment — is exempt from the constraint.
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_parentId_reviewId_fkey" FOREIGN KEY ("parentId", "reviewId") REFERENCES "review_comments"("id", "reviewId") ON DELETE CASCADE ON UPDATE CASCADE;
