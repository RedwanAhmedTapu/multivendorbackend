// src/controllers/employee.controller.ts
import type { Request, Response } from 'express';
import { employeeService } from '../services/employee.service.ts';
import type { ApiResponse } from '../types/response.types.ts';
import { hashPassword } from '../utils/auth.ts';
import type { AuthRequest } from '../middlewares/auth.middleware.ts';
import { employeeProfileService } from '../modules/hrm/services/employeeProfile.service.ts';
import { getHrScope } from '../modules/hrm/utils/hrmScope.ts';
import { validatePermissionPatch } from '../middlewares/permission.middleware.ts';


/**
 * Auto-create the HrEmployeeProfile for a freshly created employee.
 * Idempotent (safe to re-run), and best-effort: a failure here must never
 * block the account itself — the HRM backfill script
 * (src/modules/hrm/scripts/backfillHrProfiles.ts) can repair it later.
 */
async function initHrProfile(req: Request, employee: { id: string; userId: string | null }, data: { name: string; email?: string; phone?: string; designation?: string; department?: string }) {
  try {
    const profile = await employeeProfileService.ensureProfile(getHrScope(req as AuthRequest), {
      linkedUserId: employee.userId!,
      linkedEmployeeId: employee.id,
      fullName: data.name,
      mobile: data.phone ?? null,
      personalEmail: data.email ?? null,
      designationText: data.designation ?? null,
      departmentText: data.department ?? null,
    });
    return profile.id;
  } catch (err) {
    console.warn(`[HRM] HR profile auto-creation failed for employee ${employee.id}:`, err);
    return undefined;
  }
}

export class EmployeeController {
  
  // =============================
  // ADMIN EMPLOYEE CONTROLLERS
  // =============================

  async createAdminEmployee(req: Request, res: Response) {
    try {
      const createdById = req.user?.rawId;
      if (!createdById) {
        const response: ApiResponse = {
          success: false,
          message: 'Unauthorized',
        };
        return res.status(401).json(response);
      }

      const permCheck = validatePermissionPatch(req.body?.permissions, (req as AuthRequest).user?.role);
      if (!permCheck.ok) {
        const response: ApiResponse = { success: false, message: permCheck.message };
        return res.status(permCheck.status).json(response);
      }

      const { password, ...employeeData } = req.body;
      
      // Validate required fields
      if (!password || !employeeData.name || !employeeData.email ) {
        const response: ApiResponse = {
          success: false,
          message: 'Missing required fields: name, email, password, designation, department',
        };
        return res.status(400).json(response);
      }

      // Hash password
      const hashedPassword = await hashPassword(password);

      const employee = await employeeService.createAdminEmployee(
        { ...employeeData, password: hashedPassword },
        createdById
      );

      const hrProfileId = await initHrProfile(req, employee, employeeData);

      const response: ApiResponse = {
        success: true,
        message: 'Employee created successfully',
        data: { ...employee, hrProfileId },
      };

      res.status(201).json(response);
    } catch (error: any) {
      const response: ApiResponse = {
        success: false,
        message: error.message,
      };
      res.status(400).json(response);
    }
  }

  async getAdminEmployees(req: Request, res: Response) {
    try {
      const filters = {
        search: req.query.search as string,
        department: req.query.department as string,
        designation: req.query.designation as string,
        isActive: req.query.isActive ? req.query.isActive === 'true' : undefined,
        page: req.query.page ? parseInt(req.query.page as string) : 1,
        limit: req.query.limit ? parseInt(req.query.limit as string) : 10,
      };

      const result = await employeeService.getAdminEmployees(filters);

      const response = {
        success: true,
        data: result.employees,
        pagination: {
          page: result.page,
          limit: result.limit,
          total: result.total,
          totalPages: result.totalPages,
        },
      };

      res.status(200).json(response);
    } catch (error: any) {
      const response: ApiResponse = {
        success: false,
        message: error.message,
      };
      res.status(400).json(response);
    }
  }

  async updateAdminEmployee(req: Request, res: Response) {
    try {
      const { employeeId } = req.params;
      const updateData = req.body;

      if (!employeeId) {
        const response: ApiResponse = {
          success: false,
          message: 'Employee ID is required',
        };
        return res.status(400).json(response);
      }

      const permCheck = validatePermissionPatch(req.body?.permissions, (req as AuthRequest).user?.role);
      if (!permCheck.ok) {
        const response: ApiResponse = { success: false, message: permCheck.message };
        return res.status(permCheck.status).json(response);
      }

      const employee = await employeeService.updateAdminEmployee(employeeId, updateData);

      const response: ApiResponse = {
        success: true,
        message: 'Employee updated successfully',
        data: employee,
      };

      res.status(200).json(response);
    } catch (error: any) {
      const response: ApiResponse = {
        success: false,
        message: error.message,
      };
      res.status(400).json(response);
    }
  }

