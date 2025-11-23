// src/controllers/employee.controller.ts
import type { Request, Response } from 'express';
import { EmployeeService } from '../services/employee.service.ts';
import type { ApiResponse } from '../types/response.types.ts';
import { hashPassword } from '../utils/auth.ts';

const employeeService = new EmployeeService();

export class EmployeeController {
  
  // =============================
  // ADMIN EMPLOYEE CONTROLLERS
  // =============================

  async createAdminEmployee(req: Request, res: Response) {
    try {
      const createdById = req.user?.id;
      if (!createdById) {
        const response: ApiResponse = {
          success: false,
          message: 'Unauthorized',
        };
        return res.status(401).json(response);
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

      const response: ApiResponse = {
        success: true,
        message: 'Employee created successfully',
        data: employee,
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
      const createdById = req.user?.id;

      if (!vendorId || !createdById) {
        const response: ApiResponse = {
          success: false,
          message: 'Unauthorized - Vendor access required',
        };
        return res.status(401).json(response);
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

      const response: ApiResponse = {
        success: true,
        message: 'Employee created successfully',
        data: employee,
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