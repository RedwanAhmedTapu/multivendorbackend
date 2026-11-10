// types/brand.ts

export type BrandRelationship =
  | "BRAND_OWNER"
  | "EXCLUSIVE_DISTRIBUTOR"
  | "NON_EXCLUSIVE_DISTRIBUTOR"
  | "RESELLER";

export type BrandStatus = "PENDING" | "APPROVED" | "REJECTED";

export type LinkType =
  | "OFFICIAL_WEBSITE"
  | "FACEBOOK"
  | "INSTAGRAM"
  | "X"
  | "YOUTUBE"
  | "LINKEDIN"
  | "TIKTOK"
  | "DARAZ_STORE"
  | "AMAZON_STORE"
  | "EBAY_STORE"
  | "SHOPIFY_STORE"
  | "OTHER";

export interface BrandLinkInput {
  type: LinkType;
  title?: string | null;
  url: string;
}

export interface CreateBrandData {
  name: string;
  relationship: BrandRelationship;
  authorizationStart: string | Date;
  authorizationEnd?: string | Date | null;
  hasEndDate?: boolean;
  authenticationDoc?: string | null;
  categoryIds?: string[];
  links?: BrandLinkInput[];
}

export interface UpdateBrandData {
  name?: string;
  relationship?: BrandRelationship;
  authorizationStart?: string | Date;
  authorizationEnd?: string | Date | null;
  hasEndDate?: boolean;
  authenticationDoc?: string | null;
  categoryIds?: string[];
  links?: BrandLinkInput[];
}

export interface GetMyBrandsOptions {
  status?: BrandStatus;
  search?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  page?: number;
  limit?: number;
}