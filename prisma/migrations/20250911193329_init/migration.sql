/*
  Warnings:

  - Added the required column `dangerousGoods` to the `warranties` table without a default value. This is not possible if the table is not empty.
  - Added the required column `packageHeight` to the `warranties` table without a default value. This is not possible if the table is not empty.
  - Added the required column `packageLength` to the `warranties` table without a default value. This is not possible if the table is not empty.
  - Added the required column `packageWeightUnit` to the `warranties` table without a default value. This is not possible if the table is not empty.
  - Added the required column `packageWeightValue` to the `warranties` table without a default value. This is not possible if the table is not empty.
  - Added the required column `packageWidth` to the `warranties` table without a default value. This is not possible if the table is not empty.
  - Added the required column `type` to the `warranties` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "public"."WeightUnit" AS ENUM ('KG', 'G');

-- CreateEnum
CREATE TYPE "public"."DangerousGoods" AS ENUM ('NONE', 'CONTAINS');

-- AlterTable
ALTER TABLE "public"."warranties" ADD COLUMN     "dangerousGoods" "public"."DangerousGoods" NOT NULL,
ADD COLUMN     "packageHeight" DOUBLE PRECISION NOT NULL,
ADD COLUMN     "packageLength" DOUBLE PRECISION NOT NULL,
ADD COLUMN     "packageWeightUnit" "public"."WeightUnit" NOT NULL,
ADD COLUMN     "packageWeightValue" DOUBLE PRECISION NOT NULL,
ADD COLUMN     "packageWidth" DOUBLE PRECISION NOT NULL,
ADD COLUMN     "type" TEXT NOT NULL;
