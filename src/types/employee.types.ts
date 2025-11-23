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