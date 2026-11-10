// src/modules/hrm/hrm.routes.ts
//
// Mount this ONE router in server.ts:
//   import hrmRoutes from "./modules/hrm/hrm.routes.ts";
//   app.use("/api/hrm", hrmRoutes);
//
// Full endpoint map — see README.md for the complete table with descriptions.
// Ten sub-modules, all under /api/hrm:
//   /branches, /departments, /designations   — organization structure
//   /employees                               — employee profiles (core module)
//   /attendance                              — check-in/out, manual marking
//   /leave                                   — leave types, requests, balances
//   /salary                                  — salary structure assign/history
//   /payroll/runs                            — payroll run create/calculate/approve/pay
//   /bonuses, /deductions                    — one-off pay adjustments
//   /loans                                   — loan apply/approve/installments
//   /advances, /expenses                     — advance & expense claim workflows
//   /approvals                               — generic multi-step approval engine
//   /letters                                 — HR letter templates & issuance
//   /resignations                            — resignation, exit clearance, final settlement
//   /performance                             — review cycles, reviews, KPI assignments
//
// Every route (except explicitly self-service ones — check-in/out, "mine"
// endpoints, resignation submit/withdraw) is gated by
// requirePermission("hrManagement") for EMPLOYEE role — see
// permission.middleware.ts. ADMIN and VENDOR (owners) always pass through.

import { Router } from "express";
import branchRoutes from "./routes/branch.routes.ts";
import departmentRoutes from "./routes/department.routes.ts";
import designationRoutes from "./routes/designation.routes.ts";
import employeeProfileRoutes from "./routes/employeeProfile.routes.ts";
import employeeSectionsRoutes from "./routes/employeeSections.routes.ts";
import bootstrapRoutes from "./routes/bootstrap.routes.ts";
import insightsRoutes from "./routes/insights.routes.ts";
import attendanceRoutes from "./routes/attendance.routes.ts";
import leaveRoutes from "./routes/leave.routes.ts";
import salaryStructureRoutes from "./routes/salaryStructure.routes.ts";
import payrollRoutes from "./routes/payroll.routes.ts";
import bonusDeductionRoutes from "./routes/bonusDeduction.routes.ts";
import loanRoutes from "./routes/loan.routes.ts";
import advanceExpenseRoutes from "./routes/advanceExpense.routes.ts";
import approvalRoutes from "./routes/approval.routes.ts";
import letterRoutes from "./routes/letter.routes.ts";
import resignationRoutes from "./routes/resignation.routes.ts";
import performanceRoutes from "./routes/performance.routes.ts";

const router = Router();

// Core employee management
router.use("/branches", branchRoutes);
router.use("/departments", departmentRoutes);
router.use("/designations", designationRoutes);
router.use("/employees", employeeProfileRoutes);
// Employee 360 nested resources (family/education/documents/bank/previous
// employment/history/lifecycle) — two-segment paths only, so mounting on
// the same /employees prefix cannot shadow the profile routes above.
router.use("/employees", employeeSectionsRoutes);
router.use("/attendance", attendanceRoutes);
// Idempotent starter master data (leave types + org tree + shifts)
router.use("/bootstrap", bootstrapRoutes);
// Read-only aggregates (PHASE C2)
router.use("/insights", insightsRoutes);
router.use("/leave", leaveRoutes);

// Compensation
router.use("/salary", salaryStructureRoutes);
router.use("/payroll", payrollRoutes);

// Loans / advances / expenses
router.use("/loans", loanRoutes);

// Cross-cutting
router.use("/approvals", approvalRoutes);
router.use("/letters", letterRoutes);
router.use("/resignations", resignationRoutes);
router.use("/performance", performanceRoutes);

// Catch-all "/" routers MUST be mounted LAST. They carry router-level gates
// (bonusDeduction: requirePermission("hrManagement")) — mounted at "/" above
// the path-prefixed routers, that gate intercepted EVERY later prefix
// (/letters, /approvals, /payroll, /salary, /loans, /resignations,
// /performance) and 403'd granular-permission employees for routes their own
// capabilities allow. Found by the Phase E letters end-to-end run.
router.use("/", bonusDeductionRoutes); // exposes /bonuses, /deductions
router.use("/", advanceExpenseRoutes); // exposes /advances/*, /expenses/*

export default router;
