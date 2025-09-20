/*
  Warnings:

  - You are about to drop the column `productId` on the `messages` table. All the data in the column will be lost.
  - You are about to drop the column `receiverId` on the `messages` table. All the data in the column will be lost.
  - You are about to drop the `SupportTicket` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ticket_messages` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `vendor_conversation_messages` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `vendor_conversations` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `conversationId` to the `messages` table without a default value. This is not possible if the table is not empty.
  - Added the required column `senderType` to the `messages` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "public"."ConversationType" AS ENUM ('PRODUCT_INQUIRY', 'VENDOR_SUPPORT', 'USER_SUPPORT', 'DELIVERY_CHAT', 'GENERAL_CHAT');

-- CreateEnum
CREATE TYPE "public"."ParticipantType" AS ENUM ('USER', 'VENDOR', 'ADMIN', 'EMPLOYEE', 'DELIVERY');

-- DropForeignKey
ALTER TABLE "public"."SupportTicket" DROP CONSTRAINT "SupportTicket_userId_fkey";

-- DropForeignKey
ALTER TABLE "public"."messages" DROP CONSTRAINT "messages_productId_fkey";

-- DropForeignKey
ALTER TABLE "public"."messages" DROP CONSTRAINT "messages_receiverId_fkey";

-- DropForeignKey
ALTER TABLE "public"."ticket_messages" DROP CONSTRAINT "ticket_messages_senderId_fkey";

-- DropForeignKey
ALTER TABLE "public"."ticket_messages" DROP CONSTRAINT "ticket_messages_ticketId_fkey";

-- DropForeignKey
ALTER TABLE "public"."vendor_conversation_messages" DROP CONSTRAINT "vendor_conversation_messages_conversationId_fkey";

-- DropForeignKey
ALTER TABLE "public"."vendor_conversation_messages" DROP CONSTRAINT "vendor_conversation_messages_senderId_fkey";

-- DropForeignKey
ALTER TABLE "public"."vendor_conversations" DROP CONSTRAINT "vendor_conversations_userId_fkey";

-- DropForeignKey
ALTER TABLE "public"."vendor_conversations" DROP CONSTRAINT "vendor_conversations_vendorId_fkey";

-- AlterTable
ALTER TABLE "public"."messages" DROP COLUMN "productId",
DROP COLUMN "receiverId",
ADD COLUMN     "conversationId" TEXT NOT NULL,
ADD COLUMN     "senderDeliveryPersonId" TEXT,
ADD COLUMN     "senderEmployeeId" TEXT,
ADD COLUMN     "senderType" "public"."ParticipantType" NOT NULL,
ADD COLUMN     "senderVendorId" TEXT,
ALTER COLUMN "senderId" DROP NOT NULL;

-- DropTable
DROP TABLE "public"."SupportTicket";

-- DropTable
DROP TABLE "public"."ticket_messages";

-- DropTable
DROP TABLE "public"."vendor_conversation_messages";

-- DropTable
DROP TABLE "public"."vendor_conversations";

-- DropEnum
DROP TYPE "public"."SupportPriority";

-- DropEnum
DROP TYPE "public"."SupportTicketStatus";

-- CreateTable
CREATE TABLE "public"."conversations" (
    "id" TEXT NOT NULL,
    "type" "public"."ConversationType" NOT NULL,
    "productId" TEXT,
    "orderId" INTEGER,
    "title" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "lastMessageAt" TIMESTAMP(3),
    "lastMessageText" TEXT,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."conversation_participants" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT,
    "vendorId" TEXT,
    "employeeId" TEXT,
    "deliveryPersonId" TEXT,
    "participantType" "public"."ParticipantType" NOT NULL,
    "lastReadAt" TIMESTAMP(3),
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),
    "isMuted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "conversation_participants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversations_type_lastMessageAt_idx" ON "public"."conversations"("type", "lastMessageAt");

-- CreateIndex
CREATE INDEX "conversations_productId_lastMessageAt_idx" ON "public"."conversations"("productId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "conversations_orderId_lastMessageAt_idx" ON "public"."conversations"("orderId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "conversations_lastMessageAt_idx" ON "public"."conversations"("lastMessageAt");

-- CreateIndex
CREATE INDEX "conversation_participants_conversationId_lastReadAt_idx" ON "public"."conversation_participants"("conversationId", "lastReadAt");

-- CreateIndex
CREATE INDEX "conversation_participants_userId_lastReadAt_idx" ON "public"."conversation_participants"("userId", "lastReadAt");

-- CreateIndex
CREATE INDEX "conversation_participants_vendorId_lastReadAt_idx" ON "public"."conversation_participants"("vendorId", "lastReadAt");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_participants_conversationId_userId_vendorId_em_key" ON "public"."conversation_participants"("conversationId", "userId", "vendorId", "employeeId", "deliveryPersonId");

-- CreateIndex
CREATE INDEX "messages_conversationId_createdAt_idx" ON "public"."messages"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "messages_createdAt_idx" ON "public"."messages"("createdAt");

-- CreateIndex
CREATE INDEX "messages_senderType_createdAt_idx" ON "public"."messages"("senderType", "createdAt");

-- CreateIndex
CREATE INDEX "products_vendorId_idx" ON "public"."products"("vendorId");

-- CreateIndex
CREATE INDEX "vendor_offers_vendorId_idx" ON "public"."vendor_offers"("vendorId");

-- CreateIndex
CREATE INDEX "vendor_payouts_vendorId_idx" ON "public"."vendor_payouts"("vendorId");

-- AddForeignKey
ALTER TABLE "public"."conversations" ADD CONSTRAINT "conversations_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."conversations" ADD CONSTRAINT "conversations_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."conversation_participants" ADD CONSTRAINT "conversation_participants_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "public"."conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."conversation_participants" ADD CONSTRAINT "conversation_participants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."conversation_participants" ADD CONSTRAINT "conversation_participants_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."conversation_participants" ADD CONSTRAINT "conversation_participants_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "public"."employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."conversation_participants" ADD CONSTRAINT "conversation_participants_deliveryPersonId_fkey" FOREIGN KEY ("deliveryPersonId") REFERENCES "public"."delivery_persons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."messages" ADD CONSTRAINT "messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "public"."conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."messages" ADD CONSTRAINT "messages_senderVendorId_fkey" FOREIGN KEY ("senderVendorId") REFERENCES "public"."vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."messages" ADD CONSTRAINT "messages_senderEmployeeId_fkey" FOREIGN KEY ("senderEmployeeId") REFERENCES "public"."employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."messages" ADD CONSTRAINT "messages_senderDeliveryPersonId_fkey" FOREIGN KEY ("senderDeliveryPersonId") REFERENCES "public"."delivery_persons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
