import axios from 'axios';
import { courierConfig } from '../config/courier.ts';
import type { CourierRequest } from '../types/index.ts';

interface PathaoToken {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export class CourierService {
  private pathaoToken: string | null = null;
  private tokenExpiry: Date | null = null;

  async createDelivery(request: CourierRequest) {
    switch (request.courierService) {
      case 'pathao':
        return this.createPathaoDelivery(request);
      case 'redx':
        return this.createRedxDelivery(request);
      case 'steadfast':
        return this.createSteadfastDelivery(request);
      default:
        throw new Error('Unsupported courier service');
    }
  }

  private async getPathaoToken(): Promise<string> {
    if (this.pathaoToken && this.tokenExpiry && new Date() < this.tokenExpiry) {
      return this.pathaoToken;
    }

    const response = await axios.post(`${courierConfig.pathao.baseUrl}/aladdin/api/v1/oauth/token`, {
      client_id: courierConfig.pathao.clientId,
      client_secret: courierConfig.pathao.clientSecret,
      username: courierConfig.pathao.username,
      password: courierConfig.pathao.password,
      grant_type: courierConfig.pathao.grantType
    });

    const tokenData = response.data as PathaoToken;
    this.pathaoToken = tokenData.access_token;
    this.tokenExpiry = new Date(Date.now() + (tokenData.expires_in - 60) * 1000); // Subtract 60 seconds for safety

    return this.pathaoToken;
  }

  private async createPathaoDelivery(request: CourierRequest) {
    const token = await this.getPathaoToken();

    const payload = {
      store_id: 1, // Your store ID from Pathao
      merchant_order_id: request.orderId.toString(),
      recipient_name: request.recipient.name,
      recipient_phone: request.recipient.phone,
      recipient_address: request.recipient.address,
      recipient_city: request.recipient.city,
      recipient_zone: request.recipient.area,
      delivery_type: 48, // Cash on Delivery
      item_type: 2, // Parcel
      special_instruction: 'Handle with care',
      item_quantity: request.packages.length,
      item_weight: request.packages[0].weight,
      amount_to_collect: 0, // Will be updated after delivery
      item_description: 'Products'
    };

    const response = await axios.post(
      `${courierConfig.pathao.baseUrl}/aladdin/api/v1/order`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        }
      }
    );

    return response.data;
  }

  private async createRedxDelivery(request: CourierRequest) {
    const payload = {
      merchant_order_id: request.orderId.toString(),
      recipient_name: request.recipient.name,
      recipient_phone: request.recipient.phone,
      recipient_address: request.recipient.address,
      recipient_city: request.recipient.city,
      recipient_area: request.recipient.area,
      package_code: 'PARCEL',
      product_price: 0, // Will be updated
      product_weight: request.packages[0].weight,
      delivery_type: 'cash_on_delivery',
      remarks: 'Handle with care'
    };

    const response = await axios.post(
      `${courierConfig.redx.baseUrl}/orders`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${courierConfig.redx.token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data;
  }

  private async createSteadfastDelivery(request: CourierRequest) {
    const payload = {
      invoice: request.orderId.toString(),
      recipient_name: request.recipient.name,
      recipient_phone: request.recipient.phone,
      recipient_address: request.recipient.address,
      recipient_city: request.recipient.city,
      recipient_area: request.recipient.area,
      package_weight: request.packages[0].weight,
      amount_to_collect: 0, // Will be updated
      package_code: 'Parcel',
      product_details: 'Products',
      delivery_type: 'cash_on_delivery'
    };

    const response = await axios.post(
      'https://steadfast.test/api/create_order',
      payload,
      {
        headers: {
          'Api-Key': courierConfig.steadfast.apiKey,
          'Secret-Key': courierConfig.steadfast.secretKey,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data;
  }

  async trackDelivery(courierService: string, trackingNumber: string) {
    // Implementation for tracking delivery
    // This would make API calls to the respective courier services
    return { status: 'in_transit', updates: [] };
  }
}