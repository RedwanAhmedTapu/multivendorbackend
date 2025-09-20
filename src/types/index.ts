export interface OrderItem {
  variantId: string;
  quantity: number;
  price: number;
}

export interface ShippingAddress {
  address: string;
  city: string;
  postalCode: string;
  country: string;
  phone: string;
}

export interface PaymentRequest {
  orderId: number;
  amount: number;
  method: string;
  transactionId?: string;
}

export interface CourierRequest {
  orderId: number;
  courierService: 'pathao' | 'redx' | 'steadfast';
  recipient: {
    name: string;
    phone: string;
    address: string;
    city: string;
    area?: string;
  };
  packages: Array<{
    weight: number;
    height: number;
    width: number;
    length: number;
  }>;
}

export interface PayoutRequest {
  vendorId: string;
  amount: number;
  period: string;
  method: string;
}

export interface SSLCommerzInitResponse {
  status: string;
  failedreason?: string;
  sessionkey?: string;
  gw?: {
    visa?: string;
    master?: string;
    amex?: string;
    othercards?: string;
    internetbanking?: string;
    mobilebanking?: string;
  };
  redirectGatewayURL?: string;
}

export interface SSLCommerzValidationResponse {
  status: string;
  tran_date: string;
  tran_id: string;
  val_id: string;
  amount: string;
  store_amount: string;
  currency: string;
  bank_tran_id: string;
  card_type: string;
  card_no: string;
  card_issuer: string;
  card_brand: string;
  card_issuer_country: string;
  card_issuer_country_code: string;
  currency_type: string;
  currency_amount: string;
  currency_rate: string;
  base_fair: string;
  value_a: string;
  value_b: string;
  value_c: string;
  value_d: string;
  risk_title: string;
  risk_level: string;
  APIConnect: string;
  validated_on: string;
  gw_version: string;
}