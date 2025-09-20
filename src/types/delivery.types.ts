// types/delivery.types.ts

// ================================
// BASIC ENUMS AND CONSTANTS
// ================================

export enum DeliveryPersonStatus {
  PENDING = 'PENDING',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  INACTIVE = 'INACTIVE'
}

export enum VehicleType {
  BICYCLE = 'BICYCLE',
  MOTORCYCLE = 'MOTORCYCLE',
  CAR = 'CAR',
  VAN = 'VAN',
  TRUCK = 'TRUCK'
}

export enum PayoutStatus {
  PENDING = 'PENDING',
  PAID = 'PAID',
  FAILED = 'FAILED'
}

export enum PayoutType {
  SALARY = 'SALARY',
  COMMISSION = 'COMMISSION',
  BONUS = 'BONUS',
  INCENTIVE = 'INCENTIVE'
}

export enum CollectionStatus {
  PENDING = 'PENDING',
  SETTLED = 'SETTLED',
  DISPUTED = 'DISPUTED'
}

export enum ComplaintStatus {
  OPEN = 'OPEN',
  INVESTIGATING = 'INVESTIGATING',
  RESOLVED = 'RESOLVED',
  CLOSED = 'CLOSED'
}

export enum ComplaintType {
  LATE_DELIVERY = 'LATE_DELIVERY',
  RUDE_BEHAVIOR = 'RUDE_BEHAVIOR',
  DAMAGED_GOODS = 'DAMAGED_GOODS',
  WRONG_DELIVERY = 'WRONG_DELIVERY',
  UNPROFESSIONAL = 'UNPROFESSIONAL',
  FRAUD = 'FRAUD',
  OTHER = 'OTHER'
}

export enum OfferType {
  PERCENTAGE = 'PERCENTAGE',
  FIXED_AMOUNT = 'FIXED_AMOUNT',
  FREE_DELIVERY = 'FREE_DELIVERY',
  BONUS_POINTS = 'BONUS_POINTS'
}

// ================================
// REQUEST INTERFACES
// ================================

export interface CreateDeliveryPersonRequest {
  name: string;
  phone: string;
  email?: string;
  address: string;
  nationalId: string;
  licenseNumber?: string;
  vehicleType: VehicleType;
  vehicleNumber?: string;
  emergencyContact: string;
  assignedZones?: string[];
  
  // User account creation
  createUser?: boolean;
  password?: string;
}

export interface UpdateDeliveryPersonRequest {
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
  emergencyContact?: string;
  vehicleType?: VehicleType;
  vehicleNumber?: string;
  licenseNumber?: string;
  assignedZones?: string[];
}

export interface DeliveryPayoutRequest {
  amount: number;
  payoutType: PayoutType;
  period?: string; // e.g., "2024-01", "weekly"
  method: string; // e.g., "BANK_TRANSFER", "CASH", "MOBILE_MONEY"
  notes?: string;
}

export interface FundCollectionRequest {
  deliveryPersonId: string;
  orderId: number;
  amountCollected: number;
  collectionMethod: string; // e.g., "CASH", "CARD", "MOBILE_PAYMENT"
  notes?: string;
}

export interface DeliveryComplaintRequest {
  deliveryPersonId: string;
  customerId: string;
  orderId?: number;
  complaintType: ComplaintType;
  description: string;
  severity: number; // 1-5 scale
}

export interface DeliveryPromotionalOfferRequest {
  title: string;
  description: string;
  offerType: OfferType;
  value: number;
  conditions?: Record<string, any>;
  validFrom: string | Date;
  validTo?: string | Date;
  maxClaims?: number;
  targetCriteria?: Record<string, any>; // e.g., minimum deliveries, rating threshold
}

export interface DeliveryRatingRequest {
  deliveryPersonId: string;
  customerId: string;
  orderId: number;
  rating: number; // 1-5 scale
  comment?: string;
  criteria?: Record<string, number>; // e.g., { punctuality: 5, behavior: 4, packaging: 5 }
}

