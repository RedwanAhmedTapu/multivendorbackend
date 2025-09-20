/*
  Warnings:

  - The values [USER] on the enum `ParticipantType` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "public"."ParticipantType_new" AS ENUM ('CUSTOMER', 'VENDOR', 'ADMIN', 'EMPLOYEE', 'DELIVERY');
ALTER TABLE "public"."conversation_participants" ALTER COLUMN "participantType" TYPE "public"."ParticipantType_new" USING ("participantType"::text::"public"."ParticipantType_new");
ALTER TABLE "public"."messages" ALTER COLUMN "senderType" TYPE "public"."ParticipantType_new" USING ("senderType"::text::"public"."ParticipantType_new");
ALTER TYPE "public"."ParticipantType" RENAME TO "ParticipantType_old";
ALTER TYPE "public"."ParticipantType_new" RENAME TO "ParticipantType";
DROP TYPE "public"."ParticipantType_old";
COMMIT;
