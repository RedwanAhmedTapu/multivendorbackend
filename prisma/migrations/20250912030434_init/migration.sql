/*
  Warnings:

  - You are about to drop the column `isApproved` on the `products` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "public"."ProductApprovalStatus" AS ENUM ('PENDING', 'ACTIVE', 'REJECTED');

-- AlterTable
ALTER TABLE "public"."products" DROP COLUMN "isApproved",
ADD COLUMN     "approvalStatus" "public"."ProductApprovalStatus" NOT NULL DEFAULT 'PENDING';
