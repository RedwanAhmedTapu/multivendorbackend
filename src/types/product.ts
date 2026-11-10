import {
  Vendor,
  Category,
  OrderItem,
  Attribute,
  AttributeValue,
  AttributeType,
} from "./type";

// =====================
// Review & Offer Interfaces
// =====================
export interface Review {
  id: string;
  rating: number;
  comment?: string;
  userId: string;
  productId: string;
  createdAt: string;
  updatedAt: string;
  user?: {
    id: string;
    name: string;
  };
}

export interface OfferProduct {
  id: string;
  productId: string;
  offerId: string;
  offer: {
    id: string;
    type: string;
    title: string;
    minOrderAmount: number | null;
  };
  createdAt: string;
  updatedAt: string;
}

// =====================
// UNIFIED ProductAttribute (replaces both specifications and settings)
// =====================

/**
 * ProductAttribute - Unified model for both product specifications and variant attribute settings
 * isForVariant: false = product specification
 * isForVariant: true = variant attribute setting (defines which attributes are used for variants)
 */
export interface ProductAttribute {
  id: string;
  productId: string;
  product?: Product;
  attributeId: string;
  attribute: Attribute;
  isForVariant: boolean;

  // For TEXT/NUMBER/BOOLEAN types (direct values for specifications)
  valueString?: string | null;
  valueNumber?: number | null;
  valueBoolean?: boolean | null;

  // For SELECT/MULTISELECT types (selected value for specifications)
  attributeValueId?: string | null;
  attributeValue?: AttributeValue | null;
}

// =====================
// Product Interfaces
// =====================

export interface Product {
  id: string;
  name: string;
  nameBn?: string;
  description?: string | null;
  slug: string;
  vendorId: string;
  categoryId: string;
  approvalStatus: "PENDING" | "ACTIVE" | "REJECTED" | "DRAFT" | "INACTIVE";
  approvedById?: string | null;

  // Relations
  vendor: Vendor;
  category: Category;
  variants: ProductVariant[];
  attributes: ProductAttribute[]; // Unified: contains both specifications (isForVariant: false)
  videoUrl?: string;
  images: ProductImage[];
  warranty?: Warranty | null;
  reviews?: Review[];
  offerProducts?: OfferProduct[];
  approvedBy?: {
    id: string;
    name: string;
    email: string;
  };

  createdAt: string;
  updatedAt: string;
}

// =====================
// Warranty
// =====================
export interface Warranty {
  id: string;
  productId: string;
  packageWeightValue: number;
  packageWeightUnit: "KG" | "G";
  packageLength: number;
  packageWidth: number;
  packageHeight: number;
  dangerousGoods: "NONE" | "CONTAINS";
  duration: number;
  unit: "DAYS" | "MONTHS" | "YEARS";
  policy?: string | null;
  type: string;
  createdAt: string;
  updatedAt: string;
}

// =====================
// ProductVariant
// =====================
export interface ProductVariant {
  id: string;
  productId: string;
  product?: Product;
  name?: string | null;
  sku: string;
  barcode?: string | null;
  price: number;
  availability: boolean;
  priceManuallyOverridden?: boolean;
  specialPrice?: number | null;
  discount?: number | null;
  stock: number;
  weight?: number | null;
  images: ProductImage[];
  attributes: ProductVariantAttribute[];
  orderItems?: OrderItem[];
  createdAt: string;
  updatedAt: string;
}

// =====================
// ProductImage
// =====================
export interface ProductImage {
  id: string;
  productId?: string | null;
  product?: Product;
  variantId?: string | null;
  variant?: ProductVariant;
  url: string;
  altText?: string | null;
  sortOrder?: number | null;
  createdAt: string;
}

// =====================
// ProductVariantAttribute
// =====================
export interface ProductVariantAttribute {
  id: string;
  variantId: string;
  variant?: ProductVariant;
  attributeValueId: string;
  attributeValue: AttributeValue & {
    attribute: Attribute;
  };
}

// =====================
// Input Types for Frontend Forms
// =====================

export interface ProductImageInput {
  url: string;
  altText?: string | null;
  sortOrder?: number;
}

/**
 * Unified attribute input for product creation
 * Used for both specifications and variant attribute settings
 */
export interface ProductAttributeInput {
  attributeId: string;
  isForVariant?: boolean; // false = specification, true = variant attribute setting

  // For specifications (TEXT/NUMBER/BOOLEAN types)
  valueString?: string | null;
  valueNumber?: number | null;
  valueBoolean?: boolean | null;

  // For specifications (SELECT/MULTISELECT types)
  attributeValueId?: string | null;
}
export interface WarehouseStockItem {
  id: string;
  variantId: string;
  warehouseId: string;
  rackId?: string | null;
  quantity: number;
  reservedQty: number;
  damagedQty: number;
  warehouse?: { id: string; name?: string | null; code?: string | null };
  rack?: { id: string; code: string; label?: string | null } | null;
}
export interface ProductVariantInput {
  id?: string;
  name?: string | null;
  sku: string;
  /** Optional — if left empty, the server auto-generates an EAN-13 barcode so POS scanning still works. */
  barcode?: string | null;
  availability?: boolean;
  attributes?: { attributeValueId: string; value?: string }[];
  images?: (string | ProductImageInput)[]; 
  warehouseStock?: WarehouseStockItem[];
}

export interface ProductShippingWarrantyInput {
  packageWeightValue: number;
  packageWeightUnit: "kg" | "g";
  packageLength: number;
  packageWidth: number;
  packageHeight: number;
  dangerousGoods: "none" | "contains";
  warrantyType: string;
  warrantyPeriodValue: number;
  warrantyPeriodUnit: "days" | "months" | "years";
  warrantyDetails?: string | null;
}

