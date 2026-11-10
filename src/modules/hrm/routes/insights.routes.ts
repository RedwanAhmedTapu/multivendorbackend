// src/modules/hrm/routes/insights.routes.ts
//
// Read-only aggregate endpoints (PHASE C2), mounted at /api/hrm/insights.
// Every route: authenticateUser → authorizeRoles(ADMIN,VENDOR,EMPLOYEE) →
// attachHrScope → requireHr("hrEmployeeView"). Tenant scoping is inside the
// service queries; cross-tenant data simply does not exist in the result.

import { Router } from "express";
import { authenticateUser, authorizeRoles } from "../../../middlewares/auth.middleware.ts";
import { requireHr, getHrCapabilities } from "../../../middlewares/permission.middleware.ts";
import { attachHrScope } from "../utils/hrmScope.ts";
import { insightsService } from "../services/insights.service.ts";

const router = Router();

router.use(authenticateUser, authorizeRoles("ADMIN", "VENDOR", "EMPLOYEE"), attachHrScope);

const view = requireHr("hrEmployeeView");

router.get("/branch-counts", view, async (req, res) => {
  try {
    res.json({ success: true, data: await insightsService.branchCounts(req.hrScope) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.get("/designation-counts", view, async (req, res) => {
  try {
    res.json({ success: true, data: await insightsService.designationCounts(req.hrScope) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.get("/new-joiners", view, async (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    res.json({ success: true, data: await insightsService.newJoiners(req.hrScope, days) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Express 5's path-to-regexp rejects ":param(regex)" — declare the three
// lifecycle kinds explicitly and inject the kind for the shared handler.
const LIFECYCLE_KINDS = ["promotions", "transfers", "salary-revisions"] as const;
const asLifecycleKind = (kind: (typeof LIFECYCLE_KINDS)[number]) =>
  (req: { params: Record<string, string> }, _res: unknown, next: () => void) => {
    req.params.kind = kind;
    next();
  };

for (const kind of LIFECYCLE_KINDS) {
  router.get(`/lifecycle/${kind}`, view, asLifecycleKind(kind), async (req, res) => {
    try {
      // Salary amounts are stripped server-side unless the viewer holds
      // hrSalaryView — the UI can never receive confidential numbers to hide.
      const caps = await getHrCapabilities((req as any).user);
      const data = await insightsService.lifecycle(req.hrScope, kind, {
        search: req.query.search as string | undefined,
        page: Number(req.query.page) || 1,
        limit: Number(req.query.limit) || 20,
        salaryView: caps.hrSalaryView,
      });
      res.json({ success: true, ...data });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  });
}

router.get("/reporting-structure", view, async (req, res) => {
  try {
    res.json({ success: true, data: await insightsService.reportingStructure(req.hrScope) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.get("/shifts", view, async (req, res) => {
  try {
    res.json({ success: true, data: await insightsService.shiftsOverview(req.hrScope) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.get("/shift-assignments", view, async (req, res) => {
  try {
    res.json({
      success: true,
      ...await insightsService.shiftAssignments(
        req.hrScope,
        Number(req.query.page) || 1,
        Number(req.query.limit) || 50
      ),
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// == PHASE D2: HR Reports / Analytics / Audit ============================

router.get("/reports/employees", view, async (req, res) => {
  try {
    const data = await insightsService.employeesReport(req.hrScope, {
      view: (req.query.view as any) || "register",
      statuses: req.query.statuses ? String(req.query.statuses).split(",") : undefined,
      branchId: (req.query.branchId as string) || undefined,
      departmentId: (req.query.departmentId as string) || undefined,
      search: (req.query.search as string) || undefined,
      joiningFrom: (req.query.joiningFrom as string) || undefined,
      joiningTo: (req.query.joiningTo as string) || undefined,
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 50,
    });
    res.json({ success: true, ...data });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.get("/reports/attendance", view, async (req, res) => {
  try {
    const data = await insightsService.attendanceReport(req.hrScope, {
      fromDate: (req.query.fromDate as string) || undefined,
      toDate: (req.query.toDate as string) || undefined,
      status: (req.query.status as string) || undefined,
      employeeId: (req.query.employeeId as string) || undefined,
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 50,
    });
    res.json({ success: true, ...data });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.get("/reports/leave", view, async (req, res) => {
  try {
    const data = await insightsService.leaveReport(req.hrScope, {
      status: (req.query.status as string) || undefined,
      fromDate: (req.query.fromDate as string) || undefined,
      toDate: (req.query.toDate as string) || undefined,
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 50,
    });
    res.json({ success: true, ...data });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.get("/reports/leave-balances", view, async (req, res) => {
  try {
    const data = await insightsService.leaveBalancesReport(req.hrScope, {
      year: req.query.year ? Number(req.query.year) : undefined,
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 50,
    });
    res.json({ success: true, ...data });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.get("/department-counts", view, async (req, res) => {
  try {
    res.json({ success: true, data: await insightsService.departmentCounts(req.hrScope) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.get("/attendance-trend", view, async (req, res) => {
  try {
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 14));
    res.json({ success: true, data: await insightsService.attendanceTrend(req.hrScope, days) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// HR Calendar (PHASE D3) - events derived from existing data only.
router.get("/calendar", view, async (req: any, res) => {
  try {
    const from = (req.query.from as string) || new Date().toISOString().slice(0, 10);
    const to = (req.query.to as string) || from;
    const caps = await getHrCapabilities(req.user);
    const data = await insightsService.calendar(req.hrScope, { from, to, salaryView: caps.hrSalaryView });
    res.json({ success: true, ...data });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Audit trail: PLATFORM resource (AuditLog has no tenant column) - ADMIN only.
router.get("/audit", authorizeRoles("ADMIN"), async (req, res) => {
  try {
    const data = await insightsService.auditList({
      entity: (req.query.entity as string) || undefined,
      search: (req.query.search as string) || undefined,
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 50,
    });
    res.json({ success: true, ...data });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
