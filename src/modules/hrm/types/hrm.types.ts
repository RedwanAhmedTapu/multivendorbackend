// src/modules/hrm/types/hrm.types.ts

export interface HrScope {
  // null = admin/platform-side HR data, set = a specific marketplace Vendor's HR data
  vendorId: string | null;
  // the caller's raw User.id (for createdBy/actedBy fields)
  actorUserId: string;
  role: string; // ADMIN | VENDOR | EMPLOYEE
}

export interface PaginationQuery {
  page?: number;
  limit?: number;
  search?: string;
}

// ── Organization ──
export interface CreateBranchInput {
  code: string;
  name: string;
  type?: string;
  address?: string;
  contact?: string;
  operatingHours?: string;
  /** Geo-fence coordinates — real columns on HrBranch, previously missing
   *  from the input type so the UI could not set them. */
  latitude?: number;
  longitude?: number;
}
export type UpdateBranchInput = Partial<CreateBranchInput> & { active?: boolean };

export interface CreateDepartmentInput {
  code: string;
  name: string;
  nameBn?: string;
  description?: string;
  branchId?: string;
}
export type UpdateDepartmentInput = Partial<CreateDepartmentInput> & { status?: string };

export interface CreateDesignationInput {
  code: string;
  name: string;
  nameBn?: string;
  departmentId?: string;
  grade?: string;
  minSalary?: number;
  maxSalary?: number;
  description?: string;
}
export type UpdateDesignationInput = Partial<CreateDesignationInput> & { status?: string };

// ── Employee profile ──
export interface CreateHrProfileInput {
  linkedUserId: string;
  linkedEmployeeId: string;
  code: string;
  fullName: string;
  mobile?: string;
  personalEmail?: string;
  branchId?: string;
  departmentId?: string;
  designationId?: string;
  reportingManagerId?: string;
  joiningDate?: string;
  employmentType?: string;
}

export interface UpdateHrProfileInput {
  fullName?: string;
  nameBn?: string;
  fatherName?: string;
  motherName?: string;
  spouseName?: string;
  dob?: string;
  gender?: string;
  bloodGroup?: string;
  maritalStatus?: string;
  nationality?: string;
  religion?: string;
  mobile?: string;
  altMobile?: string;
  personalEmail?: string;
  emergencyName?: string;
  emergencyRelation?: string;
  emergencyMobile?: string;
  presentAddress?: string;
  permanentAddress?: string;
  division?: string;
  district?: string;
  city?: string;
  postCode?: string;
  branchId?: string;
  departmentId?: string;
  designationId?: string;
  reportingManagerId?: string;
  shiftId?: string;
  workLocation?: string;
  joiningDate?: string;
  confirmationDate?: string;
  probationMonths?: number;
  employmentType?: string;
  status?: string;
  grade?: string;
  photoUrl?: string | null;
}

export interface HrProfileFilters extends PaginationQuery {
  branchId?: string;
  departmentId?: string;
  designationId?: string;
  status?: string;
}

// ── Attendance ──
export interface MarkAttendanceInput {
  employeeId: string;
  date: string; // ISO date, defaults to today
  checkIn?: string; // HH:MM
  checkOut?: string; // HH:MM
  status?: string;
  remarks?: string;
}

export interface AttendanceFilters extends PaginationQuery {
  employeeId?: string;
  fromDate?: string;
  toDate?: string;
  status?: string;
}

// ── Leave ──
export interface CreateLeaveTypeInput {
  code: string;
  name: string;
  paid?: boolean;
  defaultDays?: number;
  carryForward?: boolean;
  requiresAttachment?: boolean;
}

export interface CreateLeaveRequestInput {
  employeeId: string;
  leaveTypeId: string;
  fromDate: string;
  toDate: string;
  days: number;
  reason?: string;
  halfDay?: boolean;
  contactNumber?: string;
}

export interface ActOnLeaveInput {
  status: "APPROVED" | "REJECTED";
  comment?: string;
}

export interface LeaveFilters extends PaginationQuery {
  employeeId?: string;
  status?: string;
  leaveTypeId?: string;
}
