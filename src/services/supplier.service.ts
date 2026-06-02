import { PrismaClient, type EntityType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import type {
  CreateSupplierDTO,
  UpdateSupplierDTO,
  SupplierListQuery,
} from '../types/erp.types.ts';

const prisma = new PrismaClient();

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Auto-generates or retrieves the AP Liability COA entry for a supplier.
 * Called on create and (name is locked so) never again.
 */
async function upsertSupplierCOA(
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  supplierId: string,
  supplierName: string,
  entityType: EntityType,
  entityId: string | undefined,
): Promise<string> {
  const coaName = `AP — ${supplierName} (Liability)`;

  // Check if already exists
  const existing = await tx.chartOfAccount.findFirst({
    where: { entityType, entityId: entityId ?? null, name: coaName },
    select: { id: true },
  });
  if (existing) return existing.id;

  // Generate code: find last LIB code for this entity
  const prefix = entityType === 'ADMIN' ? 'ADM-LIB' : 'VND-LIB';
  const last = await tx.chartOfAccount.findFirst({
    where: { entityType, entityId: entityId ?? null, code: { startsWith: prefix } },
    orderBy: { createdAt: 'desc' },
    select: { code: true },
  });
  const seq = last
    ? parseInt(last.code.split('-').pop()!, 10) + 1
    : 1;
  const code = `${prefix}-${String(seq).padStart(4, '0')}`;

  const coa = await tx.chartOfAccount.create({
    data: {
      code,
      name: coaName,
      accountClass: 'LIABILITY',
      accountType: 'CURRENT_LIABILITY',
      group: 'ACCOUNTS_PAYABLE',
      nature: 'CREDIT',
      entityType,
      entityId: entityId ?? null,
      isSystem: false,
      isActive: true,
      canDelete: false,           // cannot delete while supplier exists
      description: `Accounts payable for supplier: ${supplierName}`,
    },
  });

  // Link supplier → COA
  await tx.supplier.update({
    where: { id: supplierId },
    data: { coaAccountId: coa.id },
  });

  return coa.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// OUTSTANDING DUE — derived from purchase orders
// ─────────────────────────────────────────────────────────────────────────────
async function getSupplierTotalDue(supplierId: string): Promise<number> {
  const agg = await prisma.purchaseOrder.aggregate({
    where: { supplierId },
    _sum: { dueAmount: true },
  });
  return agg._sum.dueAmount ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────────────────────────────────────
export async function createSupplier(dto: CreateSupplierDTO) {
  // Duplicate name guard
  const nameTaken = await prisma.supplier.findFirst({
    where: { name: { equals: dto.name, mode: 'insensitive' } },
    select: { id: true, name: true },
  });
  if (nameTaken) {
    throw new Error(
      `A supplier named "${nameTaken.name}" already exists. Please verify before proceeding.`,
    );
  }

  const supplier = await prisma.$transaction(async (tx) => {
    // 1. Create supplier row (coaAccountId linked after COA is created)
    const s = await tx.supplier.create({
      data: {
        name: dto.name,
        supplierType: dto.supplierType,
        status: 'ACTIVE',
        contactName: dto.contactName,
        phone: dto.phone,
        phone2: dto.phone2,
        email: dto.email,
        country: dto.country,
        city: dto.city,
        zipCode: dto.zipCode,
        fullAddress: dto.fullAddress,
        paymentTerms: dto.paymentTerms,
        creditLimit: dto.creditLimit ?? 0,
        bankAccountName: dto.bankAccountName,
        bankAccountNo: dto.bankAccountNo,
        bankName: dto.bankName,
        bankBranch: dto.bankBranch,
        routingNo: dto.routingNo,
        notes: dto.notes,
      },
    });

    // 2. Auto-create AP Liability COA and link back
    await upsertSupplierCOA(tx, s.id, s.name, dto.entityType, dto.entityId);

    return tx.supplier.findUnique({
      where: { id: s.id },
      include: { coaAccount: true },
    });
  });

  return supplier;
}

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE  (name is immutable — locked after creation)
// ─────────────────────────────────────────────────────────────────────────────
export async function updateSupplier(id: string, dto: UpdateSupplierDTO) {
  const existing = await prisma.supplier.findUnique({ where: { id } });
  if (!existing) throw new Error('Supplier not found');

  const updated = await prisma.supplier.update({
    where: { id },
    data: {
      supplierType: dto.supplierType,
      status: dto.status,
      contactName: dto.contactName,
      phone: dto.phone,
      phone2: dto.phone2,
      email: dto.email,
      country: dto.country,
      city: dto.city,
      zipCode: dto.zipCode,
      fullAddress: dto.fullAddress,
      paymentTerms: dto.paymentTerms,
      creditLimit: dto.creditLimit,
      bankAccountName: dto.bankAccountName,
      bankAccountNo: dto.bankAccountNo,
      bankName: dto.bankName,
      bankBranch: dto.bankBranch,
      routingNo: dto.routingNo,
      notes: dto.notes,
    },
    include: { coaAccount: true },
  });

  return updated;
}

// ─────────────────────────────────────────────────────────────────────────────
// TOGGLE STATUS
// ─────────────────────────────────────────────────────────────────────────────
export async function toggleSupplierStatus(id: string) {
  const existing = await prisma.supplier.findUnique({
    where: { id },
    select: { id: true, status: true },
  });
  if (!existing) throw new Error('Supplier not found');

  const newStatus = existing.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
  return prisma.supplier.update({
    where: { id },
    data: { status: newStatus },
    select: { id: true, name: true, status: true },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET ONE
// ─────────────────────────────────────────────────────────────────────────────
export async function getSupplierById(id: string) {
  const supplier = await prisma.supplier.findUnique({
    where: { id },
    include: { coaAccount: true },
  });
  if (!supplier) throw new Error('Supplier not found');

  const totalDue = await getSupplierTotalDue(id);
  return { ...supplier, totalDue };
}

// ─────────────────────────────────────────────────────────────────────────────
// LIST
// ─────────────────────────────────────────────────────────────────────────────
export async function listSuppliers(query: SupplierListQuery) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = {};
  if (query.status) where.status = query.status;
  if (query.supplierType) where.supplierType = query.supplierType;
  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: 'insensitive' } },
      { email: { contains: query.search, mode: 'insensitive' } },
      { phone: { contains: query.search } },
    ];
  }

  const [suppliers, total] = await Promise.all([
    prisma.supplier.findMany({
      where,
      include: { coaAccount: { select: { id: true, code: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.supplier.count({ where }),
  ]);

  // Attach derived totalDue for each supplier
  const suppliersWithDue = await Promise.all(
    suppliers.map(async (s) => ({
      ...s,
      totalDue: await getSupplierTotalDue(s.id),
    })),
  );

  return {
    data: suppliersWithDue,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DUES SUMMARY for one supplier (with per-PO breakdown)
// ─────────────────────────────────────────────────────────────────────────────
export async function getSupplierDues(supplierId: string) {
  const supplier = await prisma.supplier.findUnique({
    where: { id: supplierId },
    select: { id: true, name: true },
  });
  if (!supplier) throw new Error('Supplier not found');

  const pos = await prisma.purchaseOrder.findMany({
    where: { supplierId, dueAmount: { gt: 0 } },
    select: {
      id: true,
      purchaseNo: true,
      purchaseDate: true,
      totalAmount: true,
      paidAmount: true,
      dueAmount: true,
      status: true,
    },
    orderBy: { purchaseDate: 'asc' },
  });

  const totalDue = pos.reduce((sum, p) => sum + p.dueAmount, 0);

  return { supplier, totalDue, pendingOrders: pos };
}