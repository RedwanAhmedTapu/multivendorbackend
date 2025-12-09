// =====================
// Core Product Types
// =====================

import { AttributeType } from "@prisma/client";

// Image input for products and variants
export interface ProductImageInput {
  url: string;
  altText?: string | null;
  sortOrder?: number;
}

// =====================
// UNIFIED: ProductAttribute (replaces both specifications and settings)
// =====================

/**
 * Unified attribute/specification input at product level
 * isForVariant determines if it's a variant attribute or product specification
 */
export interface ProductAttributeInput {
  attributeId: string; // FK -> Attribute
  isForVariant?: boolean; // false = specification, true = variant attribute setting

  // For TEXT/NUMBER/BOOLEAN types (direct values for specifications)
  valueString?: string | null;
  valueNumber?: number | null;
  valueBoolean?: boolean | null;

  // For SELECT/MULTISELECT types (selected value for specifications)
  attributeValueId?: string | null; // FK -> AttributeValue
}



// =====================
// Variant Types
// =====================

// Variant-specific attribute value assignment
export interface ProductVariantAttributeInput {
  attributeValueId: string; // FK -> AttributeValue (actual selected value)
}

// Variant input
export interface ProductVariantInput {
  name?: string | null;
  sku: string;
  price: number;
  specialPrice?: number | null;
  discount?: number; // auto-calculated if not provided
  stock?: number;

  attributes?: ProductVariantAttributeInput[]; // variant attribute values
  images?: (string | ProductImageInput)[]; // URLs or full image objects
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

  // ✅ NEW: Unified attributes for both specifications and variant settings
  attributes?: ProductAttributeInput[];

  variants?: ProductVariantInput[];

  // Warranty + Shipping Info
  shippingWarranty?: ProductShippingWarrantyInput;

  // For Audit Logging
  userId?: string;
}

export interface ProductShippingWarrantyInput {
  // Package / shipping info
  packageWeightValue: number; // numeric weight
  packageWeightUnit: "kg" | "g"; // weight unit
  packageLength: number; // in cm
  packageWidth: number; // in cm
  packageHeight: number; // in cm
  dangerousGoods: "none" | "contains"; // dangerous goods info

  // Warranty info
  warrantyType: string; // e.g., "manufacturer", "seller", "none"
  warrantyPeriodValue: number; // numeric value
  warrantyPeriodUnit: "days" | "months" | "years"; // unit
  warrantyDetails?: string | null; // warranty description
}

// =====================
// Update Product Types
// =====================
export interface UpdateProductData {
  name?: string;
  description?: string | null;
  categoryId?: string;
  vendorId?: string;

  images?: ProductImageInput[];

  // Specifications/attributes update
  attributes?: ProductAttributeInput[];

  variants?: ProductVariantInput[];
  shippingWarranty?: ProductShippingWarrantyInput;

  // Approval status
  status?: "PENDING" | "ACTIVE" | "REJECTED";
  approvedById?: string;

  userId?: string; // for audit log
}

// =====================
// Filtering
// =====================

// Flexible filter type for querying products
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
  approvalStatus?: "PENDING" | "ACTIVE" | "REJECTED";
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

// Attribute with type information
export interface Attribute {
  id: string;
  name: string;
  slug: string;
  type: AttributeType; // TEXT, NUMBER, BOOLEAN, SELECT, MULTISELECT
  unit?: string | null; // e.g., "cm", "kg", "GHz"
  values?: AttributeValue[]; // for SELECT/MULTISELECT types
}

// Attribute value for SELECT/MULTISELECT types
export interface AttributeValue {
  id: string;
  value: string;
  attributeId: string;
}

// Category attribute (for product forms)
export interface CategoryAttribute {
  id: string;
  categoryId: string;
  attributeId: string;
  isRequired: boolean;
  filterable: boolean;
  sortOrder: number;
  attribute: Attribute;
}

// =====================
// Product Response Types
// =====================

// Full product with all relations
export interface Product {
  id: string;
  name: string;
  description?: string | null;
  slug: string;
  vendorId: string;
  categoryId: string;
  approvalStatus: "PENDING" | "ACTIVE" | "REJECTED";
  approvedById?: string | null;
  createdAt: Date;
  updatedAt: Date;

  // Relations
  vendor?: {
    id: string;
    storeName: string;
    avatar?: string | null;
    status: string;
    verificationStatus?: string;
  };

  category?: {
    id: string;
    name: string;
    slug: string;
    image?: string | null;
    parent?: {
      id: string;
      name: string;
      slug: string;
    };
  };

  images?: ProductImage[];
  variants?: ProductVariant[];
  attributes?: ProductAttributeWithRelations[]; 
  warranty?: Warranty | null;
  reviews?: Review[];
  approvedBy?: {
    id: string;
    name: string;
    email: string;
  };
}

// Product image
export interface ProductImage {
  id: string;
  url: string;
  altText?: string | null;
  sortOrder?: number | null;
  productId?: string | null;
  variantId?: string | null;
  createdAt: Date;
}

// Product variant with relations
export interface ProductVariant {
  id: string;
  productId: string;
  name?: string | null;
  sku: string;
  price: number;
  specialPrice?: number | null;
  discount?: number | null;
  stock: number;
  createdAt: Date;
  updatedAt: Date;

  images?: ProductImage[];
  attributes?: ProductVariantAttributeWithRelations[];
}

// Product attribute with relations (for specifications)
export interface ProductAttributeWithRelations {
  id: string;
  productId: string;
  attributeId: string;
  isForVariant: boolean;

  valueString?: string | null;
  valueNumber?: number | null;
  valueBoolean?: boolean | null;
  attributeValueId?: string | null;

  attribute: Attribute;
  attributeValue?: AttributeValue | null;
}

// Product variant attribute with relations
export interface ProductVariantAttributeWithRelations {
  id: string;
  variantId: string;
  attributeValueId: string;

  attributeValue: {
    id: string;
    value: string;
    attributeId: string;
    attribute: Attribute;
  };
}

// Warranty
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

  createdAt: Date;
  updatedAt: Date;
}

// Review
export interface Review {
  id: string;
  userId: string;
  productId: string;
  rating: number;
  comment?: string | null;
  createdAt: Date;
  updatedAt: Date;

  user?: {
    id: string;
    name: string;
  };
}

// =====================
// Statistics
// =====================
export interface ProductStatistics {
  total: number;
  pending: number;
  active: number;
  rejected: number;
}