export interface BulkDeliveryActionRequest {
  action: 'APPROVE' | 'SUSPEND' | 'DEACTIVATE' | 'ASSIGN_ZONE' | 'BULK_PAYOUT';
  deliveryPersonIds: string[];
  payload?: Record<string, any>; // Additional data for specific actions
}

// ================================
// FILTER AND QUERY INTERFACES
// ================================

export interface DeliveryPersonFilterQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: DeliveryPersonStatus;
  zone?: string;
  vehicleType?: VehicleType;
  rating?: number; // minimum rating
  performance?: 'HIGH' | 'MEDIUM' | 'LOW';
  sortBy?: 'name' | 'createdAt' | 'rating' | 'totalDeliveries' | 'earnings';
  sortOrder?: 'asc' | 'desc';
}

export interface PayoutFilterQuery {
  deliveryPersonId?: string;
  status?: PayoutStatus;
  payoutType?: PayoutType;
  startDate?: Date;
  endDate?: Date;
  minAmount?: number;
  maxAmount?: number;
}

export interface ComplaintFilterQuery {
  deliveryPersonId?: string;
  customerId?: string;
  status?: ComplaintStatus;
  complaintType?: ComplaintType;
  severity?: number;
  startDate?: Date;
  endDate?: Date;
}

// ================================
// RESPONSE INTERFACES
// ================================

export interface DeliveryPersonProfile {
  id: string;
  name: string;
  phone: string;
  email?: string;
  address: string;
  nationalId: string;
  licenseNumber?: string;
  vehicleType: VehicleType;
  vehicleNumber?: string;
  emergencyContact: string;
  status: DeliveryPersonStatus;
  isActive: boolean;
  assignedZones: string[];
  joiningDate: Date;
  approvedAt?: Date;
  suspendedAt?: Date;
  
  // Relationships
  userId?: string;
  user?: {
    id: string;
    email?: string;
    isActive: boolean;
  };
  
  // Statistics
  totalDeliveries: number;
  completedDeliveries: number;
  totalEarnings: number;
  averageRating: number;
  totalComplaints: number;
}

export interface FundCollectionSummary {
  deliveryPersonId: string;
  totalAmount: number;
  totalOrders: number;
  pendingAmount: number;
  pendingOrders: number;
  settledAmount: number;
  settledOrders: number;
  collectionRate: number; // percentage
}

export interface DeliveryPerformanceMetrics {
  deliveryPersonId: string;
  period: string; // e.g., "30_days", "monthly", "weekly"
  totalDeliveries: number;
  completedDeliveries: number;
  onTimeDeliveries: number;
  completionRate: number; // percentage
  onTimeRate: number; // percentage
  averageRating: number;
  totalRatings: number;
  totalComplaints?: number;
  calculatedAt: Date;
}

export interface IncentiveCalculation {
  deliveryPersonId: string;
  totalIncentive: number;
  breakdown: {
    type: string;
    amount: number;
    description?: string;
  }[];
  calculatedAt: Date;
}

export interface DeliveryAnalytics {
  period: string;
  totalDeliveries?: number;
  deliveredOrders?: number;
  pendingOrders?: number;
  failedDeliveries?: number;
  totalCollectionAmount?: number;
  totalOrders?: number;
  averageCollectionPerOrder?: number;
  activeDeliveryPersons: number;
  averageDeliveriesPerPerson?: number;
  topPerformers?: {
    deliveryPersonId: string;
    name: string;
    totalCollections?: number;
    totalAmount?: number;
  }[];
  calculatedAt: Date;
}

export interface RatingSummary {
  deliveryPersonId: string;
  averageRating: number;
  totalRatings: number;
  ratingDistribution: {
    1: number;
    2: number;
    3: number;
    4: number;
    5: number;
  };
  calculatedAt: Date;
}

// ================================
// EXPORT OPTIONS
// ================================

export interface DeliveryExportOptions {
  format: 'csv' | 'xlsx' | 'json';
  fields: string[];
  filters?: {
    status?: DeliveryPersonStatus;
    search?: string;
    zone?: string;
    vehicleType?: VehicleType;
    startDate?: Date;
    endDate?: Date;
  };
}

