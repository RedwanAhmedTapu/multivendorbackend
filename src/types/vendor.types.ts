// types/vendor.types.ts
import { VendorStatus, UserRole } from '@prisma/client';

export interface CreateVendorRequest {
  storeName: string;
  email: string;
  phone?: string;
  password: string;
  avatar?: string;
}

export interface UpdateVendorProfileRequest {
  storeName?: string;
  avatar?: string;
  currentCommissionRate?: number;
}

export interface VendorCommissionRequest {
  rate: number;
  note?: string;
  effectiveFrom?: Date;
  effectiveTo?: Date;
}

export interface VendorPayoutRequest {
  amount: number;
  method?: string;
  period?: string;
  note?: string;
}

export interface VendorMonthlyChargeRequest {
  amount: number;
  description?: string;
  effectiveFrom?: Date;
  effectiveTo?: Date;
}

export interface VendorOfferRequest {
  title: string;
  details?: string;
  validFrom: Date;
  validTo?: Date;
}

export interface VendorFlagRequest {
  reason: string;
  severity: number;
  meta?: any;
}

export interface VendorFilterQuery {
  status?: VendorStatus;
  search?: string;
  commissionMin?: number;
  commissionMax?: number;
  createdFrom?: Date;
  createdTo?: Date;
  page?: number;
  limit?: number;
  sortBy?: 'createdAt' | 'storeName' | 'totalSales' | 'totalOrders';
  sortOrder?: 'asc' | 'desc';
}

export interface VendorWithDetails {
  id: string;
  storeName: string;
  avatar?: string;
  status: VendorStatus;
  currentCommissionRate?: number;
  createdAt: Date;
  updatedAt: Date;
  user?: {
    id: string;
    email?: string;
    phone?: string;
    isActive: boolean;
    isVerified: boolean;
  };
  performance?: {
    totalSales: number;
    totalOrders: number;
    fulfillmentRatePct: number;
    avgRating: number;
  };
  _count: {
    products: number;
    orders: number;
    flags: number;
  };
}

export interface VendorPerformanceMetrics {
  vendorId: string;
  totalSales: number;
  totalOrders: number;
  fulfillmentRatePct: number;
  avgRating: number;
  monthlyGrowth: number;
  completedOrders: number;
  cancelledOrders: number;
  returnedOrders: number;
}

export interface PayoutSummary {
  vendorId: string;
  totalPending: number;
  totalPaid: number;
  totalFailed: number;
  lastPayoutDate?: Date;
  currentBalance: number;
}

export interface FraudDetectionResult {
  vendorId: string;
  riskScore: number;
  flags: {
    excessiveOrderDeclines: boolean;
    suspiciousPricing: boolean;
    unusualOrderPatterns: boolean;
    lowFulfillmentRate: boolean;
  };
  recommendations: string[];
}

export interface BulkCommissionUpdateRequest {
  vendorIds: string[];
  rate: number;
  note?: string;
  effectiveFrom?: Date;
}

export interface BulkMonthlyChargeRequest {
  vendorIds: string[];
  amount: number;
  description?: string;
  effectiveFrom?: Date;
}

export interface VendorExportOptions {
  format: 'csv' | 'xlsx';
  fields: string[];
  filters?: VendorFilterQuery;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  content: string;
  metadata?: any;
  createdAt: Date;
  sender: {
    name?: string;
    role: UserRole;
  };
}

export interface VendorConversationResponse {
  id: string;
  vendorId: string;
  userId: string;
  subject?: string;
  isOpen: boolean;
  createdAt: Date;
  updatedAt: Date;
  vendor: {
    storeName: string;
    avatar?: string;
  };
  user: {
    name?: string;
    email?: string;
  };
  messages: ChatMessage[];
  _count: {
    messages: number;
  };
}