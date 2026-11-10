// src/types/employee.types.ts
export interface CreateEmployeeRequest {
  name: string;
  email: string;
  phone?: string;
  password: string;
  designation: string;
  department: string;
  permissions: {
    productManagement?: boolean;
    orderManagement?: boolean;
    customerSupport?: boolean;
    analytics?: boolean;
    offerManagement?: boolean;
    inventoryManagement?: boolean;
    /** Gates every /api/hrm/* route for EMPLOYEE role (see
     *  permission.middleware.ts PermissionKey). */
    hrManagement?: boolean;
    /** Marketing Center admin side (campaigns, approvals). Admin-only grant. */
    marketingManagement?: boolean;
    /** Admin-side: manage vendor POS subscriptions. Admin-only grant. */
    posSubscriptionManagement?: boolean;
    /** Admin-side: the Agent Commission admin area. Admin-only grant. */
    agentManagement?: boolean;
    /** Vendor-only: use the vendor POS (/api/pos/*). Granted by the vendor owner. */
    posAccess?: boolean;
    /** Vendor-only POS action grants (see permission.middleware.ts). */
    posDiscount?: boolean;
    posCredit?: boolean;
    posRefund?: boolean;
    posReports?: boolean;
    /** Granular HR permissions (P0) — the hrManagement umbrella overrides
     *  all of them. See requireHr() in permission.middleware.ts. */
    hrEmployeeView?: boolean;
    hrEmployeeCreate?: boolean;
    hrEmployeeEdit?: boolean;
    hrEmployeeDelete?: boolean;
    hrSalaryView?: boolean;
    hrSalaryEdit?: boolean;
    hrDocsUpload?: boolean;
    hrDocsVerify?: boolean;
    hrDocsDownload?: boolean;
    hrDocsDelete?: boolean;
    hrBankView?: boolean;
    hrOrgEdit?: boolean;
    hrLeaveTypesEdit?: boolean;
  };
}

export interface UpdateEmployeeRequest {
  name?: string;
  email?: string;
  phone?: string;
  designation?: string;
  department?: string;
  permissions?: {
    productManagement?: boolean;
    orderManagement?: boolean;
    customerSupport?: boolean;
    analytics?: boolean;
    offerManagement?: boolean;
    inventoryManagement?: boolean;
    hrManagement?: boolean;
    marketingManagement?: boolean;
    /** Admin-side: manage vendor POS subscriptions. Admin-only grant. */
    posSubscriptionManagement?: boolean;
    /** Admin-side: the Agent Commission admin area. Admin-only grant. */
    agentManagement?: boolean;
    /** Vendor-only: use the vendor POS (/api/pos/*). Granted by the vendor owner. */
    posAccess?: boolean;
    /** Vendor-only POS action grants (see permission.middleware.ts). */
    posDiscount?: boolean;
    posCredit?: boolean;
    posRefund?: boolean;
    posReports?: boolean;
    hrEmployeeView?: boolean;
    hrEmployeeCreate?: boolean;
    hrEmployeeEdit?: boolean;
    hrEmployeeDelete?: boolean;
    hrSalaryView?: boolean;
    hrSalaryEdit?: boolean;
    hrDocsUpload?: boolean;
    hrDocsVerify?: boolean;
    hrDocsDownload?: boolean;
    hrDocsDelete?: boolean;
    hrBankView?: boolean;
    hrOrgEdit?: boolean;
    hrLeaveTypesEdit?: boolean;
  };
  isActive?: boolean;
}

export interface EmployeeFilters {
  search?: string;
  department?: string;
  designation?: string;
  isActive?: boolean;
  page?: number;
  limit?: number;
}