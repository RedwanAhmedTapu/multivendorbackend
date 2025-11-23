// types/vendor.types.ts
import {
  VendorStatus,
  UserRole,
  DocumentType,
  DocumentVerificationStatus,
  SubscriptionPlan,
  VerificationStatus,
  AccountType,
} from "@prisma/client";

export interface CreateVendorRequest {
  storeName: string;
  email: string;
  phone?: string;
  password: string;
  avatar?: string;
  accountType?: AccountType;
  personalInfo?: VendorPersonalInfoRequest;
  address?: VendorAddressRequest;
}

export interface UpdateVendorProfileRequest {
  storeName?: string;
  avatar?: string;
  currentCommissionRate?: number;
  accountType?: AccountType;
  status?: VendorStatus;
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
  verificationStatus?: VerificationStatus;
  accountType?: AccountType;
  search?: string;
  commissionMin?: number;
  commissionMax?: number;
  createdFrom?: Date;
  createdTo?: Date;
  page?: number;
  limit?: number;
  sortBy?:
    | "createdAt"
    | "storeName"
    | "totalSales"
    | "totalOrders"
    | "verificationStatus";
  sortOrder?: "asc" | "desc";
}

export interface VendorWithDetails {
  id: string;
  storeName: string;
  avatar?: string;
  status: VendorStatus;
  accountType: AccountType;
  verificationStatus: VerificationStatus;
  verifiedAt?: Date;
  rejectedAt?: Date;
  rejectionReason?: string;
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
  personalInfo?: VendorPersonalInfo;
  bankInfo?: VendorBankInfo;
  idDocument?: VendorDocument;
  pickupAddress?: VendorAddress;
  settings?: VendorSettings;
  subscription?: VendorSubscription;
  onboarding?: VendorOnboardingStatus;
  performance?: VendorPerformance;
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
  format: "csv" | "xlsx";
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

// ================================
// PERSONAL INFO TYPES
// ================================

export interface VendorPersonalInfoRequest {
  // Individual-specific fields
  idNumber?: string;
  idName?: string;
  
  // Business-specific fields  
  companyName?: string;
  businessRegNo?: string;
  taxIdNumber?: string;
}

export interface VendorPersonalInfo {
  id: string;
  vendorId: string;
  // Individual-specific fields
  idNumber?: string;
  idName?: string;
  // Business-specific fields
  companyName?: string;
  businessRegNo?: string;
  taxIdNumber?: string;
  createdAt: Date;
  updatedAt: Date;
}


// ================================
// ADDRESS TYPES
// ================================

export interface VendorAddressRequest {
  detailsAddress: string;
  city: string;
  zone: string;
  area: string;
}

export interface VendorAddress {
  id: string;
  vendorId: string;
  detailsAddress: string;
  city: string;
  zone: string;
  area: string;
  createdAt: Date;
  updatedAt: Date;
}

// ================================
// BANK INFO TYPES
// ================================

export interface VendorBankInfoRequest {
  accountName: string;
  accountNumber: string;
  bankName: string;
  branchName: string;
}

export interface VendorBankInfo {
  id: string;
  vendorId: string;
  accountName: string;
  accountNumber: string;
  bankName: string;
  branchName: string;
  createdAt: Date;
  updatedAt: Date;
}

// ================================
// DOCUMENT TYPES
// ================================

export interface VendorDocumentRequest {
  type: DocumentType;
  title: string;
  filePath: string;
  fileSize?: number;
  mimeType?: string;
  verificationStatus?: DocumentVerificationStatus;
}

export interface VendorDocument {
  id: string;
  vendorId: string;
  type: DocumentType;
  title: string;
  filePath: string;
  fileSize?: number;
  mimeType?: string;
  verificationStatus: DocumentVerificationStatus;
  rejectionReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

// ================================
// SUBSCRIPTION TYPES
// ================================

export interface VendorSubscriptionRequest {
  planType: SubscriptionPlan;
  isActive: boolean;
}

export interface VendorSubscription {
  id: string;
  vendorId: string;
  planType: SubscriptionPlan;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ================================
// SETTINGS TYPES
// ================================

export interface VendorSettings {
  id: string;
  vendorId: string;
  emailNotifications: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ================================
// ONBOARDING TYPES
// ================================

export interface VendorOnboardingStatus {
  id: string;
  vendorId: string;
  personalInfoComplete: boolean;
  addressComplete: boolean;
  bankInfoComplete: boolean;
  documentsComplete: boolean; 
  overallComplete: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ================================
// PERFORMANCE TYPES
// ================================

export interface VendorPerformance {
  id: string;
  vendorId: string;
  totalSales: number;
  totalOrders: number;
  fulfillmentRatePct: number;
  avgRating: number;
  lastCalculatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ================================
// VERIFICATION TYPES
// ================================

export interface VendorVerificationRequest {
  rejectionReason?: string;
}

export interface VendorVerificationResponse {
  vendorId: string;
  verificationStatus: VerificationStatus;
  verifiedAt?: Date;
  rejectedAt?: Date;
  rejectionReason?: string;
}

// ================================
// COMPREHENSIVE VENDOR PROFILE
// ================================

export interface CompleteVendorProfile {
  id: string;
  storeName: string;
  avatar?: string;
  status: VendorStatus;
  accountType: AccountType; // CHANGED: from sellerType to accountType
  verificationStatus: VerificationStatus;
  verifiedAt?: Date;
  rejectedAt?: Date;
  rejectionReason?: string;
  currentCommissionRate?: number;
  createdAt: Date;
  updatedAt: Date;
  
