import { PrismaClient,PaymentStatus, OrderStatus } from '@prisma/client';
import axios from 'axios';
import { sslcommerzConfig } from '../config/courier.ts';
import type { SSLCommerzInitResponse, SSLCommerzValidationResponse } from '../types/index.ts';


const prisma=new PrismaClient();

export class PaymentService {
  async processDeliveryFeePayment(orderId: number, amount: number) {
    // For COD, we only process delivery fee payment upfront
    const payment = await prisma.payment.create({
      data: {
        orderId,
        method: 'cash_on_delivery',
        amount,
        status: PaymentStatus.PENDING
      }
    });

    // Initiate SSLCommerz payment for delivery fee
    const sslResponse = await this.initiateSSLCommerzPayment({
      orderId: payment.id,
      amount,
      productName: 'Delivery Fee'
    });

    return { payment, sslResponse };
  }

  async confirmDeliveryFeePayment(transactionId: string, valId: string) {
    // Validate payment with SSLCommerz
    const validation = await this.validateSSLCommerzPayment(valId);

    if (validation.status === 'VALID') {
      const payment = await prisma.payment.update({
        where: { id: transactionId },
        data: {
          status: PaymentStatus.PAID,
          paidAt: new Date(),
          meta: validation
        }
      });

      // Update order status to confirmed
      await prisma.order.update({
        where: { id: payment.orderId },
        data: { status: OrderStatus.CONFIRMED }
      });

      return payment;
    }

    throw new Error('Payment validation failed');
  }

  async processProductPayment(orderId: number) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          include: {
            variant: {
              include: {
                product: true
              }
            }
          }
        },
        payments: true
      }
    });

    if (!order) throw new Error('Order not found');

    // Calculate product amount (total minus delivery fee already paid)
    const deliveryFeePaid = order.payments
      .filter(p => p.status === PaymentStatus.PAID)
      .reduce((sum, p) => sum + p.amount, 0);

    const productAmount = order.totalAmount - deliveryFeePaid;

    // Create payment record for product amount
    const payment = await prisma.payment.create({
      data: {
        orderId,
        method: 'cash_on_delivery_product',
        amount: productAmount,
        status: PaymentStatus.PENDING,
        meta: { type: 'product_payment' }
      }
    });

    return payment;
  }

  async completeProductPayment(orderId: number) {
    const payment = await prisma.payment.findFirst({
      where: {
        orderId,
        method: 'cash_on_delivery_product',
        status: PaymentStatus.PENDING
      }
    });

    if (!payment) throw new Error('Product payment not found');

    return prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.PAID,
        paidAt: new Date()
      }
    });
  }

  private async initiateSSLCommerzPayment(params: {
    orderId: string;
    amount: number;
    productName: string;
  }) {
    const payload = {
      store_id: sslcommerzConfig.storeId,
      store_passwd: sslcommerzConfig.storePassword,
      total_amount: params.amount,
      currency: 'BDT',
      tran_id: params.orderId,
      success_url: `${process.env.BASE_URL}/api/payments/success`,
      fail_url: `${process.env.BASE_URL}/api/payments/fail`,
      cancel_url: `${process.env.BASE_URL}/api/payments/cancel`,
      emi_option: 0,
      cus_name: 'Customer',
      cus_email: 'customer@example.com',
      cus_phone: '01700000000',
      cus_add1: 'Dhaka',
      cus_city: 'Dhaka',
      cus_country: 'Bangladesh',
      shipping_method: 'NO',
      product_name: params.productName,
      product_category: 'Service',
      product_profile: 'general'
    };

    const response = await axios.post(
      `${sslcommerzConfig.baseUrl}/gwprocess/v3/api.php`,
      payload
    );

    return response.data as SSLCommerzInitResponse;
  }

  private async validateSSLCommerzPayment(valId: string) {
    const payload = {
      val_id: valId,
      store_id: sslcommerzConfig.storeId,
      store_passwd: sslcommerzConfig.storePassword,
      format: 'json'
    };

    const response = await axios.get(
      `${sslcommerzConfig.baseUrl}/validator/api/validationserverAPI.php`,
      { params: payload }
    );

    return response.data as SSLCommerzValidationResponse;
  }
}