// ================================
// PAGINATION INTERFACE
// ================================

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

// ================================
// DASHBOARD STATISTICS
// ================================

export interface DeliveryDashboardStats {
  activeDeliveryPersons: number;
  todayDeliveries: number;
  pendingCollectionAmount: number;
  pendingCollectionCount: number;
  averageRating: number;
  totalComplaints?: number;
  resolvedComplaints?: number;
  lastUpdated: Date;
}

export interface DeliveryTrends {
  period: string;
  deliveryVolume: {
    date: string;
    count: number;
  }[];
  performanceTrends: {
    date: string;
    avgCompletionRate: number;
    avgOnTimeRate: number;
    avgRating: number;
  }[];
  collectionTrends: {
    date: string;
    totalAmount: number;
    settledAmount: number;
  }[];
}

export interface ComparativeAnalysis {
  deliveryPersonId: string;
  name: string;
  metrics: {
    completionRate: number;
    onTimeRate: number;
    averageRating: number;
    totalEarnings: number;
    complaintCount: number;
  };
  rank: number;
  percentile: number;
}

// ================================
// LOCATION TRACKING
// ================================

export interface LocationUpdate {
  deliveryPersonId: string;
  latitude: number;
  longitude: number;
  timestamp: Date;
  accuracy?: number;
  speed?: number;
  heading?: number;
}

export interface DeliveryLocation {
  id: string;
  deliveryPersonId: string;
  latitude: number;
  longitude: number;
  updatedAt: Date;
}

// ================================
// NOTIFICATION INTERFACES
// ================================

export interface NotificationPayload {
  type: 'NEW_ORDER' | 'PAYMENT_REMINDER' | 'PERFORMANCE_UPDATE' | 'COMPLAINT_FILED' | 'OFFER_AVAILABLE';
  title: string;
  message: string;
  data?: Record<string, any>;
  deliveryPersonIds?: string[];
}

// ================================
// ADVANCED FILTERING
// ================================

export interface AdvancedDeliveryFilter {
  // Basic filters
  status?: DeliveryPersonStatus[];
  vehicleTypes?: VehicleType[];
  zones?: string[];
  
  // Performance filters
  minRating?: number;
  maxRating?: number;
  minDeliveries?: number;
  maxDeliveries?: number;
  
  // Date filters
  joinedAfter?: Date;
  joinedBefore?: Date;
  lastActiveAfter?: Date;
  lastActiveBefore?: Date;
  
  // Financial filters
  minEarnings?: number;
  maxEarnings?: number;
  hasPendingPayouts?: boolean;
  
  // Behavioral filters
  maxComplaints?: number;
  minCompletionRate?: number;
  maxResponseTime?: number; // in minutes
}

// ================================
// AUDIT AND LOGGING
// ================================

export interface DeliveryAuditLog {
  id: string;
  deliveryPersonId: string;
  action: string;
  performedBy: string; // user ID
  details: Record<string, any>;
  timestamp: Date;
  ipAddress?: string;
}

export interface PerformanceHistory {
  deliveryPersonId: string;
  date: Date;
  metrics: DeliveryPerformanceMetrics;
  notes?: string;
}

// ================================
// INTEGRATION INTERFACES
// ================================

export interface SMSNotification {
  phoneNumber: string;
  message: string;
  type: 'ORDER_ASSIGNED' | 'PAYMENT_REMINDER' | 'PERFORMANCE_ALERT';
}

export interface EmailNotification {
  email: string;
  subject: string;
  body: string;
  template?: string;
  data?: Record<string, any>;
}

// ================================
// VALIDATION SCHEMAS
// ================================

export interface ValidationError {
  field: string;
  message: string;
  code: string;
}

