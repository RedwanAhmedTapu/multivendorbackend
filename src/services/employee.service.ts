// src/services/employee.service.ts
import { PrismaClient } from '@prisma/client';
import { UserRole, Prisma } from '@prisma/client';
import type { CreateEmployeeRequest, UpdateEmployeeRequest } from '../types/employee.types.ts';

const prisma = new PrismaClient();

export class EmployeeService {
  
  // =============================
  // ADMIN EMPLOYEE MANAGEMENT
  // =============================

  async createAdminEmployee(data: CreateEmployeeRequest, createdById: string) {
    return await prisma.$transaction(async (tx) => {
      // Check if email already exists
      const existingUser = await tx.user.findUnique({
        where: { email: data.email },
      });

      if (existingUser) {
        throw new Error('Email already exists');
      }
      console.log(data)

      // Create user first
      const user = await tx.user.create({
        data: {
          name: data.name,
          email: data.email,
          phone: data.phone,
          password: data.password,
          role: UserRole.EMPLOYEE,
          isActive: true,
          isVerified: true,
        },
      });

      // Create employee record
      const employee = await tx.employee.create({
        data: {
          designation: data.designation,
          department: data.department,
          permissions: data.permissions,
          userId: user.id,
          createdById: createdById,
          isActive: true,
        },
        include: {
          user: true,
          createdBy: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      });

      return employee;
    });
  }

  async getAdminEmployees(filters: {
    search?: string;
    department?: string;
    designation?: string;
    isActive?: boolean;
    page?: number;
    limit?: number;
  }) {
    const {
      search,
      department,
      designation,
      isActive,
      page = 1,
      limit = 10,
    } = filters;

    const skip = (page - 1) * limit;
    const where: Prisma.EmployeeWhereInput = {
      vendorId: null,
    };

    if (search) {
      where.OR = [
        { user: { name: { contains: search, mode: 'insensitive' } } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
        { designation: { contains: search, mode: 'insensitive' } },
        { department: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (department) {
      where.department = { contains: department, mode: 'insensitive' };
    }

    if (designation) {
      where.designation = { contains: designation, mode: 'insensitive' };
    }

    if (isActive !== undefined) {
      where.isActive = isActive;
    }

    const [employees, total] = await Promise.all([
      prisma.employee.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              isActive: true,
            },
          },
          createdBy: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.employee.count({ where }),
    ]);

    return {
      employees,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async updateAdminEmployee(employeeId: string, data: UpdateEmployeeRequest) {
    return await prisma.$transaction(async (tx) => {
      const employee = await tx.employee.findUnique({
        where: { id: employeeId, vendorId: null },
        include: { user: true },
      });

      if (!employee) {
        throw new Error('Employee not found');
      }

      // Update user data if provided
      if (data.name || data.email || data.phone) {
        await tx.user.update({
          where: { id: employee.userId! },
          data: {
            ...(data.name && { name: data.name }),
            ...(data.email && { email: data.email }),
            ...(data.phone && { phone: data.phone }),
          },
        });
      }

      // Update employee data
      const updatedEmployee = await tx.employee.update({
        where: { id: employeeId },
        data: {
          ...(data.designation && { designation: data.designation }),
          ...(data.department && { department: data.department }),
          ...(data.permissions && { permissions: data.permissions }),
          ...(data.isActive !== undefined && { isActive: data.isActive }),
        },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              isActive: true,
            },
          },
          createdBy: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      });

      return updatedEmployee;
    });
  }

  async toggleAdminEmployeeStatus(employeeId: string) {
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId, vendorId: null },
      include: { user: true },
    });

    if (!employee) {
      throw new Error('Employee not found');
    }

    return await prisma.$transaction(async (tx) => {
      const newStatus = !employee.isActive;
      
      // Toggle employee status
      await tx.employee.update({
        where: { id: employeeId },
        data: { isActive: newStatus },
      });

      // Toggle user status
      await tx.user.update({
        where: { id: employee.userId! },
        data: { isActive: newStatus },
      });

      return { 
        message: `Employee ${newStatus ? 'activated' : 'deactivated'} successfully`,
        isActive: newStatus
      };
    });
  }

