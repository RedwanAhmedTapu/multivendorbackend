-- CreateEnum
CREATE TYPE "public"."MessageStatus" AS ENUM ('SENDING', 'SENT', 'DELIVERED', 'SEEN');

-- AlterTable
ALTER TABLE "public"."messages" ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "seenAt" TIMESTAMP(3),
ADD COLUMN     "status" "public"."MessageStatus" NOT NULL DEFAULT 'SENT';
