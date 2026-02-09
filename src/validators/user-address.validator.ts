// src/validators/user-address.validator.ts
import { z } from 'zod';

// Phone regex - supports various formats
const phoneRegex = /^[\+]?[(]?[0-9]{1,4}[)]?[-\s\.]?[(]?[0-9]{1,4}[)]?[-\s\.]?[0-9]{1,9}$/;

export const createAddressSchema = z.object({
  body: z.object({
    locationId: z.string({
      required_error: 'Location ID is required',
    }).min(1, 'Location ID cannot be empty'),
    
    fullName: z.string({
      required_error: 'Full name is required',
    }).min(2, 'Full name must be at least 2 characters')
      .max(100, 'Full name must be less than 100 characters'),
    
    phone: z.string({
      required_error: 'Phone number is required',
    }).regex(phoneRegex, 'Invalid phone number format'),
    
    addressLine1: z.string({
      required_error: 'Address line 1 is required',
    }).min(5, 'Address line 1 must be at least 5 characters')
      .max(200, 'Address line 1 must be less than 200 characters'),
    
    addressLine2: z.string()
      .max(200, 'Address line 2 must be less than 200 characters')
      .optional(),
    
    landmark: z.string()
      .max(100, 'Landmark must be less than 100 characters')
      .optional(),
    
    isDefault: z.boolean().optional(),
    
    addressType: z.enum(['HOME', 'WORK', 'OTHER'])
      .optional(),
  }),
});

export const updateAddressSchema = z.object({
  params: z.object({
    id: z.string().min(1, 'Address ID is required'),
  }),
  body: z.object({
    locationId: z.string().min(1, 'Location ID cannot be empty').optional(),
    
    fullName: z.string()
      .min(2, 'Full name must be at least 2 characters')
      .max(100, 'Full name must be less than 100 characters')
      .optional(),
    
    phone: z.string()
      .regex(phoneRegex, 'Invalid phone number format')
      .optional(),
    
    addressLine1: z.string()
      .min(5, 'Address line 1 must be at least 5 characters')
      .max(200, 'Address line 1 must be less than 200 characters')
      .optional(),
    
    addressLine2: z.string()
      .max(200, 'Address line 2 must be less than 200 characters')
      .optional()
      .nullable(),
    
    landmark: z.string()
      .max(100, 'Landmark must be less than 100 characters')
      .optional()
      .nullable(),
    
    isDefault: z.boolean().optional(),
    
    addressType: z.enum(['HOME', 'WORK', 'OTHER'])
      .optional()
      .nullable(),
  }),
});

export const upsertAddressSchema = z.object({
  body: z.object({
    id: z.string().optional(), // If provided, update; otherwise create
    
    locationId: z.string({
      required_error: 'Location ID is required',
    }).min(1, 'Location ID cannot be empty'),
    
    fullName: z.string({
      required_error: 'Full name is required',
    }).min(2, 'Full name must be at least 2 characters')
      .max(100, 'Full name must be less than 100 characters'),
    
    phone: z.string({
      required_error: 'Phone number is required',
    }).regex(phoneRegex, 'Invalid phone number format'),
    
    addressLine1: z.string({
      required_error: 'Address line 1 is required',
    }).min(5, 'Address line 1 must be at least 5 characters')
      .max(200, 'Address line 1 must be less than 200 characters'),
    
    addressLine2: z.string()
      .max(200, 'Address line 2 must be less than 200 characters')
      .optional(),
    
    landmark: z.string()
      .max(100, 'Landmark must be less than 100 characters')
      .optional(),
    
    isDefault: z.boolean().optional(),
    
    addressType: z.enum(['HOME', 'WORK', 'OTHER'])
      .optional(),
  }),
});

export const addressIdSchema = z.object({
  params: z.object({
    id: z.string().min(1, 'Address ID is required'),
  }),
});

export const getAddressesSchema = z.object({
  query: z.object({
    isDefault: z.enum(['true', 'false']).optional(),
  }),
});