  // =============================
  // VENDOR EMPLOYEE MANAGEMENT
  // =============================

  async createVendorEmployee(data: CreateEmployeeRequest, vendorId: string, createdById: string) {
    return await prisma.$transaction(async (tx) => {
      // Check if email already exists
      const existingUser = await tx.user.findUnique({
        where: { email: data.email },
      });

      if (existingUser) {
        throw new Error('Email already exists');
      }

      // Create user first
      const user = await tx.user.create({
        data: {
          name: data.name,
          email: data.email,
          phone: data.phone,
          password: data.password,
          role: UserRole.EMPLOYEE,
          isActive: true,
          isVerified: true,
        },
      });

      // Create employee record with vendor association
      const employee = await tx.employee.create({
        data: {
          designation: data.designation,
          department: data.department,
          permissions: data.permissions,
          userId: user.id,
          vendorId: vendorId,
          createdById: createdById,
          isActive: true,
        },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              isActive: true,
            },
          },
          createdBy: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          vendor: {
            select: {
              id: true,
              storeName: true,
            },
          },
        },
      });

      return employee;
    });
  }

  async getVendorEmployees(vendorId: string, filters: {
    search?: string;
    department?: string;
    designation?: string;
    isActive?: boolean;
    page?: number;
    limit?: number;
  }) {
    const {
      search,
      department,
      designation,
      isActive,
      page = 1,
      limit = 10,
    } = filters;

    const skip = (page - 1) * limit;
    const where: Prisma.EmployeeWhereInput = {
      vendorId: vendorId,
    };

    if (search) {
      where.OR = [
        { user: { name: { contains: search, mode: 'insensitive' } } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
        { designation: { contains: search, mode: 'insensitive' } },
        { department: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (department) {
      where.department = { contains: department, mode: 'insensitive' };
    }

    if (designation) {
      where.designation = { contains: designation, mode: 'insensitive' };
    }

    if (isActive !== undefined) {
      where.isActive = isActive;
    }

    const [employees, total] = await Promise.all([
      prisma.employee.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              isActive: true,
            },
          },
          createdBy: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          vendor: {
            select: {
              id: true,
              storeName: true,
            },
          },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.employee.count({ where }),
    ]);

    return {
      employees,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async updateVendorEmployee(employeeId: string, vendorId: string, data: UpdateEmployeeRequest) {
    return await prisma.$transaction(async (tx) => {
      const employee = await tx.employee.findUnique({
        where: { id: employeeId, vendorId: vendorId },
        include: { user: true },
      });

      if (!employee) {
        throw new Error('Employee not found or not authorized');
      }

      // Update user data if provided
      if (data.name || data.email || data.phone) {
        await tx.user.update({
          where: { id: employee.userId! },
          data: {
            ...(data.name && { name: data.name }),
            ...(data.email && { email: data.email }),
            ...(data.phone && { phone: data.phone }),
          },
        });
      }

      // Update employee data
      const updatedEmployee = await tx.employee.update({
        where: { id: employeeId },
        data: {
          ...(data.designation && { designation: data.designation }),
          ...(data.department && { department: data.department }),
          ...(data.permissions && { permissions: data.permissions }),
          ...(data.isActive !== undefined && { isActive: data.isActive }),
        },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              isActive: true,
            },
          },
          createdBy: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          vendor: {
            select: {
              id: true,
              storeName: true,
            },
          },
        },
      });

      return updatedEmployee;
    });
  }

  async toggleVendorEmployeeStatus(employeeId: string, vendorId: string) {
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId, vendorId: vendorId },
      include: { user: true },
    });

    if (!employee) {
      throw new Error('Employee not found or not authorized');
    }

    return await prisma.$transaction(async (tx) => {
      const newStatus = !employee.isActive;
      
      // Toggle employee status
      await tx.employee.update({
        where: { id: employeeId },
        data: { isActive: newStatus },
      });

      // Toggle user status
      await tx.user.update({
        where: { id: employee.userId! },
        data: { isActive: newStatus },
      });

      return { 
        message: `Employee ${newStatus ? 'activated' : 'deactivated'} successfully`,
        isActive: newStatus
      };
    });
  }

  async getEmployeeById(employeeId: string) {
    return await prisma.employee.findUnique({
      where: { id: employeeId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            isActive: true,
          },
        },
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        vendor: {
          select: {
            id: true,
            storeName: true,
          },
        },
      },
    });
  }

  // =============================
  // EMPLOYEE PERMISSION MANAGEMENT
  // =============================

  async updateEmployeePermissions(employeeId: string, permissions: any, vendorId?: string) {
    const where: Prisma.EmployeeWhereUniqueInput = { id: employeeId };
    
    if (vendorId) {
      where.vendorId = vendorId;
    } else {
      where.vendorId = null;
    }

    const employee = await prisma.employee.findUnique({
      where,
    });

    if (!employee) {
      throw new Error('Employee not found');
    }

    const updatedEmployee = await prisma.employee.update({
      where: { id: employeeId },
      data: { permissions },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            isActive: true,
          },
        },
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        vendor: {
          select: {
            id: true,
            storeName: true,
          },
        },
      },
    });

    return updatedEmployee;
  }

  async getEmployeePermissions(employeeId: string, vendorId?: string) {
    const where: Prisma.EmployeeWhereUniqueInput = { id: employeeId };
    
    if (vendorId) {
      where.vendorId = vendorId;
    } else {
      where.vendorId = null;
    }

    const employee = await prisma.employee.findUnique({
      where,
      select: {
        id: true,
        permissions: true,
        user: {
          select: {
            name: true,
            email: true,
          },
        },
      },
    });

    if (!employee) {
      throw new Error('Employee not found');
    }

    return employee;
  }

  // =============================
  // EMPLOYEE STATISTICS
  // =============================

  async getAdminEmployeeStats() {
    const [totalEmployees, activeEmployees, departments, designations] = await Promise.all([
      prisma.employee.count({ where: { vendorId: null } }),
      prisma.employee.count({ where: { vendorId: null, isActive: true } }),
      prisma.employee.groupBy({
        by: ['department'],
        where: { vendorId: null },
        _count: { _all: true },
      }),
      prisma.employee.groupBy({
        by: ['designation'],
        where: { vendorId: null },
        _count: { _all: true },
      }),
    ]);

    return {
      totalEmployees,
      activeEmployees,
      inactiveEmployees: totalEmployees - activeEmployees,
      byDepartment: departments.reduce((acc: any, curr) => {
        acc[curr.department] = curr._count._all;
        return acc;
      }, {}),
      byDesignation: designations.reduce((acc: any, curr) => {
        acc[curr.designation] = curr._count._all;
        return acc;
      }, {}),
    };
  }

  async getVendorEmployeeStats(vendorId: string) {
    const [totalEmployees, activeEmployees, departments, designations] = await Promise.all([
      prisma.employee.count({ where: { vendorId } }),
      prisma.employee.count({ where: { vendorId, isActive: true } }),
      prisma.employee.groupBy({
        by: ['department'],
        where: { vendorId },
        _count: { _all: true },
      }),
      prisma.employee.groupBy({
        by: ['designation'],
        where: { vendorId },
        _count: { _all: true },
      }),
    ]);

    return {
      totalEmployees,
      activeEmployees,
      inactiveEmployees: totalEmployees - activeEmployees,
      byDepartment: departments.reduce((acc: any, curr) => {
        acc[curr.department] = curr._count._all;
        return acc;
      }, {}),
      byDesignation: designations.reduce((acc: any, curr) => {
        acc[curr.designation] = curr._count._all;
        return acc;
      }, {}),
    };
  }
}