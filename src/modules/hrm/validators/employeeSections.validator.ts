// src/modules/hrm/validators/employeeSections.validator.ts
//
// Zod validation for the Employee 360 nested resources (family, education,
// previous employment, bank/MFS, documents) and the lifecycle actions
// (promotion / transfer / salary revision).
//
// Conventions:
// - Same shape as the vendor routes use with the shared `validate()`
//   middleware (src/middlewares/vendor.schema.validation.middleware.ts):
//   schemas wrap `body` / `params` so the middleware can parse req in one
//   pass and return { success:false, message, errors[] } on failure.
// - Dates are "YYYY-MM-DD" strings — every Hr* date column in this module
//   stores plain ISO-date strings, not DateTime.
// - File payloads for documents/photos go through the existing R2 upload
//   pipeline; `fileUrl` accepts the relative storage key (or a full URL)
//   exactly like product-module's storagePathOrUrl.

import { z } from "zod";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be a YYYY-MM-DD date");

const employeeIdParam = z.object({
  id: z.string().min(1, "Employee id is required"),
});

const sectionIdParam = z.object({
  id: z.string().min(1, "Employee id is required"),
  sectionId: z.string().min(1, "Record id is required"),
});

// ── Family ───────────────────────────────────────────────────────────────

export const createFamilyMemberSchema = z.object({
  params: employeeIdParam,
  body: z.object({
    name: z.string().min(1, "Name is required"),
    relationship: z.string().min(1, "Relationship is required"),
    dob: isoDate.optional(),
    occupation: z.string().optional(),
    mobile: z.string().optional(),
    dependent: z.boolean().optional(),
  }),
});

export const updateFamilyMemberSchema = z.object({
  params: sectionIdParam,
  body: z
    .object({
      name: z.string().min(1).optional(),
      relationship: z.string().min(1).optional(),
      dob: isoDate.optional(),
      occupation: z.string().optional(),
      mobile: z.string().optional(),
      dependent: z.boolean().optional(),
    })
    .refine((b) => Object.keys(b).length > 0, "Nothing to update"),
});

// ── Education ────────────────────────────────────────────────────────────

export const createEducationSchema = z.object({
  params: employeeIdParam,
  body: z.object({
    degree: z.string().min(1, "Degree is required"),
    institution: z.string().optional(),
    major: z.string().optional(),
    passingYear: z.string().optional(),
    result: z.string().optional(),
  }),
});

export const updateEducationSchema = z.object({
  params: sectionIdParam,
  body: z
    .object({
      degree: z.string().min(1).optional(),
      institution: z.string().optional(),
      major: z.string().optional(),
      passingYear: z.string().optional(),
      result: z.string().optional(),
    })
    .refine((b) => Object.keys(b).length > 0, "Nothing to update"),
});

// ── Previous employment ──────────────────────────────────────────────────

export const createPreviousEmploymentSchema = z.object({
  params: employeeIdParam,
  body: z.object({
    company: z.string().min(1, "Company is required"),
    designation: z.string().optional(),
    department: z.string().optional(),
    joinDate: isoDate.optional(),
    leaveDate: isoDate.optional(),
    lastSalary: z.number().nonnegative().optional(),
    reasonForLeaving: z.string().optional(),
    supervisor: z.string().optional(),
    contact: z.string().optional(),
    notes: z.string().optional(),
  }),
});

export const updatePreviousEmploymentSchema = z.object({
  params: sectionIdParam,
  body: z
    .object({
      company: z.string().min(1).optional(),
      designation: z.string().optional(),
      department: z.string().optional(),
      joinDate: isoDate.optional(),
      leaveDate: isoDate.optional(),
      lastSalary: z.number().nonnegative().nullable().optional(),
      reasonForLeaving: z.string().optional(),
      supervisor: z.string().optional(),
      contact: z.string().optional(),
      notes: z.string().optional(),
    })
    .refine((b) => Object.keys(b).length > 0, "Nothing to update"),
});

// ── Bank / MFS ───────────────────────────────────────────────────────────

// NOTE: this MUST be wrapped in z.object() below — a plain object of Zod
// fields passed as `body:` makes Zod v4 throw a generic Error ("Invalid
// element at key 'body'") inside parseAsync, which the validate middleware
// cannot recognise as a ZodError, producing a 500 instead of a 400.
const bankFields = z.object({
  holderName: z.string().optional(),
  bank: z.string().optional(),
  branch: z.string().optional(),
  accountNumber: z.string().optional(),
  routingNumber: z.string().optional(),
  accountType: z.enum(["SAVINGS", "CURRENT", "SALARY"]).optional(),
  mfsProvider: z.enum(["BKASH", "NAGAD", "ROCKET", "OTHER"]).optional(),
  mfsNumber: z.string().optional(),
  paymentMethod: z.enum(["BANK", "MFS", "CASH", "OTHER"]).optional(),
  isPrimary: z.boolean().optional(),
});

export const createBankAccountSchema = z.object({
  params: employeeIdParam,
  body: bankFields,
});

export const updateBankAccountSchema = z.object({
  params: sectionIdParam,
  body: bankFields,
});

// ── Documents ────────────────────────────────────────────────────────────

export const createDocumentSchema = z.object({
  params: employeeIdParam,
  body: z.object({
    category: z.enum(["IDENTITY", "EDUCATION", "EXPERIENCE", "CONTRACT", "OTHER"]).default("IDENTITY"),
    docType: z.string().min(1, "Document type is required"),
    title: z.string().min(1, "Title is required"),
    docNumber: z.string().optional(),
    issueDate: isoDate.optional(),
    expiryDate: isoDate.optional(),
    notes: z.string().optional(),
  }),
});

export const updateDocumentSchema = z.object({
  params: sectionIdParam,
  body: z
    .object({
      category: z.enum(["IDENTITY", "EDUCATION", "EXPERIENCE", "CONTRACT", "OTHER"]).optional(),
      docType: z.string().min(1).optional(),
      title: z.string().min(1).optional(),
      docNumber: z.string().optional(),
      issueDate: isoDate.optional(),
      expiryDate: isoDate.optional(),
      notes: z.string().optional(),
    })
    .refine((b) => Object.keys(b).length > 0, "Nothing to update"),
});

// ── Lifecycle (promotion / transfer / salary revision) ───────────────────

export const createPromotionSchema = z.object({
  params: employeeIdParam,
  body: z.object({
    newDesignationId: z.string().min(1, "New designation is required"),
    newBasicSalary: z.number().nonnegative().optional(),
    effectiveDate: isoDate,
    reason: z.string().optional(),
  }),
});

export const createTransferSchema = z.object({
  params: employeeIdParam,
  body: z
    .object({
      toBranchId: z.string().optional(),
      toDepartmentId: z.string().optional(),
      effectiveDate: isoDate,
      reason: z.string().optional(),
    })
    .refine((b) => b.toBranchId || b.toDepartmentId, {
      message: "A transfer needs a target branch or department",
    }),
});

export const createSalaryRevisionSchema = z.object({
  params: employeeIdParam,
  body: z.object({
    newSalary: z.number().nonnegative("New salary is required"),
    effectiveDate: isoDate,
    reason: z.string().optional(),
  }),
});

export const lifecycleActSchema = z.object({
  params: sectionIdParam,
  body: z.object({
    status: z.enum(["APPROVED", "REJECTED"], {
      message: "Status must be APPROVED or REJECTED",
    }),
  }),
});