  user: {
    id: string;
    email?: string;
    phone?: string;
    isActive: boolean;
    isVerified: boolean;
  };
  
  personalInfo?: VendorPersonalInfo;
  bankInfo?: VendorBankInfo;
  documents?: VendorDocument[]; // CHANGED: Now an array of documents
  pickupAddress?: VendorAddress;
  settings?: VendorSettings;
  subscription?: VendorSubscription;
  onboarding?: VendorOnboardingStatus;
  performance?: VendorPerformance;
  
  _count: {
    products: number;
    orders: number;
    flags: number;
  };
}

// ================================
// API RESPONSE TYPES
// ================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
  pagination?: {
    total: number;
    page: number;
    limit: number;
    pages: number;
  };
}

export interface PaginatedVendorResponse {
  data: VendorWithDetails[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    pages: number;
  };
}

// ================================
// VENDOR STATISTICS TYPES
// ================================

export interface VendorStats {
  totalVendors: number;
  activeVendors: number;
  pendingVerification: number;
  suspendedVendors: number;
  totalSales: number;
  averageCommissionRate: number;
}

export interface VendorGrowthMetrics {
  period: string;
  newVendors: number;
  activatedVendors: number;
  totalSales: number;
  averageRating: number;
}

// ================================
// VENDOR DASHBOARD TYPES
// ================================

export interface VendorDashboard {
  overview: {
    totalProducts: number;
    totalOrders: number;
    pendingOrders: number;
    totalEarnings: number;
    pendingPayouts: number;
    averageRating: number;
  };
  recentActivity: {
    orders: any[]; // Define more specific type based on your order model
    reviews: any[]; // Define more specific type based on your review model
    payouts: any[]; // Define more specific type based on your payout model
  };
  performance: VendorPerformanceMetrics;
}

// ================================
// VENDOR SEARCH TYPES
// ================================

export interface VendorSearchResult {
  id: string;
  storeName: string;
  avatar?: string;
  verificationStatus: VerificationStatus;
  avgRating: number;
  totalProducts: number;
  totalOrders: number;
}

export interface VendorSearchResponse {
  results: VendorSearchResult[];
  total: number;
  page: number;
  limit: number;
}

// ================================
// VENDOR NOTIFICATION TYPES
// ================================

export interface VendorNotificationPreferences {
  emailOrders: boolean;
  emailPayouts: boolean;
  emailReviews: boolean;
  emailPromotions: boolean;
  pushOrders: boolean;
  pushPayouts: boolean;
}

export interface VendorNotification {
  id: string;
  vendorId: string;
  title: string;
  message: string;
  type: "ORDER" | "PAYOUT" | "REVIEW" | "SYSTEM" | "PROMOTION";
  isRead: boolean;
  metadata?: any;
  createdAt: Date;
}
