import axios from "axios";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Get the active provider
export const getActiveProvider = async () => {
  return prisma.shippingProvider.findFirst({ where: { isActive: true } });
};

// Get delivery rates
export const getDeliveryRates = async (packageData: { 
  weight: number; 
  deliveryAreaId?: number; 
  pickupAreaId?: number;
  cashCollectionAmount?: number;
  destination?: string;
  itemType?: number;
  deliveryType?: number;
  storeId?: number;
  recipientCity?: number;
  recipientZone?: number;
}) => {
  const provider = await getActiveProvider();
  if (!provider) throw new Error("No active shipping provider configured");

  const { name, baseUrl, config } = provider;

  switch (name.toLowerCase()) {
    case "redx":
      return fetchRedxRates(baseUrl, config, packageData);
    case "pathao":
      return fetchPathaoRates(baseUrl, config, packageData);
    case "steadfast":
      return fetchSteadfastRates(baseUrl, config, packageData);
    default:
      throw new Error(`Unsupported provider: ${name}`);
  }
};

// -------- Provider Specific Handlers --------

async function fetchRedxRates(baseUrl: string, config: any, pkg: any) {
  const params = new URLSearchParams({
    delivery_area_id: pkg.deliveryAreaId?.toString() || '',
    pickup_area_id: pkg.pickupAreaId?.toString() || '',
    cash_collection_amount: (pkg.cashCollectionAmount || 0).toString(),
    weight: pkg.weight.toString()
  });

  const res = await axios.get(
    `${baseUrl}/charge/charge_calculator?${params}`,
    { 
      headers: { 
        'API-ACCESS-TOKEN': `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json'
      } 
    }
  );

  return {
    deliveryCharge: res.data.deliveryCharge,
    codCharge: res.data.codCharge,
    totalCharge: res.data.deliveryCharge + res.data.codCharge
  };
}

async function fetchPathaoRates(baseUrl: string, config: any, pkg: any) {
  // First, get access token
  const tokenRes = await axios.post(`${baseUrl}/aladdin/api/v1/issue-token`, {
    client_id: config.clientId,
    client_secret: config.clientSecret,
    username: config.username,
    password: config.password,
    grant_type: "password"
  });

  const token = tokenRes.data.access_token;

  // Calculate price
  const res = await axios.post(
    `${baseUrl}/aladdin/api/v1/merchant/price-plan`,
    {
      store_id: pkg.storeId || config.defaultStoreId,
      item_type: pkg.itemType || 2, // 2 for Parcel
      delivery_type: pkg.deliveryType || 48, // 48 for Normal Delivery
      item_weight: pkg.weight,
      recipient_city: pkg.recipientCity,
      recipient_zone: pkg.recipientZone
    },
    { 
      headers: { 
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json' 
      } 
    }
  );

  return {
    price: res.data.data.price,
    discount: res.data.data.discount,
    promo_discount: res.data.data.promo_discount,
    cod_percentage: res.data.data.cod_percentage,
    additional_charge: res.data.data.additional_charge,
    final_price: res.data.data.final_price,
    totalCharge: res.data.data.final_price
  };
}

async function fetchSteadfastRates(baseUrl: string, config: any, pkg: any) {
  // Steadfast doesn't have a dedicated pricing API in the provided docs
  // This would need to be implemented based on their actual pricing structure
  // For now, returning a mock response based on weight and destination
  const baseRate = 60; // Base rate in BDT
  const weightRate = pkg.weight * 10; // 10 BDT per kg
  const areaSurcharge = pkg.destination ? 20 : 0; // Surcharge for specific areas
  
  const totalCharge = baseRate + weightRate + areaSurcharge;
  
  return {
    deliveryCharge: totalCharge,
    codCharge: pkg.cashCollectionAmount ? pkg.cashCollectionAmount * 0.01 : 0, // 1% COD charge
    totalCharge: totalCharge + (pkg.cashCollectionAmount ? pkg.cashCollectionAmount * 0.01 : 0)
  };
}

// -------- Additional Courier Operations --------

// Create Parcel/Order
export const createShipment = async (shipmentData: any) => {
  const provider = await getActiveProvider();
  if (!provider) throw new Error("No active shipping provider configured");

  const { name, baseUrl, config } = provider;

  switch (name.toLowerCase()) {
    case "redx":
      return createRedxParcel(baseUrl, config, shipmentData);
    case "pathao":
      return createPathaoOrder(baseUrl, config, shipmentData);
    case "steadfast":
      return createSteadfastOrder(baseUrl, config, shipmentData);
    default:
      throw new Error(`Unsupported provider: ${name}`);
  }
};

async function createRedxParcel(baseUrl: string, config: any, data: any) {
  const res = await axios.post(
    `${baseUrl}/parcel`,
    {
      customer_name: data.customerName,
      customer_phone: data.customerPhone,
      delivery_area: data.deliveryArea,
      delivery_area_id: data.deliveryAreaId,
      customer_address: data.customerAddress,
      merchant_invoice_id: data.merchantInvoiceId,
      cash_collection_amount: data.cashCollectionAmount,
      parcel_weight: data.parcelWeight,
      instruction: data.instruction,
      value: data.value,
      pickup_store_id: data.pickupStoreId
    },
    { 
      headers: { 
        'API-ACCESS-TOKEN': `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json'
      } 
    }
  );

  return { trackingId: res.data.tracking_id };
}

