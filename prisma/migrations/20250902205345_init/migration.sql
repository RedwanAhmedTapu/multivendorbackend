/*
  Warnings:

  - A unique constraint covering the columns `[email,phone]` on the table `users` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "public"."users_email_key";

-- DropIndex
DROP INDEX "public"."users_phone_key";

-- CreateIndex
CREATE UNIQUE INDEX "users_email_phone_key" ON "public"."users"("email", "phone");
