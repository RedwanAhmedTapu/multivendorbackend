// ============================================================
// CRITICAL SECURITY FIXES — apply these BEFORE building any UI on top of
// permissions. Found while wiring the permission-aware sidebar:
//
//   1) PUT  /api/employees/employees/:employeeId/permissions
//   2) GET  /api/employees/employees/:employeeId/permissions
//   3) GET  /api/employees/employees/:employeeId
//
// None of these three routes check the CALLER's role — only
// `authenticateUser` guards them. Concretely, right now:
//
//   - Any logged-in EMPLOYEE (even one with zero permission checkboxes
//     ticked) can call #1 and set their OWN permissions to
//     { hrManagement: true, productManagement: true, ... } — full
//     self-escalation to "can do everything an owner can do".
//   - The same employee can also edit any OTHER employee's permissions
//     within the same vendor (or, for an admin's employee, any admin
//     employee) — lateral escalation / sabotage.
//   - #3 has NO vendorId scoping at all: any authenticated user of ANY
//     role can fetch ANY employee's full profile by id, including staff
//     belonging to a totally unrelated vendor — cross-tenant data leak.
//
// This is exactly the kind of hole a client-side "hide the menu item"
// approach (like the sidebar filtering in this package) can never fix —
// see the comment in usePermissions.ts. Fix the server first.
// ============================================================

// ------------------------------------------------------------
// FIX for src/routes/employee.routes.ts
// ------------------------------------------------------------
//
// Change these two route registrations to add authorizeRoles:
//
//   router.put(
//     '/employees/:employeeId/permissions',
//     authenticateUser,
//     authorizeRoles('ADMIN', 'VENDOR'),   // ← ADD THIS LINE
//     employeeController.updateEmployeePermissions
//   );
//
//   router.get(
//     '/employees/:employeeId/permissions',
//     authenticateUser,
//     authorizeRoles('ADMIN', 'VENDOR'),   // ← ADD THIS LINE
//     employeeController.getEmployeePermissions
//   );
//
// This alone closes the privilege-escalation hole: only an owner (ADMIN
// or VENDOR) can ever view or change any employee's permissions, which is
// exactly what the "Roles & Permissions" sidebar item being OWNER_ONLY
// was assuming was already true server-side.

// ------------------------------------------------------------
// FIX for src/controllers/employee.controller.ts — getEmployee()
// ------------------------------------------------------------
//
// Replace the existing getEmployee method with this scoped version.
// It keeps the route open to ADMIN, VENDOR, and EMPLOYEE (so an employee
// can still view their own record, or their fellow employees under the
// same owner) but rejects cross-tenant reads:

/*
async getEmployee(req: Request, res: Response) {
  try {
    const { employeeId } = req.params;
    const caller = req.user!; // { id, role, vendorId?, employeeId? } from auth.middleware.ts

    if (!employeeId) {
      return res.status(400).json({ success: false, message: 'Employee ID is required' });
    }

    const employee = await employeeService.getEmployeeById(employeeId);
    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    // Scope check: ADMIN sees everyone. VENDOR / a vendor's EMPLOYEE only
    // sees employees under that same vendorId. Admin's own EMPLOYEE only
    // sees employees with vendorId === null (the admin side).
    const callerVendorScope = caller.role === 'ADMIN' ? null : caller.vendorId ?? null;
    const isAdmin = caller.role === 'ADMIN';
    const inScope = isAdmin || employee.vendorId === callerVendorScope;

    if (!inScope) {
      // 404, not 403 — don't confirm to an attacker that the id exists
      // under a different tenant.
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    res.status(200).json({ success: true, data: employee });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
}
*/

// ------------------------------------------------------------
// Same scoping bug exists in getEmployeeById() at the service layer —
// it's a bare findUnique with no vendorId filter, so ANY controller that
// calls it (not just getEmployee above) inherits the leak. If other
// controllers use this same service method, prefer adding the scope
// directly here instead of only at the controller:
// ------------------------------------------------------------

/*
// src/services/employee.service.ts
async getEmployeeById(employeeId: string, scope: { isAdmin: boolean; vendorScope: string | null }) {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    include: { user: { select: { id: true, name: true, email: true, phone: true, isActive: true } }, createdBy: true },
  });
  if (!employee) return null;
  if (!scope.isAdmin && employee.vendorId !== scope.vendorScope) return null; // caller sees "not found"
  return employee;
}
*/