async function createPathaoOrder(baseUrl: string, config: any, data: any) {
  const tokenRes = await axios.post(`${baseUrl}/aladdin/api/v1/issue-token`, {
    client_id: config.clientId,
    client_secret: config.clientSecret,
    username: config.username,
    password: config.password,
    grant_type: "password"
  });

  const token = tokenRes.data.access_token;

  const res = await axios.post(
    `${baseUrl}/aladdin/api/v1/orders`,
    {
      store_id: data.storeId,
      merchant_order_id: data.merchantOrderId,
      recipient_name: data.recipientName,
      recipient_phone: data.recipientPhone,
      recipient_address: data.recipientAddress,
      delivery_type: data.deliveryType || 48,
      item_type: data.itemType || 2,
      special_instruction: data.specialInstruction,
      item_quantity: data.itemQuantity || 1,
      item_weight: data.itemWeight,
      amount_to_collect: data.amountToCollect,
      item_description: data.itemDescription
    },
    { 
      headers: { 
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json' 
      } 
    }
  );

  return {
    consignmentId: res.data.data.consignment_id,
    merchantOrderId: res.data.data.merchant_order_id,
    deliveryFee: res.data.data.delivery_fee
  };
}

async function createSteadfastOrder(baseUrl: string, config: any, data: any) {
  const res = await axios.post(
    `${baseUrl}/create_order`,
    {
      invoice: data.invoice,
      recipient_name: data.recipientName,
      recipient_phone: data.recipientPhone,
      alternative_phone: data.alternativePhone,
      recipient_email: data.recipientEmail,
      recipient_address: data.recipientAddress,
      cod_amount: data.codAmount,
      note: data.note,
      item_description: data.itemDescription,
      total_lot: data.totalLot,
      delivery_type: data.deliveryType || 0 // 0 for home delivery
    },
    { 
      headers: { 
        'Api-Key': config.apiKey,
        'Secret-Key': config.secretKey,
        'Content-Type': 'application/json'
      } 
    }
  );

  return {
    consignmentId: res.data.consignment.consignment_id,
    trackingCode: res.data.consignment.tracking_code,
    status: res.data.consignment.status
  };
}

// Track Shipment
export const trackShipment = async (trackingData: { 
  trackingId?: string; 
  invoice?: string; 
  trackingCode?: string;
  consignmentId?: string;
}) => {
  const provider = await getActiveProvider();
  if (!provider) throw new Error("No active shipping provider configured");

  const { name, baseUrl, config } = provider;

  switch (name.toLowerCase()) {
    case "redx":
      return trackRedxParcel(baseUrl, config, trackingData);
    case "pathao":
      return trackPathaoOrder(baseUrl, config, trackingData);
    case "steadfast":
      return trackSteadfastOrder(baseUrl, config, trackingData);
    default:
      throw new Error(`Unsupported provider: ${name}`);
  }
};

