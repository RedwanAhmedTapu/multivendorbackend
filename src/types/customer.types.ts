// types/customer.types.ts
import type { Product } from "@prisma/client";

// -------------------- Basic Types --------------------
export type ComplaintStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
export type ComplaintPriority = 'LOW' | 'MEDIUM' | 'HIGH';

export type WalletTransactionType = 'CREDIT' | 'DEBIT' | 'REFUND' | 'ADJUSTMENT';
export type LoyaltyTransactionType = 'EARNED' | 'SPENT' | 'ADJUSTMENT';

export type CustomerStatus = 'active' | 'blocked' | 'all';

// -------------------- Core Interfaces --------------------
export interface Customer {
  id: string;
  name: string;
  email: string;
  phone: string;
  isActive: boolean;
  isBlocked: boolean;
  walletBalance: number;
  loyaltyPoints: number;
  createdAt: Date;
  updatedAt: Date;
  profile?: CustomerProfile;
  reviews?: Review[];
  complaints?: Complaint[];
  walletTransactions?: WalletTransaction[];
  loyaltyTransactions?: LoyaltyTransaction[];
}

export interface CustomerProfile {
  id: string;
  userId: string;
  address?: string;
  phone?: string;
  wallet: number;
  loyaltyPoints: number;
  createdAt: Date;
  updatedAt: Date;
}

// -------------------- Review --------------------
export interface Review {
  id: string;
  userId: string;
  productId: string;
  rating: number;
  comment?: string;
  isApproved: boolean;
  isFlagged: boolean;
  flaggedReason?: string;
  createdAt: Date;
  updatedAt: Date;
  user: Customer;
  product: Product;
}

// -------------------- Complaints --------------------
export interface Complaint {
  id: string;
  userId: string;
  subject: string;
  description: string;
  status: ComplaintStatus;
  priority: ComplaintPriority;
  assignedTo?: string;
  createdAt: Date;
  updatedAt: Date;
  user: Customer;
  messages: ComplaintMessage[];
}

export interface ComplaintMessage {
  id: string;
  complaintId: string;
  senderId: string;
  content: string;
  isInternal: boolean;
  createdAt: Date;
}

// -------------------- Wallet & Loyalty --------------------
export interface WalletTransaction {
  id: string;
  userId: string;
  amount: number;
  type: WalletTransactionType;
  description: string;
  referenceId?: string;
  createdAt: Date;
}

export interface LoyaltyTransaction {
  id: string;
  userId: string;
  points: number;
  type: LoyaltyTransactionType;
  description: string;
  referenceId?: string;
  createdAt: Date;
}

// -------------------- Filters & Export --------------------
export interface CustomerFilter {
  status?: CustomerStatus;
  search?: string;
  minWallet?: number;
  maxWallet?: number;
  minLoyalty?: number;
  maxLoyalty?: number;
  startDate?: Date;
  endDate?: Date;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface ExportOptions {
  format: 'csv' | 'json' | 'excel';
  fields: string[];
  filters?: CustomerFilter;
}
