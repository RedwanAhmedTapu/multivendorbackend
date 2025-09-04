-- CreateTable
CREATE TABLE "public"."specification_options" (
    "id" TEXT NOT NULL,
    "specificationId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "specification_options_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "specification_options_specificationId_value_key" ON "public"."specification_options"("specificationId", "value");

-- AddForeignKey
ALTER TABLE "public"."specification_options" ADD CONSTRAINT "specification_options_specificationId_fkey" FOREIGN KEY ("specificationId") REFERENCES "public"."specifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
