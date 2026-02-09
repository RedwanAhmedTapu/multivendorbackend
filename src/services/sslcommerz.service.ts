// services/sslcommerz.service.ts
import axios from "axios";
import { prisma } from "../config/prisma";

const STORE_ID = process.env.SSLCOMMERZ_STORE_ID!;
const STORE_PASSWORD = process.env.SSLCOMMERZ_STORE_PASSWORD!;
const IS_LIVE = process.env.NODE_ENV === "production";

const BASE_URL = IS_LIVE
  ? "https://securepay.sslcommerz.com"
  : "https://sandbox.sslcommerz.com";

// Gateway code mapping based on your data
const GATEWAY_MAP: Record<string, string> = {
  BKASH: "bkash",
  NAGAD: "nagad",
  UPAY: "upay",
  EBL_COF: "visacard,mastercard,amexcard", // For cards
  COD: "COD", // Cash on delivery (not SSLCommerz)
};

export class SSLCommerzService {
  static async initPayment(
    orderId: string,
    amount: number,
    user: any,
    gatewayCode: string
  ) {
    const tran_id = `TXN_${Date.now()}_${orderId}`;

    const paymentData = {
      store_id: STORE_ID,
      store_passwd: STORE_PASSWORD,
      total_amount: amount,
      currency: "BDT",
      tran_id,
      success_url: `${process.env.BACKEND_URL}/api/payment/success`,
      fail_url: `${process.env.BACKEND_URL}/api/payment/fail`,
      cancel_url: `${process.env.BACKEND_URL}/api/payment/cancel`,
      ipn_url: `${process.env.BACKEND_URL}/api/payment/ipn`,
      
      // Customer information
      cus_name: user.name,
      cus_email: user.email,
      cus_add1: user.address || "Dhaka",
      cus_city: user.city || "Dhaka",
      cus_state: user.state || "Dhaka",
      cus_postcode: user.postcode || "1000",
      cus_country: "Bangladesh",
      cus_phone: user.phone || "01700000000",
      
      // Product information
      product_name: "E-commerce Order",
      product_category: "general",
      product_profile: "general",
      
      // Shipping information
      shipping_method: "YES",
      ship_name: user.name,
      ship_add1: user.address || "Dhaka",
      ship_city: user.city || "Dhaka",
      ship_state: user.state || "Dhaka",
      ship_postcode: user.postcode || "1000",
      ship_country: "Bangladesh",
      
      // Gateway selection - this is key for direct gateway redirect
      multi_card_name: GATEWAY_MAP[gatewayCode] || "",
    };

    try {
      // Create payment record
      await prisma.payment.create({
        data: {
          orderId,
          transactionId: tran_id,
          amount,
          gatewayCode,
          status: "INITIATED",
        },
      });

      // Call SSLCommerz API
      const response = await axios.post(
        `${BASE_URL}/gwprocess/v4/api.php`,
        new URLSearchParams(paymentData as any).toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );

      if (response.data.status !== "SUCCESS") {
        throw new Error(
          response.data.failedreason || "Payment initiation failed"
        );
      }

      return {
        sessionKey: response.data.sessionkey,
        gatewayPageURL: response.data.GatewayPageURL,
        redirectGatewayURL: response.data.redirectGatewayURL,
        transactionId: tran_id,
      };
    } catch (error: any) {
      console.error("SSLCommerz Init Error:", error.response?.data || error.message);
      throw new Error("Failed to initiate payment");
    }
  }

  static async validatePayment(val_id: string) {
    try {
      const response = await axios.get(
        `${BASE_URL}/validator/api/validationserverAPI.php`,
        {
          params: {
            val_id,
            store_id: STORE_ID,
            store_passwd: STORE_PASSWORD,
            format: "json",
          },
        }
      );

      return response.data;
    } catch (error: any) {
      console.error("SSLCommerz Validation Error:", error.response?.data || error.message);
      throw new Error("Payment validation failed");
    }
  }

  static async queryByTransactionId(tran_id: string) {
    try {
      const response = await axios.get(
        `${BASE_URL}/validator/api/merchantTransIDvalidationAPI.php`,
        {
          params: {
            tran_id,
            store_id: STORE_ID,
            store_passwd: STORE_PASSWORD,
            format: "json",
          },
        }
      );

      return response.data;
    } catch (error: any) {
      console.error("SSLCommerz Query Error:", error.response?.data || error.message);
      throw new Error("Transaction query failed");
    }
  }
}