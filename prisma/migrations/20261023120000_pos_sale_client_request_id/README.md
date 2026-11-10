# POS sale clientRequestId (proposed — not applied)

Why: `prisma/migrations/20261022210000_pos_subscription_lifecycle/migration.sql`
is an older copy of the proposal and lacks `pos_sales."clientRequestId"` plus
`pos_sales_vendorId_clientRequestId_key`. The code and generated client need both.

1. Read-only check on the target database (staging first):

   ```sql
   SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pos_sales'
      AND column_name IN ('clientRequestId', 'soldByUserId', 'soldByEmployeeId');
   SELECT migration_name, finished_at FROM "_prisma_migrations"
    WHERE migration_name LIKE '20261022%';
   ```

2. If `clientRequestId` is missing, move this folder into `prisma/migrations/`
   and run `npx prisma migrate deploy` against that database only.
   Do not edit the already-applied lifecycle migration (checksum).

3. No client regeneration is needed: the generated client already has the field.