async function trackRedxParcel(baseUrl: string, config: any, data: any) {
  const res = await axios.get(
    `${baseUrl}/parcel/track/${data.trackingId}`,
    { 
      headers: { 
        'API-ACCESS-TOKEN': `Bearer ${config.apiToken}`
      } 
    }
  );

  return { tracking: res.data.tracking };
}

async function trackPathaoOrder(baseUrl: string, config: any, data: any) {
  const tokenRes = await axios.post(`${baseUrl}/aladdin/api/v1/issue-token`, {
    client_id: config.clientId,
    client_secret: config.clientSecret,
    username: config.username,
    password: config.password,
    grant_type: "password"
  });

  const token = tokenRes.data.access_token;

  const res = await axios.get(
    `${baseUrl}/aladdin/api/v1/orders/${data.consignmentId}/info`,
    { 
      headers: { 
        Authorization: `Bearer ${token}` 
      } 
    }
  );

  return { orderInfo: res.data.data };
}

async function trackSteadfastOrder(baseUrl: string, config: any, data: any) {
  let endpoint = '';
  
  if (data.consignmentId) {
    endpoint = `/status_by_cid/${data.consignmentId}`;
  } else if (data.invoice) {
    endpoint = `/status_by_invoice/${data.invoice}`;
  } else if (data.trackingCode) {
    endpoint = `/status_by_trackingcode/${data.trackingCode}`;
  } else {
    throw new Error('No valid tracking identifier provided');
  }

  const res = await axios.get(
    `${baseUrl}${endpoint}`,
    { 
      headers: { 
        'Api-Key': config.apiKey,
        'Secret-Key': config.secretKey
      } 
    }
  );

  return { status: res.data.delivery_status };
}

// Get Areas/Cities/Zones
export const getServiceAreas = async (filters?: { 
  postCode?: number; 
  districtName?: string;
  cityId?: number;
  zoneId?: number;
}) => {
  const provider = await getActiveProvider();
  if (!provider) throw new Error("No active shipping provider configured");

  const { name, baseUrl, config } = provider;

  switch (name.toLowerCase()) {
    case "redx":
      return getRedxAreas(baseUrl, config, filters);
    case "pathao":
      return getPathaoAreas(baseUrl, config, filters);
    case "steadfast":
      // Steadfast doesn't have areas API in provided docs
      return { areas: [] };
    default:
      throw new Error(`Unsupported provider: ${name}`);
  }
};

async function getRedxAreas(baseUrl: string, config: any, filters?: any) {
  let url = `${baseUrl}/areas`;
  
  if (filters?.postCode) {
    url += `?post_code=${filters.postCode}`;
  } else if (filters?.districtName) {
    url += `?district_name=${filters.districtName}`;
  }

  const res = await axios.get(url, {
    headers: { 
      'API-ACCESS-TOKEN': `Bearer ${config.apiToken}` 
    }
  });

  return { areas: res.data.areas };
}

async function getPathaoAreas(baseUrl: string, config: any, filters?: any) {
  const tokenRes = await axios.post(`${baseUrl}/aladdin/api/v1/issue-token`, {
    client_id: config.clientId,
    client_secret: config.clientSecret,
    username: config.username,
    password: config.password,
    grant_type: "password"
  });

  const token = tokenRes.data.access_token;

  if (filters?.zoneId) {
    const res = await axios.get(
      `${baseUrl}/aladdin/api/v1/zones/${filters.zoneId}/area-list`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return { areas: res.data.data.data };
  } else if (filters?.cityId) {
    const res = await axios.get(
      `${baseUrl}/aladdin/api/v1/cities/${filters.cityId}/zone-list`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return { zones: res.data.data.data };
  } else {
    const res = await axios.get(
      `${baseUrl}/aladdin/api/v1/city-list`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return { cities: res.data.data.data };
  }
}