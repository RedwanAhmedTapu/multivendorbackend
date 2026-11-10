// types/vendor.types.ts
import {
  VendorStatus,
  UserRole,
  DocumentType,
  DocumentVerificationStatus,
  SubscriptionPlan,
  VerificationStatus,
  AccountType,
  BusinessType,
  PaymentInstrumentType,
  MobileBankingProvider,
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
  businessType?: BusinessType;
  status?: VendorStatus;
}

export interface VendorCommissionRequest {
  categoryId?: string;
  rate: number;
  // NOTE: VendorCommission model does not currently have `note` or
  // `effectiveFrom` columns. Either add them via migration, or remove
  // these two fields (and the matching code in vendor.service.ts)
  // if you don't need per-commission notes/effective dates.
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
  paymentAccounts?: VendorPaymentAccount[]; // renamed from bankAccounts
  documents?: VendorDocument[]; // was singular `idDocument`; kept as array to match actual usage
  pickupAddress?: VendorAddress;
  settings?: VendorSettings;
  subscription?: VendorSubscription;
  onboarding?: VendorOnboardingStatus;
  performance?: VendorPerformance;
  _count: {
    products: number;
    orders: number;
    flags: number;
    employees?: number;
    documents?: number;
    followers?: number;
    commissions?: number;
    payouts?: number;
    adCampaigns?: number;
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
  categoryId?: string;
  rate: number;
  // See note on VendorCommissionRequest — these fields need a matching
  // schema migration on VendorCommission before they can be persisted.
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
// PAYMENT ACCOUNT TYPES
// (vendor.paymentAccounts -> VendorPaymentAccount, polymorphic:
// BANK / MOBILE_BANKING / CARD / CASH)
// ================================

export interface VendorBankAccountBank {
  id: string;
  name: string;
  code?: string | null;
  swiftCode?: string | null;
}

export interface VendorPaymentAccountBranch {
  id: string;
  bankId: string;
  branchName: string;
  routingNumber?: string | null;
  isActive: boolean;
  bank: VendorBankAccountBank;
}

export interface VendorBankAccountCOA {
  id: string;
  code: string;
  name: string;
}

export interface AddVendorPaymentAccountRequest {
  type: PaymentInstrumentType;

  // BANK
  bankBranchId?: string;
  accountName?: string;
  accountNumber?: string;

  // MOBILE_BANKING
  mobileProvider?: MobileBankingProvider;
  walletNumber?: string;
  walletKind?: string;

  // CARD
  cardProcessor?: string;
  merchantId?: string;

  // shared
  label?: string;
  isDefault?: boolean;
}

export interface VendorPaymentAccount {
  id: string;
  vendorId: string;
  type: PaymentInstrumentType;

  // BANK fields
  bankBranchId?: string;
  accountName?: string;
  accountNumber?: string;

  // MOBILE_BANKING fields
  mobileProvider?: MobileBankingProvider;
  walletNumber?: string;
  walletKind?: string;

  // CARD fields
  cardProcessor?: string;
  merchantId?: string;

  // shared
  label?: string;
  isDefault: boolean;
  isActive: boolean;
  chartOfAccountId?: string;
  bankBranch?: VendorPaymentAccountBranch;
  chartOfAccount?: VendorBankAccountCOA;
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
  // NOTE: `rejectionReason` is not currently a column on VendorDocument
  // in the Prisma schema. Add it via migration, or remove this field
  // and the corresponding write in vendor.service.ts#updateDocumentStatus.
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
  accountType: AccountType;
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
  paymentAccounts?: VendorPaymentAccount[]; // renamed from bankAccounts
  documents?: VendorDocument[];
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