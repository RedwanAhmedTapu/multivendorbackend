// ============================================================
// ADD THIS to src/modules/auth/controllers/auth.controller.ts
// (paste near getLastLogin, using the same style/imports already there)
// ============================================================
//
// WHY THIS ENDPOINT EXISTS — read this before wiring the UI:
//
// The JWT (see auth.service.ts generateTokens) intentionally does NOT carry
// permissions or employeeId — only { id, role, vendorId? }. That's correct:
// permissions can change (an admin can revoke a checkbox) without forcing
// everyone to log out, and a JWT with embedded permissions would keep
// working with STALE permissions until it expires.
//
// So the frontend must ask the SERVER "what can I do right now?" on every
// page load — never decode the JWT client-side and never cache permissions
// in localStorage as the source of truth. This endpoint is that single
// source of truth. The sidebar-filtering code later in this package reads
// from this endpoint's response, nothing else.

export const getMe = async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ message: "Unauthorized" });

    // ADMIN / VENDOR are owners — implicitly full access, no permissions
    // object needed. Only EMPLOYEE rows carry a permissions JSON.
    let permissions: Record<string, boolean> | null = null;
    let employeeMeta: { designation: string | null; department: string | null; isActive: boolean } | null = null;

    if (user.role === "EMPLOYEE" && user.employeeId) {
      const employee = await prisma.employee.findUnique({
        where: { id: user.employeeId },
        select: { permissions: true, designation: true, department: true, isActive: true },
      });
      if (!employee || !employee.isActive) {
        return res.status(403).json({ message: "This employee account is inactive" });
      }
      permissions = (employee.permissions ?? {}) as Record<string, boolean>;
      employeeMeta = {
        designation: employee.designation,
        department: employee.department,
        isActive: employee.isActive,
      };
    }

    // Fetch a display name without leaking anything sensitive (no password hash etc).
    const rawUser = await prisma.user.findUnique({
      where: { id: user.rawId },
      select: { id: true, name: true, email: true, phone: true },
    });

    res.status(200).json({
      success: true,
      data: {
        id: user.id, // role-specific effective id (Vendor.id / Employee.id)
        rawId: user.rawId, // the actual User.id
        role: user.role, // ADMIN | VENDOR | EMPLOYEE
        vendorId: user.vendorId ?? null, // null = admin/platform-side
        employeeId: user.employeeId ?? null,
        name: rawUser?.name ?? null,
        email: rawUser?.email ?? null,
        phone: rawUser?.phone ?? null,
        permissions, // null for ADMIN/VENDOR (means "everything"), object for EMPLOYEE
        employeeMeta,
      },
    });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// ============================================================
// ADD THIS ONE LINE to src/modules/auth/routes/auth.routes.ts
// (near getLastLogin's route, same authenticateUser guard)
// ============================================================
//
//   router.get("/me", authenticateUser, (req, res) => getMe(req as any, res));
//
// Resulting endpoint: GET /api/auth/me
// (adjust "/api/auth" to whatever prefix your server.ts mounts auth.routes at)
