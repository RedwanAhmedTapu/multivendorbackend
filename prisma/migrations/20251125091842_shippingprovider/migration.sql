/*
  Warnings:

  - Added the required column `category` to the `faqs` table without a default value. This is not possible if the table is not empty.
  - Added the required column `isActive` to the `faqs` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "public"."faqs" ADD COLUMN     "category" TEXT NOT NULL,
ADD COLUMN     "isActive" BOOLEAN NOT NULL;
