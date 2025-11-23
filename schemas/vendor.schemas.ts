// schemas/vendor.schemas.ts
import { z } from 'zod';
import { VendorStatus, PayoutStatus } from '@prisma/client';

export const createVendorSchema = z.object({
  body: z.object({
    storeName: z.string().min(1, 'Store name is required').max(255),
    email: z.string().email('Invalid email format'),
    phone: z.string().optional(),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    avatar: z.string().url().optional(),
  })
});

export const updateVendorProfileSchema = z.object({
  body: z.object({
    storeName: z.string().min(1).max(255).optional(),
    avatar: z.string().url().optional(),
    currentCommissionRate: z.number().min(0).max(100).optional(),
  })
});

export const setCommissionSchema = z.object({
  body: z.object({
    rate: z.number().min(0).max(100, 'Commission rate must be between 0 and 100'),
  })
});

export const createPayoutSchema = z.object({
  body: z.object({
    amount: z.number().positive('Amount must be positive'),
    method: z.string().max(100).optional(),
    period: z.string().max(100).optional(),
    note: z.string().max(500).optional(),
  })
});

export const updatePayoutStatusSchema = z.object({
  body: z.object({
    status: z.enum([PayoutStatus.PENDING, PayoutStatus.PAID, PayoutStatus.FAILED]),
    paidAt: z.string().datetime().optional(),
  })
});

export const setMonthlyChargeSchema = z.object({
  body: z.object({
    amount: z.number().positive('Amount must be positive'),
    description: z.string().max(500).optional(),
    effectiveFrom: z.string().datetime().optional(),
    effectiveTo: z.string().datetime().optional(),
  })
});

export const createOfferSchema = z.object({
  body: z.object({
    title: z.string().min(1, 'Title is required').max(255),
    details: z.string().max(1000).optional(),
    validFrom: z.string().datetime('Valid from date is required'),
    validTo: z.string().datetime().optional(),
  })
});

export const toggleOfferStatusSchema = z.object({
  body: z.object({
    isActive: z.boolean(),
  })
});

export const flagVendorSchema = z.object({
  body: z.object({
    reason: z.string().min(1, 'Reason is required').max(500),
    severity: z.number().int().min(1).max(5, 'Severity must be between 1 and 5'),
    meta: z.any().optional(),
  })
});

export const bulkCommissionSchema = z.object({
  body: z.object({
    vendorIds: z.array(z.string().cuid()).min(1, 'At least one vendor ID is required'),
    rate: z.number().min(0).max(100, 'Commission rate must be between 0 and 100'),
  })
});

export const bulkChargeSchema = z.object({
  body: z.object({
    vendorIds: z.array(z.string().cuid()).min(1, 'At least one vendor ID is required'),
    amount: z.number().positive('Amount must be positive'),
    description: z.string().max(500).optional(),
    effectiveFrom: z.string().datetime().optional(),
  })
});

export const sendMessageSchema = z.object({
  body: z.object({
    senderId: z.string().cuid('Invalid sender ID'),
    content: z.string().min(1, 'Message content is required').max(2000),
    metadata: z.any().optional(),
  })
});

export const vendorFilterSchema = z.object({
  query: z.object({
    status: z.enum([VendorStatus.PENDING, VendorStatus.ACTIVE, VendorStatus.SUSPENDED, VendorStatus.DEACTIVATED]).optional(),
    search: z.string().optional(),
    commissionMin: z.string().transform(Number).refine(n => !isNaN(n) && n >= 0).optional(),
    commissionMax: z.string().transform(Number).refine(n => !isNaN(n) && n <= 100).optional(),
    createdFrom: z.string().datetime().optional(),
    createdTo: z.string().datetime().optional(),
    page: z.string().transform(Number).refine(n => !isNaN(n) && n > 0).optional(),
    limit: z.string().transform(Number).refine(n => !isNaN(n) && n > 0 && n <= 100).optional(),
    sortBy: z.enum(['createdAt', 'storeName', 'totalSales', 'totalOrders']).optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
  })
});

export const exportVendorsSchema = z.object({
  query: z.object({
    format: z.enum(['csv', 'xlsx']).default('csv'),
    fields: z.string().transform(str => str.split(',').filter(f => f.trim())).optional(),
    status: z.enum([VendorStatus.PENDING, VendorStatus.ACTIVE, VendorStatus.SUSPENDED, VendorStatus.DEACTIVATED]).optional(),
    search: z.string().optional(),
    // Add other filter fields as needed
  })
});