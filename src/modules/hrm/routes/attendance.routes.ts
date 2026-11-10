// src/modules/hrm/routes/attendance.routes.ts
import { Router } from "express";
import { z } from "zod";
import { authenticateUser, authorizeRoles } from "../../../middlewares/auth.middleware.ts";
import { requireHr, requirePermission } from "../../../middlewares/permission.middleware.ts";
import { validate } from "../../../middlewares/vendor.schema.validation.middleware.ts";
import { attachHrScope } from "../utils/hrmScope.ts";
import { attendanceController } from "../controllers/attendance.controller.ts";
import { shiftService } from "../services/shift.service.ts";
import { attendanceCorrectionService } from "../services/attendance-correction.service.ts";

const router = Router();

router.use(authenticateUser, authorizeRoles("ADMIN", "VENDOR", "EMPLOYEE"), attachHrScope);

const view = requireHr("hrEmployeeView");
const edit = requireHr("hrEmployeeEdit");
const hrMgmt = requirePermission("hrManagement");

// ── self-service ──
router.post("/check-in", attendanceController.checkIn);
router.post("/check-out", attendanceController.checkOut);

// ── daily attendance ──
router.get("/", view, attendanceController.list);
router.post("/mark", hrMgmt, validate(z.object({
  body: z.object({
    employeeId: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    checkIn: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    checkOut: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    status: z.string().optional(),
    remarks: z.string().optional(),
  }),
})), attendanceController.mark);

router.post("/bulk-mark", hrMgmt, validate(z.object({
  body: z.object({
    employeeIds: z.array(z.string().min(1)).min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
})), attendanceController.bulkMarkPresent);

// Geo-fence simulator: management-side evaluation only — never writes attendance.
router.post("/geo-simulate", edit, validate(z.object({
  body: z.object({
    employeeId: z.string().min(1),
    mode: z.enum(["CHECK_IN", "CHECK_OUT"]),
    latitude: z.number(),
    longitude: z.number(),
    accuracy: z.number().optional(),
  }),
})), attendanceController.geoSimulate);

// ── shift CRUD ──
router.get("/shifts", view, async (req, res) => {
  try {
    const data = await shiftService.list(req.hrScope, (req.query.search as string) || undefined);
    res.json({ success: true, data: { items: data } });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});
router.post("/shifts", edit, async (req, res) => {
  try {
    const shift = await shiftService.create(req.hrScope, req.body);
    res.status(201).json({ success: true, data: shift });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});
router.put("/shifts/:id", edit, async (req, res) => {
  try {
    const shift = await shiftService.update(req.hrScope, req.params.id, req.body);
    res.json({ success: true, data: shift });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});
router.delete("/shifts/:id", edit, async (req, res) => {
  try {
    const result = await shiftService.remove(req.hrScope, req.params.id);
    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ── shift assignments ──
router.get("/shift-assignments", view, async (req, res) => {
  try {
    const data = await shiftService.listAssignments(
      req.hrScope, Number(req.query.page) || 1, Number(req.query.limit) || 50
    );
    res.json({ success: true, ...data });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});
router.post("/shift-assignments", edit, async (req, res) => {
  try {
    const assignment = await shiftService.assign(req.hrScope, req.body, req.hrScope.actorUserId);
    res.status(201).json({ success: true, data: assignment });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ── corrections ──
router.get("/corrections", view, async (req, res) => {
  try {
    const data = await attendanceCorrectionService.list(
      req.hrScope,
      {
        status: (req.query.status as string) || undefined,
        employeeId: (req.query.employeeId as string) || undefined,
      },
      Number(req.query.page) || 1,
      Number(req.query.limit) || 20
    );
    res.json({ success: true, ...data });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});
router.post("/corrections", view, async (req, res) => {
  try {
    const correction = await attendanceCorrectionService.request(req.hrScope, req.body, req.hrScope.actorUserId);
    res.status(201).json({ success: true, data: correction });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});
router.patch("/corrections/:id/act", edit, async (req, res) => {
  try {
    const status = req.body.status === "APPROVED" ? "APPROVED" : "REJECTED";
    const result = await attendanceCorrectionService.act(
      req.hrScope, req.params.id, status, req.hrScope.actorUserId, (req as any).user?.employeeId
    );
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