  async toggleAdminEmployeeStatus(req: Request, res: Response) {
    try {
      const { employeeId } = req.params;

      if (!employeeId) {
        const response: ApiResponse = {
          success: false,
          message: 'Employee ID is required',
        };
        return res.status(400).json(response);
      }

      const result = await employeeService.toggleAdminEmployeeStatus(employeeId);

      const response: ApiResponse = {
        success: true,
        message: result.message,
        data: { isActive: result.isActive },
      };

      res.status(200).json(response);
    } catch (error: any) {
      const response: ApiResponse = {
        success: false,
        message: error.message,
      };
      res.status(400).json(response);
    }
  }

  // =============================
  // VENDOR EMPLOYEE CONTROLLERS
  // =============================

  async createVendorEmployee(req: Request, res: Response) {
    try {
      const vendorId = req.user?.vendorId;
      // Employee.createdById references User.id (relation "EmployeeCreator").
      // For a VENDOR session, req.user.id is the role-specific effective id
      // (Vendor.id) — createdById must be the real User row: rawId.
      const createdById = req.user?.rawId;

      if (!vendorId || !createdById) {
        const response: ApiResponse = {
          success: false,
          message: 'Unauthorized - Vendor access required',
        };
        return res.status(401).json(response);
      }

      const permCheck = validatePermissionPatch(req.body?.permissions, (req as AuthRequest).user?.role);
      if (!permCheck.ok) {
        const response: ApiResponse = { success: false, message: permCheck.message };
        return res.status(permCheck.status).json(response);
      }

      const { password, ...employeeData } = req.body;
      
      // Validate required fields
      if (!password || !employeeData.name || !employeeData.email || !employeeData.designation || !employeeData.department) {
        const response: ApiResponse = {
          success: false,
          message: 'Missing required fields: name, email, password, designation, department',
        };
        return res.status(400).json(response);
      }

      // Hash password
      const hashedPassword = await hashPassword(password);

      const employee = await employeeService.createVendorEmployee(
        { ...employeeData, password: hashedPassword },
        vendorId,
        createdById
      );

      const hrProfileId = await initHrProfile(req, employee, employeeData);

      const response: ApiResponse = {
        success: true,
        message: 'Employee created successfully',
        data: { ...employee, hrProfileId },
      };

      res.status(201).json(response);
    } catch (error: any) {
      const response: ApiResponse = {
        success: false,
        message: error.message,
      };
      res.status(400).json(response);
    }
  }

  async getVendorEmployees(req: Request, res: Response) {
    try {
      const vendorId = req.user?.vendorId;
      if (!vendorId) {
        const response: ApiResponse = {
          success: false,
          message: 'Unauthorized - Vendor access required',
        };
        return res.status(401).json(response);
      }

      const filters = {
        search: req.query.search as string,
        department: req.query.department as string,
        designation: req.query.designation as string,
        isActive: req.query.isActive ? req.query.isActive === 'true' : undefined,
        page: req.query.page ? parseInt(req.query.page as string) : 1,
        limit: req.query.limit ? parseInt(req.query.limit as string) : 10,
      };

      const result = await employeeService.getVendorEmployees(vendorId, filters);

      const response = {
        success: true,
        data: result.employees,
        pagination: {
          page: result.page,
          limit: result.limit,
          total: result.total,
          totalPages: result.totalPages,
        },
      };

      res.status(200).json(response);
    } catch (error: any) {
      const response: ApiResponse = {
        success: false,
        message: error.message,
      };
      res.status(400).json(response);
    }
  }

  async updateVendorEmployee(req: Request, res: Response) {
    try {
      const vendorId = req.user?.vendorId;
      const { employeeId } = req.params;

      if (!vendorId) {
        const response: ApiResponse = {
          success: false,
          message: 'Unauthorized - Vendor access required',
        };
        return res.status(401).json(response);
      }

      if (!employeeId) {
        const response: ApiResponse = {
          success: false,
          message: 'Employee ID is required',
        };
        return res.status(400).json(response);
      }

      const permCheck = validatePermissionPatch(req.body?.permissions, (req as AuthRequest).user?.role);
      if (!permCheck.ok) {
        const response: ApiResponse = { success: false, message: permCheck.message };
        return res.status(permCheck.status).json(response);
      }

      const updateData = req.body;
      const employee = await employeeService.updateVendorEmployee(employeeId, vendorId, updateData);

      const response: ApiResponse = {
        success: true,
        message: 'Employee updated successfully',
        data: employee,
      };

      res.status(200).json(response);
    } catch (error: any) {
      const response: ApiResponse = {
        success: false,
        message: error.message,
      };
      res.status(400).json(response);
    }
  }

  async toggleVendorEmployeeStatus(req: Request, res: Response) {
    try {
      const vendorId = req.user?.vendorId;
      const { employeeId } = req.params;

      if (!vendorId) {
        const response: ApiResponse = {
          success: false,
          message: 'Unauthorized - Vendor access required',
        };
        return res.status(401).json(response);
      }

      if (!employeeId) {
        const response: ApiResponse = {
          success: false,
          message: 'Employee ID is required',
        };
        return res.status(400).json(response);
      }

      const result = await employeeService.toggleVendorEmployeeStatus(employeeId, vendorId);

      const response: ApiResponse = {
        success: true,
        message: result.message,
        data: { isActive: result.isActive },
      };

      res.status(200).json(response);
    } catch (error: any) {
      const response: ApiResponse = {
        success: false,
        message: error.message,
      };
      res.status(400).json(response);
    }
  }

