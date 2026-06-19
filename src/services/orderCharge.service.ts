import { PrismaClient } from '@prisma/client';
import type { ChargeValueType, ChargeAppliesTo } from '@prisma/client';

const prisma = new PrismaClient();

export interface CreateChargeInput {
  key: string;
  label: string;
  type: ChargeValueType;
  value: number;
  isActive?: boolean;
  appliesTo?: ChargeAppliesTo;
  sortOrder?: number;
  description?: string;
}

export interface UpdateChargeInput {
  label?: string;
  type?: ChargeValueType;
  value?: number;
  isActive?: boolean;
  appliesTo?: ChargeAppliesTo;
  sortOrder?: number;
  description?: string;
}

export class OrderChargeService {

  /** Admin: create a new charge type (e.g. Platform Fee, COD Handling Fee) */
  async createCharge(data: CreateChargeInput) {
    return prisma.orderChargeType.create({ data });
  }

  /** Admin: list all charges (active + inactive) */
  async listCharges() {
    return prisma.orderChargeType.findMany({
      orderBy: { sortOrder: 'asc' },
    });
  }

  /** Used during checkout/order-summary calculation — only active charges */
  async getActiveCharges(paymentMethod: 'COD' | 'PREPAID') {
    return prisma.orderChargeType.findMany({
      where: {
        isActive: true,
        appliesTo: { in: ['ALL', paymentMethod === 'COD' ? 'COD_ONLY' : 'PREPAID_ONLY'] },
      },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async getChargeById(id: string) {
    return prisma.orderChargeType.findUnique({ where: { id } });
  }

  async updateCharge(id: string, data: UpdateChargeInput) {
    return prisma.orderChargeType.update({ where: { id }, data });
  }

  async deleteCharge(id: string) {
    return prisma.orderChargeType.delete({ where: { id } });
  }

  /** Toggle active/inactive quickly */
  async toggleCharge(id: string, isActive: boolean) {
    return prisma.orderChargeType.update({ where: { id }, data: { isActive } });
  }

  /**
   * Compute order summary given a subtotal and payment method.
   * Returns each applied charge plus the grand total.
   */
  async computeOrderSummary(subtotal: number, paymentMethod: 'COD' | 'PREPAID') {
    const charges = await this.getActiveCharges(paymentMethod);

    const appliedCharges = charges.map((c) => {
      const amount =
        c.type === 'PERCENTAGE'
          ? Math.round((subtotal * Number(c.value)) / 100)
          : Number(c.value);

      return {
        key: c.key,
        label: c.label,
        amount,
      };
    });

    const total =
      subtotal + appliedCharges.reduce((sum, c) => sum + c.amount, 0);

    return {
      subtotal,
      charges: appliedCharges,
      total,
    };
  }
}