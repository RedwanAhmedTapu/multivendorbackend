// src/routes/employee.routes.ts
import { Router } from 'express';
import { EmployeeController } from '../controllers/employee.controller.ts';
import { authenticateUser, authorizeRoles } from '../middlewares/auth.middleware.ts';

const router = Router();
const employeeController = new EmployeeController();

// =============================
// ADMIN EMPLOYEE ROUTES
// =============================

// Create admin employee (Admin only)
router.post(
  '/admin/employees',
  authenticateUser,
  authorizeRoles('ADMIN'),
  employeeController.createAdminEmployee
);

// Get all admin employees (Admin only)
router.get(
  '/admin/employees',
  authenticateUser,
  authorizeRoles('ADMIN'),
  employeeController.getAdminEmployees
);

// Update admin employee (Admin only)
router.put(
  '/admin/employees/:employeeId',
  authenticateUser,
  authorizeRoles('ADMIN'),
  employeeController.updateAdminEmployee
);

// Toggle admin employee status (Admin only)
router.patch(
  '/admin/employees/:employeeId/toggle-status',
  authenticateUser,
  authorizeRoles('ADMIN'),
  employeeController.toggleAdminEmployeeStatus
);

// =============================
// VENDOR EMPLOYEE ROUTES
// =============================

// Create vendor employee (Vendor only)
router.post(
  '/vendor/employees',
  authenticateUser,
  authorizeRoles('VENDOR'),
  employeeController.createVendorEmployee
);

// Get vendor employees (Vendor only)
router.get(
  '/vendor/employees',
  authenticateUser,
  authorizeRoles('VENDOR'),
  employeeController.getVendorEmployees
);

// Update vendor employee (Vendor only)
router.put(
  '/vendor/employees/:employeeId',
  authenticateUser,
  authorizeRoles('VENDOR'),
  employeeController.updateVendorEmployee
);

// Toggle vendor employee status (Vendor only)
router.patch(
  '/vendor/employees/:employeeId/toggle-status',
  authenticateUser,
  authorizeRoles('VENDOR'),
  employeeController.toggleVendorEmployeeStatus
);

// =============================
// EMPLOYEE PERMISSION ROUTES
// =============================

// Update employee permissions (Admin/Vendor)
router.put(
  '/employees/:employeeId/permissions',
  authenticateUser,
  employeeController.updateEmployeePermissions
);

// Get employee permissions (Admin/Vendor)
router.get(
  '/employees/:employeeId/permissions',
  authenticateUser,
  employeeController.getEmployeePermissions
);

// =============================
// EMPLOYEE STATISTICS ROUTES
// =============================

// Get admin employee stats (Admin only)
router.get(
  '/admin/stats',
  authenticateUser,
  authorizeRoles('ADMIN'),
  employeeController.getAdminEmployeeStats
);

// Get vendor employee stats (Vendor only)
router.get(
  '/vendor/stats',
  authenticateUser,
  authorizeRoles('VENDOR'),
  employeeController.getVendorEmployeeStats
);

// =============================
// COMMON ROUTES
// =============================

// Get employee by ID (Admin/Vendor/Employee access)
router.get(
  '/employees/:employeeId',
  authenticateUser,
  employeeController.getEmployee
);

export default router;