export interface ApiResponse<T = any> {
  success: boolean;
  message?: string;
  data?: T;
  errors?: ValidationError[];
  pagination?: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

// ================================
// REPORTING INTERFACES
// ================================

export interface PerformanceReport {
  reportId: string;
  generatedAt: Date;
  period: {
    start: Date;
    end: Date;
  };
  summary: {
    totalDeliveryPersons: number;
    activeDeliveryPersons: number;
    totalDeliveries: number;
    averageCompletionRate: number;
    averageOnTimeRate: number;
    totalEarnings: number;
  };
  topPerformers: DeliveryPersonProfile[];
  underPerformers: DeliveryPersonProfile[];
  trends: DeliveryTrends;
}

export interface FundCollectionReport {
  reportId: string;
  generatedAt: Date;
  period: {
    start: Date;
    end: Date;
  };
  summary: {
    totalCollected: number;
    totalPending: number;
    collectionRate: number;
    averageCollectionTime: number; // in hours
  };
  byDeliveryPerson: {
    deliveryPersonId: string;
    name: string;
    totalCollected: number;
    pendingAmount: number;
    collectionCount: number;
    avgCollectionTime: number;
  }[];
}

// ================================
// ZONE MANAGEMENT
// ================================

export interface DeliveryZone {
  id: string;
  name: string;
  boundaries: {
    type: 'polygon';
    coordinates: number[][][];
  };
  isActive: boolean;
  assignedDeliveryPersons: string[];
  averageDeliveryTime: number; // in minutes
  deliveryCharge: number;
}

export interface ZoneAssignment {
  deliveryPersonId: string;
  zoneId: string;
  assignedAt: Date;
  isActive: boolean;
  priority: number; // 1-10, higher means preferred
}

// ================================
// SCHEDULING INTERFACES
// ================================

export interface WorkSchedule {
  deliveryPersonId: string;
  dayOfWeek: number; // 0-6, Sunday to Saturday
  startTime: string; // HH:MM format
  endTime: string; // HH:MM format
  isAvailable: boolean;
  maxOrders?: number;
}

export interface ShiftAssignment {
  id: string;
  deliveryPersonId: string;
  date: Date;
  startTime: Date;
  endTime: Date;
  expectedOrders: number;
  actualOrders: number;
  status: 'SCHEDULED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
}

// ================================
// LOYALTY AND REWARDS
// ================================

export interface DeliveryPersonRewards {
  deliveryPersonId: string;
  totalPoints: number;
  availablePoints: number;
  tier: 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM';
  achievements: Achievement[];
  redeemableRewards: RedeemableReward[];
}

export interface Achievement {
  id: string;
  name: string;
  description: string;
  icon: string;
  earnedAt: Date;
  points: number;
}

export interface RedeemableReward {
  id: string;
  name: string;
  description: string;
  pointsCost: number;
  category: 'CASH' | 'VOUCHER' | 'EQUIPMENT' | 'TRAINING';
  isActive: boolean;
}

// ================================
// EMERGENCY PROTOCOLS
// ================================

export interface EmergencyAlert {
  id: string;
  deliveryPersonId: string;
  type: 'ACCIDENT' | 'THEFT' | 'MEDICAL' | 'HARASSMENT' | 'VEHICLE_BREAKDOWN';
  location: {
    latitude: number;
    longitude: number;
  };
  description: string;
  status: 'ACTIVE' | 'RESPONDING' | 'RESOLVED';
  createdAt: Date;
  resolvedAt?: Date;
}

export interface EmergencyContact {
  deliveryPersonId: string;
  name: string;
  relationship: string;
  phone: string;
  isPrimary: boolean;
}

// ================================
// TRAINING AND CERTIFICATION
// ================================

export interface TrainingModule {
  id: string;
  title: string;
  description: string;
  duration: number; // in minutes
  isRequired: boolean;
  category: 'SAFETY' | 'CUSTOMER_SERVICE' | 'PRODUCT_HANDLING' | 'COMPLIANCE';
}

export interface TrainingCompletion {
  deliveryPersonId: string;
  moduleId: string;
  completedAt: Date;
  score: number; // percentage
  certificateUrl?: string;
  expiresAt?: Date;
}

export interface Certification {
  id: string;
  name: string;
  issuingBody: string;
  validityPeriod: number; // in months
  isRequired: boolean;
}

export interface DeliveryPersonCertification {
  deliveryPersonId: string;
  certificationId: string;
  issuedAt: Date;
  expiresAt: Date;
  certificateNumber: string;
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
}