-- CreateEnum
CREATE TYPE "public"."SliderType" AS ENUM ('HOMEPAGE', 'VENDORPAGE');

-- CreateTable
CREATE TABLE "public"."Slider" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "subtitle" TEXT,
    "description" TEXT,
    "imageUrl" TEXT NOT NULL,
    "link" TEXT,
    "buttonText" TEXT,
    "buttonLink" TEXT,
    "type" "public"."SliderType" NOT NULL,
    "vendorId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Slider_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "public"."Slider" ADD CONSTRAINT "Slider_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "public"."vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
