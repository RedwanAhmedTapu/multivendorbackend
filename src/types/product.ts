// =====================
// Core Product Types
// =====================

import { WarrantyUnit } from "@prisma/client";

// Image input for products and variants
export interface ProductImageInput {
  url: string;
  altText?: string | null;
  sortOrder?: number;
}

// Specifications at product level
export interface ProductSpecificationInput {
  specificationId: string; // FK -> Specification
  valueString?: string | null;
  valueNumber?: number | null;
}

// Attribute settings (global for product)
export interface ProductAttributeSettingInput {
  attributeId: string; // FK -> Attribute
  isVariant?: boolean; // determines if used for variant differentiation
}

// Variant-specific attribute assignment
export interface ProductVariantAttributeInput {
  attributeValueId: string; // FK -> AttributeValue
}

// Variant input
export interface ProductVariantInput {
  name: string;
  sku: string;
  price: number;
  specialPrice?: number ;
  stock: number;
  weight?: number;

  attributes?: ProductVariantAttributeInput[];
  images?: string[]; // only URLs passed in, altText/sortOrder auto-generated
}

// =====================
// Final CreateProductData payload
// =====================
export interface CreateProductData {
  name: string;
  description?: string | null;
  categoryId: string;
  vendorId: string;

  images?: ProductImageInput[];
  specifications?: ProductSpecificationInput[];
  variants?: ProductVariantInput[];
  attributeSettings?: ProductAttributeSettingInput[];

  // Warranty + Shipping Info
  warranty?: ProductShippingWarrantyInput;

  // ⚠️ Shipping belongs to Order in schema,
  // but keeping it optional in case you want to capture early
  shipping?: {
    address: string;
    city: string;
    postalCode: string;
    country: string;
    courier?: string | null;
  };

  // For Audit Logging
  userId?: string;
}

export interface ProductShippingWarrantyInput {
  // Package / shipping info
  packageWeightValue: number;              // numeric weight
  packageWeightUnit: "kg" | "g";           // weight unit
  packageLength: number;                   // in cm
  packageWidth: number;                    // in cm
  packageHeight: number;                   // in cm
  dangerousGoods: "none" | "contains";    // dangerous goods info

  // Warranty info
  warrantyType: "manufacturer" | "seller" | "none"; // type
  warrantyPeriodValue: number;             // numeric value
  warrantyPeriodUnit: "days" | "months" | "years"; // unit
  warrantyDetails: string;                 // warranty description
}
// =====================
// Filtering
// =====================

// Flexible filter type for querying products
export interface ProductFilter {
  categoryId?: string;
  vendorId?: string;
  inStock?: boolean;
  minPrice?: number;
  maxPrice?: number;

  attributes?: Record<string, string | string[]>; // attributeId -> value(s)
  specifications?: Record<string, string | number>; // specificationId -> value
}

// =====================
// Reference Types (for UI)
// =====================

// Used for UI to manage variant naming logic
export interface VariantNamePart {
  name: string;
  value: string;
  include: boolean;
}

// Attributes and Specifications for categories
export interface Attribute {
  id: string;
  name: string;
  values: { id: string; value: string }[];
}

export interface Specification {
  id: string;
  name: string;
  values: { id: string; value: string | number }[];
}