// =====================
// Create Product Data
// =====================
export interface CreateProductData {
  name: string;
  nameBn?: string;
  description?: string | null;
  categoryId: string;
  vendorId: string;
  videoUrl?: string;
  images?: ProductImageInput[];

  // Unified attributes (replaces both specifications and attributeSettings)
  attributes?: ProductAttributeInput[];

  variants?: ProductVariantInput[];
  shippingWarranty?: ProductShippingWarrantyInput;

  taxRate?: number;


  // For audit logging
  userId?: string;
}

// =====================
// Update Product Data
// =====================
export interface UpdateProductData {
  name?: string;
  description?: string | null;
  vendorId?: string;
  categoryId?: string;
  videoUrl?: string;
  images?: ProductImageInput[];

  // ✅ Unified attributes for updates
  attributes?: ProductAttributeInput[];

  variants?: ProductVariantInput[];
  shippingWarranty?: ProductShippingWarrantyInput;

  // Approval status
  approvalStatus?: "PENDING" | "ACTIVE" | "REJECTED" | "DRAFT" | "INACTIVE";
  approvedById?: string;

  // For audit logging
  userId?: string;
}

// =====================
// Bulk Product Data
// =====================
export interface BulkProductData {
  id: string;
  name: string;
  description: string;
  sku: string;
  price: number;
  stock: number;
  approvalStatus?: "PENDING" | "ACTIVE" | "REJECTED" | "DRAFT" | "INACTIVE";
  variantGroupNo?: number;
  videoUrl?: string;
  images: string[];

  attributes: ProductAttributeInput[];
  variantInputs: ProductVariantInput[];
  shippingWarranty?: ProductShippingWarrantyInput;

  errors: Record<string, string>;
  status: "draft" | "processing" | "success" | "error";
}

// =====================
// Filter Types
// =====================
export interface ProductFilter {
  categoryId?: string;
  categoryIds?: string[]; // multiple categories
  vendorId?: string;
  vendors?: string[]; // multiple vendors
  inStock?: boolean;
  minPrice?: number;
  maxPrice?: number;
  onSale?: boolean;
  newArrivals?: boolean;
  search?: string;

  ratings?: number[]; // filter by minimum ratings
  brands?: string[]; // filter by brand values

  // Variant attributes (for filtering variants)
  attributes?: Record<string, string | string[]>; // attributeId -> attributeValueId(s)

  // Product specifications (for filtering products)
  specifications?: Record<string, string | string[] | number>; // attributeId -> value(s)

  // Approval status
  approvalStatus?: "PENDING" | "ACTIVE" | "REJECTED" | "DRAFT" | "INACTIVE";
}

// =====================
// Product List Item (for efficient queries)
// =====================
export interface ProductListItem {
  id: string;
  name: string;
  slug: string;
  approvalStatus: "PENDING" | "ACTIVE" | "REJECTED" | "DRAFT" | "INACTIVE";
  vendor: {
    id: string;
    storeName: string;
    avatar?: string | null;
  };
  category: {
    id: string;
    name: string;
    slug: string;
  };
  videoUrl?: string;
  images: ProductImage[];
  variants: {
    id: string;
    name?: string | null;
    sku: string;
    price: number;
    specialPrice?: number | null;
    discount?: number | null;
    stock: number;
    images: ProductImage[];
  }[];
  reviews?: {
    id: string;
    rating: number;
  }[];
  offerProducts?: OfferProduct[];
  createdAt: string;
}

// =====================
// Product Detail (for single product view)
// =====================
export interface ProductDetail extends Product {
  variants: (ProductVariant & {
    attributes: (ProductVariantAttribute & {
      attributeValue: AttributeValue & {
        attribute: Attribute;
      };
    })[];
  })[];

  // ✅ Specifications are now part of the unified attributes array
  // Filter by isForVariant: false to get specifications
  attributes: (ProductAttribute & {
    attribute: Attribute & {
      values?: AttributeValue[];
    };
    attributeValue?: AttributeValue | null;
  })[];

  warranty?: Warranty | null;
}

// =====================
// Generic API Response
// =====================
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
  errors?: string[];
  count?: number;
}

// =====================
// Pagination
// =====================
export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

// =====================
// Product Search
// =====================
export interface ProductSearchParams {
  query?: string;
  categoryId?: string;
  minPrice?: number;
  maxPrice?: number;
  inStock?: boolean;
  sortBy?: "name" | "price" | "createdAt" | "stock";
  sortOrder?: "asc" | "desc";
  page?: number;
  limit?: number;
}

// =====================
// Product Statistics
// =====================
export interface ProductStatistics {
  total: number;
  pending: number;
  active: number;
  rejected: number;
}

// =====================
// Product Analytics
// =====================
export interface ProductAnalytics {
  totalProducts: number;
  totalVariants: number;
  averagePrice: number;
  lowStockProducts: number;
  outOfStockProducts: number;
  topCategories: {
    categoryId: string;
    categoryName: string;
    productCount: number;
  }[];
  topVendors: {
    vendorId: string;
    vendorName: string;
    productCount: number;
  }[];
}

// =====================
// Helper Types
// =====================

/**
 * Helper to extract specifications from ProductAttribute array
 */
export type ProductSpecification = ProductAttribute & { isForVariant: false };

/**
 * Helper to extract variant attribute settings from ProductAttribute array
 */
export type ProductVariantAttributeSetting = ProductAttribute & {
  isForVariant: true;
};

/**
 * Used for UI to manage variant naming logic
 */
export interface VariantNamePart {
  name: string;
  value: string;
  include: boolean;
}