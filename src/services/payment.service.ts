// services/payment.service.ts
import { PrismaClient, PaymentStatus, OrderStatus } from "@prisma/client";
import axios from "axios";
import type {
  SSLCommerzInitResponse,
  SSLCommerzValidationResponse,
} from "../types/index.ts";

const prisma = new PrismaClient();

const STORE_ID = process.env.SSLCOMMERZ_STORE_ID!;
const STORE_PASSWORD = process.env.SSLCOMMERZ_STORE_PASSWORD!;
const IS_LIVE = process.env.NODE_ENV === "production";

const BASE_URL = IS_LIVE
  ? "https://securepay.sslcommerz.com"
  : "https://sandbox.sslcommerz.com";

// Gateway code mapping
const GATEWAY_MAP: Record<string, string> = {
  BKASH: "bkash",
  NAGAD: "nagad",
  UPAY: "upay",
  EBL_COF: "visacard,mastercard,amexcard",
  COD: "COD",
};

class PaymentService {
  /**
   * Initialize payment with selected gateway
   */
  async initiatePayment(params: {
    orderId: number;
    userId: number;
    gatewayCode: string;
  }) {
    const { orderId, userId, gatewayCode } = params;

    // Get order details
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            address: true,
            city: true,
            state: true,
            postcode: true,
          },
        },
        items: {
          include: {
            variant: {
              include: {
                product: {
                  select: {
                    name: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!order) throw new Error("Order not found");

    const user = order.user;
    const tran_id = `TXN_${Date.now()}_${orderId}`;

    // Create payment record
    const payment = await prisma.payment.create({
      data: {
        orderId,
        transactionId: tran_id,
        method: gatewayCode,
        amount: order.totalAmount,
        status: PaymentStatus.PENDING,
        meta: { gatewayCode, type: "order_payment" },
      },
    });

    // Prepare product names
    const productNames = order.items
      .map((item) => item.variant.product.name)
      .join(", ");

    // Prepare SSLCommerz payload
    const paymentData = {
      store_id: STORE_ID,
      store_passwd: STORE_PASSWORD,
      total_amount: order.totalAmount,
      currency: "BDT",
      tran_id,
      success_url: `${process.env.BACKEND_URL}/api/payment/success`,
      fail_url: `${process.env.BACKEND_URL}/api/payment/fail`,
      cancel_url: `${process.env.BACKEND_URL}/api/payment/cancel`,
      ipn_url: `${process.env.BACKEND_URL}/api/payment/ipn`,

      // Customer information
      cus_name: user.name || "Customer",
      cus_email: user.email,
      cus_add1: user.address || "Dhaka",
      cus_add2: user.address || "Dhaka",
      cus_city: user.city || "Dhaka",
      cus_state: user.state || "Dhaka",
      cus_postcode: user.postcode || "1000",
      cus_country: "Bangladesh",
      cus_phone: user.phone || "01700000000",

      // Product information
      product_name: productNames.substring(0, 250) || "E-commerce Order",
      product_category: "general",
      product_profile: "general",

      // Shipping information
      shipping_method: "YES",
      ship_name: user.name || "Customer",
      ship_add1: user.address || "Dhaka",
      ship_add2: user.address || "Dhaka",
      ship_city: user.city || "Dhaka",
      ship_state: user.state || "Dhaka",
      ship_postcode: user.postcode || "1000",
      ship_country: "Bangladesh",

      // Gateway selection for direct redirect
      multi_card_name: GATEWAY_MAP[gatewayCode] || "",

      // Additional metadata
      value_a: orderId.toString(),
      value_b: userId.toString(),
      value_c: gatewayCode,
      value_d: "order_payment",
    };

    try {
      // Call SSLCommerz API
      const response = await axios.post<SSLCommerzInitResponse>(
        `${BASE_URL}/gwprocess/v4/api.php`,
        new URLSearchParams(paymentData as any).toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        },
      );

      if (response.data.status !== "SUCCESS") {
        throw new Error(
          response.data.failedreason || "Payment initiation failed",
        );
      }

      // Update payment with session key
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          meta: {
            ...payment.meta,
            sessionKey: response.data.sessionkey,
          },
        },
      });

      return {
        payment,
        sessionKey: response.data.sessionkey,
        gatewayPageURL: response.data.GatewayPageURL,
        redirectGatewayURL: response.data.redirectGatewayURL,
        transactionId: tran_id,
      };
    } catch (error: any) {
      // Update payment status to failed
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.FAILED },
      });

      console.error(
        "SSLCommerz Init Error:",
        error.response?.data || error.message,
      );
      throw new Error("Failed to initiate payment");
    }
  }

  /**
   * Validate payment with SSLCommerz
   */
  async validatePayment(val_id: string): Promise<SSLCommerzValidationResponse> {
    try {
      const response = await axios.get<SSLCommerzValidationResponse>(
        `${BASE_URL}/validator/api/validationserverAPI.php`,
        {
          params: {
            val_id,
            store_id: STORE_ID,
            store_passwd: STORE_PASSWORD,
            format: "json",
          },
        },
      );

      return response.data;
    } catch (error: any) {
      console.error(
        "SSLCommerz Validation Error:",
        error.response?.data || error.message,
      );
      throw new Error("Payment validation failed");
    }
  }

  /**
   * Confirm payment after validation
   */
  async confirmPayment(
    transactionId: string,
    validationData: SSLCommerzValidationResponse,
  ) {
    if (
      validationData.status !== "VALID" &&
      validationData.status !== "VALIDATED"
    ) {
      throw new Error("Invalid payment status");
    }

    // Get payment with order details
    const payment = await prisma.payment.findUnique({
      where: { transactionId },
      include: {
        order: {
          include: {
            items: {
              include: {
                variant: {
                  include: {
                    product: {
                      select: {
                        id: true,
                        vendorId: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!payment) throw new Error("Payment not found");

    // Update payment record
    const updatedPayment = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.PAID,
        paidAt: new Date(),
        meta: {
          ...payment.meta,
          valId: validationData.val_id,
          bankTranId: validationData.bank_tran_id,
          cardType: validationData.card_type,
          cardNo: validationData.card_no,
          cardIssuer: validationData.card_issuer,
          cardBrand: validationData.card_brand,
          validation: validationData,
        },
      },
    });

    // Update order status
    await prisma.order.update({
      where: { id: payment.orderId },
      data: {
        status: OrderStatus.PAID,
        paymentMethod: validationData.card_type,
      },
    });

    // Distribute amount to vendors
    await this.distributeToVendors(payment.order);

    return updatedPayment;
  }

  /**
   * Distribute payment to vendors
   */
  private async distributeToVendors(order: any) {
    const vendorPayments: Record<number, number> = {};

    // Calculate vendor shares
    for (const item of order.items) {
      const vendorId = item.variant.product.vendorId;
      if (vendorId) {
        const itemTotal = item.price * item.quantity;
        vendorPayments[vendorId] = (vendorPayments[vendorId] || 0) + itemTotal;
      }
    }

    // Update vendor balances
    const updatePromises = Object.entries(vendorPayments).map(
      ([vendorId, amount]) =>
        prisma.vendor.update({
          where: { id: Number(vendorId) },
          data: {
            balance: { increment: amount },
          },
        }),
    );

    await Promise.all(updatePromises);
  }

  /**
   * Handle COD order confirmation
   */
  async handleCODOrder(orderId: number) {
    const order = await prisma.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.CONFIRMED,
        paymentMethod: "Cash on Delivery",
      },
    });

    // Create COD payment record
    await prisma.payment.create({
      data: {
        orderId,
        method: "COD",
        amount: order.totalAmount,
        status: PaymentStatus.PENDING,
        meta: { type: "cod_order", paymentOnDelivery: true },
      },
    });

    return order;
  }

  /**
   * Process delivery fee payment for COD
   */
  async processDeliveryFeePayment(
    orderId: number,
    amount: number,
    userId: number,
    gatewayCode: string = "BKASH",
  ) {
    // Create delivery fee payment record
    const payment = await prisma.payment.create({
      data: {
        orderId,
        method: gatewayCode,
        amount,
        status: PaymentStatus.PENDING,
        meta: { type: "delivery_fee", description: "COD Delivery Fee" },
      },
    });

    // Initiate payment
    const sslResponse = await this.initiatePayment({
      orderId,
      userId,
      gatewayCode,
    });

    return { payment, sslResponse };
  }

  /**
   * Complete product payment for COD (after delivery)
   */
  async completeProductPayment(orderId: number) {
    const payment = await prisma.payment.findFirst({
      where: {
        orderId,
        method: "COD",
        status: PaymentStatus.PENDING,
      },
      include: {
        order: {
          include: {
            items: {
              include: {
                variant: {
                  include: {
                    product: {
                      select: {
                        vendorId: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!payment) throw new Error("COD payment not found");

    // Update payment status
    const updatedPayment = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.PAID,
        paidAt: new Date(),
      },
    });

    // Update order status
    await prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.DELIVERED },
    });

    // Distribute to vendors
    await this.distributeToVendors(payment.order);

    return updatedPayment;
  }

  /**
   * Handle failed payment
   */
  async handleFailedPayment(transactionId: string, reason?: string) {
    return prisma.payment.update({
      where: { transactionId },
      data: {
        status: PaymentStatus.FAILED,
        meta: { failureReason: reason },
      },
    });
  }

  /**
   * Handle cancelled payment
   */
  async handleCancelledPayment(transactionId: string) {
    return prisma.payment.update({
      where: { transactionId },
      data: {
        status: PaymentStatus.CANCELLED,
      },
    });
  }

  /**
   * Get payment by transaction ID
   */
  async getPaymentByTransactionId(transactionId: string) {
    return prisma.payment.findUnique({
      where: { transactionId },
      include: {
        order: true,
      },
    });
  }

  /**
   * Get payment details by order ID
   */
  async getPaymentDetails(orderId: number) {
    return prisma.payment.findMany({
      where: { orderId },
      include: {
        order: {
          include: {
            items: {
              include: {
                variant: {
                  include: {
                    product: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Query transaction status by transaction ID
   */
  async queryTransactionStatus(transactionId: string) {
    try {
      const response = await axios.get(
        `${BASE_URL}/validator/api/merchantTransIDvalidationAPI.php`,
        {
          params: {
            tran_id: transactionId,
            store_id: STORE_ID,
            store_passwd: STORE_PASSWORD,
            format: "json",
          },
        },
      );

      return response.data;
    } catch (error: any) {
      console.error(
        "Transaction Query Error:",
        error.response?.data || error.message,
      );
      throw new Error("Failed to query transaction status");
    }
  }

  /**
   * Process refund
   */
  async processRefund(params: {
    transactionId: string;
    refundAmount: number;
    refundReason: string;
  }) {
    const { transactionId, refundAmount, refundReason } = params;

    const payment = await prisma.payment.findUnique({
      where: { transactionId },
    });

    if (!payment) throw new Error("Payment not found");
    if (payment.status !== PaymentStatus.PAID) {
      throw new Error("Only paid payments can be refunded");
    }

    const bankTranId = (payment.meta as any)?.bankTranId;
    if (!bankTranId) {
      throw new Error("Bank transaction ID not found");
    }

    try {
      const response = await axios.get(
        `${BASE_URL}/validator/api/merchantTransIDvalidationAPI.php`,
        {
          params: {
            bank_tran_id: bankTranId,
            refund_amount: refundAmount,
            refund_remarks: refundReason,
            store_id: STORE_ID,
            store_passwd: STORE_PASSWORD,
            format: "json",
          },
        },
      );

      if (response.data.status === "success") {
        // Update payment record
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.REFUNDED,
            meta: {
              ...payment.meta,
              refund: {
                refundRefId: response.data.refund_ref_id,
                refundAmount,
                refundReason,
                refundedAt: new Date(),
              },
            },
          },
        });

        return response.data;
      }

      throw new Error(response.data.errorReason || "Refund failed");
    } catch (error: any) {
      console.error("Refund Error:", error.response?.data || error.message);
      throw new Error("Failed to process refund");
    }
  }

  /**
   * Query refund status
   */
  async queryRefundStatus(refundRefId: string) {
    try {
      const response = await axios.get(
        `${BASE_URL}/validator/api/merchantTransIDvalidationAPI.php`,
        {
          params: {
            refund_ref_id: refundRefId,
            store_id: STORE_ID,
            store_passwd: STORE_PASSWORD,
            format: "json",
          },
        },
      );

      return response.data;
    } catch (error: any) {
      console.error(
        "Refund Query Error:",
        error.response?.data || error.message,
      );
      throw new Error("Failed to query refund status");
    }
  }

  private async validateSSLCommerzPayment(valId: string) {
    const payload = {
      val_id: valId,
      store_id: process.env.SSLCOMMERZ_STORE_ID,
      store_passwd: process.env.SSLCOMMERZ_STORE_PASSWORD,
      format: "json",
    };

    const response = await axios.get(
      `${process.env.SSLCOMMERZ_BASE_URL}/validator/api/validationserverAPI.php`,
      { params: payload },
    );

    return response.data as SSLCommerzValidationResponse;
  }
  async confirmDeliveryFeePayment(transactionId: string, valId: string) {
    // Validate payment with SSLCommerz
    const validation = await this.validateSSLCommerzPayment(valId);

    if (validation.status === "VALID") {
      const payment = await prisma.payment.update({
        where: { id: transactionId },
        data: {
          status: PaymentStatus.PAID,
          paidAt: new Date(),
          meta: validation,
        },
      });

      // Update order status to confirmed
      await prisma.order.update({
        where: { id: payment.orderId },
        data: { status: OrderStatus.CONFIRMED },
      });

      return payment;
    }

    throw new Error("Payment validation failed");
  }

  async processProductPayment(orderId: number) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          include: {
            variant: {
              include: {
                product: true,
              },
            },
          },
        },
        payments: true,
      },
    });

    if (!order) throw new Error("Order not found");

    // Calculate product amount (total minus delivery fee already paid)
    const deliveryFeePaid = order.payments
      .filter((p) => p.status === PaymentStatus.PAID)
      .reduce((sum, p) => sum + p.amount, 0);

    const productAmount = order.totalAmount - deliveryFeePaid;

    // Create payment record for product amount
    const payment = await prisma.payment.create({
      data: {
        orderId,
        method: "cash_on_delivery_product",
        amount: productAmount,
        status: PaymentStatus.PENDING,
        meta: { type: "product_payment" },
      },
    });

    return payment;
  }
 
}

// Export singleton instance
export const paymentService = new PaymentService();
