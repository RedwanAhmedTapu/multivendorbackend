-- CreateTable
CREATE TABLE "public"."hr_employee_bank_accounts" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT,
    "employeeId" TEXT NOT NULL,
    "holderName" TEXT,
    "bank" TEXT,
    "branch" TEXT,
    "accountNumber" TEXT,
    "routingNumber" TEXT,
    "accountType" TEXT NOT NULL DEFAULT 'SALARY',
    "mfsProvider" TEXT,
    "mfsNumber" TEXT,
    "paymentMethod" TEXT NOT NULL DEFAULT 'BANK',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_employee_bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."hr_previous_employments" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT,
    "employeeId" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "designation" TEXT,
    "department" TEXT,
    "joinDate" TEXT,
    "leaveDate" TEXT,
    "lastSalary" DECIMAL(14,2),
    "reasonForLeaving" TEXT,
    "supervisor" TEXT,
    "contact" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_previous_employments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hr_employee_bank_accounts_vendorId_employeeId_idx" ON "public"."hr_employee_bank_accounts"("vendorId", "employeeId");

-- CreateIndex
CREATE INDEX "hr_previous_employments_vendorId_employeeId_idx" ON "public"."hr_previous_employments"("vendorId", "employeeId");

-- AddForeignKey
ALTER TABLE "public"."hr_employee_profiles" ADD CONSTRAINT "hr_employee_profiles_reportingManagerId_fkey" FOREIGN KEY ("reportingManagerId") REFERENCES "public"."hr_employee_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."hr_promotions" ADD CONSTRAINT "hr_promotions_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "public"."hr_employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."hr_transfers" ADD CONSTRAINT "hr_transfers_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "public"."hr_employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."hr_salary_revisions" ADD CONSTRAINT "hr_salary_revisions_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "public"."hr_employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."hr_employee_bank_accounts" ADD CONSTRAINT "hr_employee_bank_accounts_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "public"."hr_employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."hr_previous_employments" ADD CONSTRAINT "hr_previous_employments_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "public"."hr_employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

