// config/prisma.ts
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  prismaDirect: PrismaClient | undefined;
};

// ✅ Default client — uses DATABASE_URL (pooled, pgbouncer, port 6543).
// Fine for normal request-scoped queries (findMany, create, update, etc.)
// where each query is its own short-lived statement.
export const prisma =
  globalForPrisma.prisma ?? new PrismaClient();

// ✅ Direct (non-pooled) client — uses DIRECT_URL (port 5432).
// REQUIRED for prisma.$transaction(async (tx) => {...}) interactive
// transactions. PgBouncer in "transaction" pooling mode hands the underlying
// connection back to the pool after every single statement, but an
// interactive transaction needs one connection pinned for its entire
// duration. Running it over the pooled URL causes:
//   "Transaction API error: Transaction not found. ... refers to an old
//    closed transaction Prisma doesn't have information about anymore"
// — sometimes on the very first query inside the transaction, sometimes
// after a few, depending on pooler timing. Using DIRECT_URL avoids this
// entirely since the connection isn't shared/recycled by pgbouncer.
//
// Use `prismaDirect` ONLY for code paths that call $transaction (bulk
// imports, multi-step writes that must be atomic). Keep using `prisma` for
// everything else — direct connections are a limited resource on Supabase's
// free/small tiers, so don't swap every query over to this client.
export const prismaDirect =
  globalForPrisma.prismaDirect ??
  new PrismaClient({
    datasources: { db: { url: process.env.DIRECT_URL } },
  });

// IMPORTANT: without this, every dev-mode hot-reload re-executes this
// module and creates a brand-new PrismaClient (and a brand-new underlying
// connection) on top of the old one, which never gets closed. Direct
// (non-pooled) connections are especially scarce on hosted Postgres
// (Supabase/Neon free & small tiers usually allow only a handful), so this
// leak exhausts them within a few file saves and any $transaction started
// afterward gets handed a connection that's about to be killed — which is
// exactly the "Transaction not found / old closed transaction" error.
// Caching on `globalThis` survives the module re-evaluation and reuses the
// same client (and its connections) across reloads. In production this is
// a no-op since the module only loads once anyway.
if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
  globalForPrisma.prismaDirect = prismaDirect;
}