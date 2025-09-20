import {PrismaClient ,PayoutStatus, OrderStatus, PaymentStatus } from '@prisma/client';
import axios from 'axios';
import { sslcommerzConfig } from '../config/courier.ts';


const prisma=new PrismaClient();

export class PayoutService {
  async processVendorPayouts(vendorId: string, period: string = 'weekly') {
    // Get all delivered orders for the vendor in the period
    const orders = await prisma.order.findMany({
      where: {
        vendorId,
        status: OrderStatus.DELIVERED,
        payments: {
          some: {
            status: PaymentStatus.PAID,
            paidAt: {
              gte: this.getPeriodStartDate(period)
            }
          }
        }
      },
      include: {
        payments: true,
        items: {
          include: {
            variant: {
              include: {
                product: true
              }
            }
          }
        }
      }
    });

    let totalAmount = 0;
    let totalCommission = 0;

    for (const order of orders) {
      const productPayments = order.payments.filter(p => 
        p.method === 'cash_on_delivery_product' && p.status === PaymentStatus.PAID
      );

      const productAmount = productPayments.reduce((sum, p) => sum + p.amount, 0);
      
      // Get current commission rate
      const commissionRate = await this.getCurrentCommissionRate(vendorId);
      const commission = productAmount * (commissionRate / 100);
      
      totalAmount += productAmount;
      totalCommission += commission;

      // Mark orders as processed for payout
      await prisma.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.REFUNDED } // Or create a new status like PROCESSED_FOR_PAYOUT
      });
    }

    const payoutAmount = totalAmount - totalCommission;

    if (payoutAmount > 0) {
      // Create payout record
      const payout = await prisma.vendorPayout.create({
        data: {
          vendorId,
          amount: payoutAmount,
          status: PayoutStatus.PENDING,
          method: 'bank_transfer',
          period,
          note: `Payout for ${period} period. Total sales: ${totalAmount}, Commission: ${totalCommission}`
        }
      });

      // Process payout through SSLCommerz or bank transfer
      await this.processPayoutThroughSSLCommerz(vendorId, payoutAmount, payout.id);

      return payout;
    }

    return null;
  }

  async processPayoutThroughSSLCommerz(vendorId: string, amount: number, payoutId: string) {
    try {
      // Get vendor bank details (would be stored in vendor profile)
      const vendor = await prisma.vendor.findUnique({
        where: { id: vendorId },
        include: { user: true }
      });

      if (!vendor || !vendor.user) {
        throw new Error('Vendor or user not found');
      }

      // SSLCommerz payout API call (pseudo-code - actual implementation depends on SSLCommerz payout API)
      const payoutPayload = {
        store_id: sslcommerzConfig.storeId,
        store_passwd: sslcommerzConfig.storePassword,
        payout_amount: amount,
        payout_to: vendor.user.name,
        payout_account: vendor.user.phone, // Assuming phone as account identifier
        payout_reference: payoutId,
        payout_note: `Vendor payout for ${vendor.storeName}`
      };

      // This is a placeholder - SSLCommerz might have different payout endpoints
      const response = await axios.post(
        `${sslcommerzConfig.baseUrl}/payout/api/v1/process`,
        payoutPayload
      );

      if (response.data.status === 'SUCCESS') {
        await prisma.vendorPayout.update({
          where: { id: payoutId },
          data: {
            status: PayoutStatus.PAID,
            paidAt: new Date(),
            meta: response.data
          }
        });
      } else {
        throw new Error('Payout processing failed');
      }

    } catch (error) {
      await prisma.vendorPayout.update({
        where: { id: payoutId },
        data: {
          status: PayoutStatus.FAILED,
          note: `Payout failed: ${error.message}`
        }
      });
      throw error;
    }
  }

  private async getCurrentCommissionRate(vendorId: string): Promise<number> {
    const commission = await prisma.vendorCommission.findFirst({
      where: {
        vendorId,
        effectiveFrom: { lte: new Date() },
        OR: [
          { effectiveTo: null },
          { effectiveTo: { gte: new Date() } }
        ]
      },
      orderBy: { effectiveFrom: 'desc' }
    });

    return commission?.rate || 10; // Default 10% commission
  }

  private getPeriodStartDate(period: string): Date {
    const now = new Date();
    switch (period) {
      case 'daily':
        return new Date(now.setDate(now.getDate() - 1));
      case 'weekly':
        return new Date(now.setDate(now.getDate() - 7));
      case 'monthly':
        return new Date(now.setMonth(now.getMonth() - 1));
      default:
        return new Date(now.setDate(now.getDate() - 7));
    }
  }

  async handleOrderCancellation(orderId: number, reason: string) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        payments: true,
        vendor: true
      }
    });

    if (!order) throw new Error('Order not found');

    // Refund any paid delivery fee
    const deliveryPayments = order.payments.filter(p => 
      p.method === 'cash_on_delivery' && p.status === PaymentStatus.PAID
    );

    for (const payment of deliveryPayments) {
      await this.processRefund(payment.id, payment.amount, reason);
    }

    // Update order status
    await prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.CANCELLED }
    });

    // Create refund records
    await prisma.refund.create({
      data: {
        orderId,
        amount: deliveryPayments.reduce((sum, p) => sum + p.amount, 0),
        reason,
        status: 'PENDING'
      }
    });
  }

  private async processRefund(paymentId: string, amount: number, reason: string) {
    // Implement SSLCommerz refund API call
    // This is pseudo-code - actual implementation depends on SSLCommerz refund API
    try {
      const refundPayload = {
        store_id: sslcommerzConfig.storeId,
        store_passwd: sslcommerzConfig.storePassword,
        refund_amount: amount,
        refund_remarks: reason,
        bank_tran_id: paymentId
      };

      const response = await axios.post(
        `${sslcommerzConfig.baseUrl}/validator/api/refund.php`,
        refundPayload
      );

      if (response.data.status === 'success') {
        await prisma.payment.update({
          where: { id: paymentId },
          data: { status: PaymentStatus.REFUNDED }
        });
      }
    } catch (error) {
      console.error('Refund processing failed:', error);
      // Handle refund failure (manual intervention might be needed)
    }
  }
}