 async getEmployee(req: Request, res: Response) {
  try {
    const { employeeId } = req.params;

    if (!employeeId) {
      const response: ApiResponse = {
        success: false,
        message: 'Employee ID is required',
      };
      return res.status(400).json(response);
    }

    const employee = await employeeService.getEmployeeById(employeeId);

    if (!employee) {
      const response: ApiResponse = {
        success: false,
        message: 'Employee not found',
      };
      return res.status(404).json(response);
    }

    // ── নতুন: scope check ──
    // ADMIN সব দেখে। VENDOR / vendor-এর EMPLOYEE শুধু নিজের vendorId-র
    // অধীনে থাকা employee দেখবে। Admin-এর নিজের EMPLOYEE শুধু vendorId
    // null (admin side) এমন employee দেখবে।
    const callerRole = req.user?.role;
    const callerVendorId = req.user?.vendorId ?? null;
    const isAdmin = callerRole === 'ADMIN';
    const inScope = isAdmin || employee.vendorId === callerVendorId;

    if (!inScope) {
      // 404 দিচ্ছি, 403 না — যাতে attacker বুঝতে না পারে যে id-টা আসলে
      // অন্য কোনো vendor-এর অধীনে exist করে
      const response: ApiResponse = {
        success: false,
        message: 'Employee not found',
      };
      return res.status(404).json(response);
    }

    const response: ApiResponse = {
      success: true,
      data: employee,
    };

    res.status(200).json(response);
  } catch (error: any) {
    const response: ApiResponse = {
      success: false,
      message: error.message,
    };
    res.status(400).json(response);
  }
}

  // =============================
  // EMPLOYEE PERMISSION CONTROLLERS
  // =============================

  async updateEmployeePermissions(req: Request, res: Response) {
    try {
      const { employeeId } = req.params;
      const { permissions } = req.body;
      const vendorId = req.user?.vendorId;

      // A user can never grant more than they hold: VENDOR owners do not
      // hold the sensitive salary/bank gates (they are never auto-passed),
      // so they cannot grant those keys to anyone. ADMINs hold everything
      // except the vendor-only keys. Unknown keys / non-boolean values → 400.
      const permCheck = validatePermissionPatch(permissions, req.user?.role);
      if (!permCheck.ok) {
        const response: ApiResponse = { success: false, message: permCheck.message };
        return res.status(permCheck.status).json(response);
      }

      if (!employeeId || !permissions) {
        const response: ApiResponse = {
          success: false,
          message: 'Employee ID and permissions are required',
        };
        return res.status(400).json(response);
      }

      const employee = await employeeService.updateEmployeePermissions(employeeId, permissions, vendorId);

      const response: ApiResponse = {
        success: true,
        message: 'Employee permissions updated successfully',
        data: employee,
      };

      res.status(200).json(response);
    } catch (error: any) {
      const response: ApiResponse = {
        success: false,
        message: error.message,
      };
      res.status(400).json(response);
    }
  }

  async getEmployeePermissions(req: Request, res: Response) {
    try {
      const { employeeId } = req.params;
      const vendorId = req.user?.vendorId;

      if (!employeeId) {
        const response: ApiResponse = {
          success: false,
          message: 'Employee ID is required',
        };
        return res.status(400).json(response);
      }

      const permissions = await employeeService.getEmployeePermissions(employeeId, vendorId);

      const response: ApiResponse = {
        success: true,
        data: permissions,
      };

      res.status(200).json(response);
    } catch (error: any) {
      const response: ApiResponse = {
        success: false,
        message: error.message,
      };
      res.status(400).json(response);
    }
  }

  // =============================
  // EMPLOYEE STATISTICS CONTROLLERS
  // =============================

  async getAdminEmployeeStats(req: Request, res: Response) {
    try {
      const stats = await employeeService.getAdminEmployeeStats();

      const response: ApiResponse = {
        success: true,
        data: stats,
      };

      res.status(200).json(response);
    } catch (error: any) {
      const response: ApiResponse = {
        success: false,
        message: error.message,
      };
      res.status(400).json(response);
    }
  }

  async getVendorEmployeeStats(req: Request, res: Response) {
    try {
      const vendorId = req.user?.vendorId;
      
      if (!vendorId) {
        const response: ApiResponse = {
          success: false,
          message: 'Unauthorized - Vendor access required',
        };
        return res.status(401).json(response);
      }

      const stats = await employeeService.getVendorEmployeeStats(vendorId);

      const response: ApiResponse = {
        success: true,
        data: stats,
      };

      res.status(200).json(response);
    } catch (error: any) {
      const response: ApiResponse = {
        success: false,
        message: error.message,
      };
      res.status(400).json(response);
    }
  }
}