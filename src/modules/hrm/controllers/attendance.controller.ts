// src/modules/hrm/controllers/attendance.controller.ts
import type { Response } from "express";
import type { HrScopedRequest } from "../utils/hrmScope.ts";
import { attendanceService } from "../services/attendance.service.ts";

export const attendanceController = {
  async mark(req: HrScopedRequest, res: Response) {
    try {
      const record = await attendanceService.mark(req.hrScope, req.body);
      res.status(200).json({ success: true, data: record });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async bulkMarkPresent(req: HrScopedRequest, res: Response) {
    try {
      const result = await attendanceService.bulkMarkPresent(
        req.hrScope, req.body.employeeIds, req.body.date, req.hrScope.actorUserId
      );
      res.status(200).json({ success: true, data: result });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async checkIn(req: HrScopedRequest, res: Response) {
    try {
      if (!req.user?.employeeId) {
        res.status(400).json({ success: false, message: "No employee record for this account" });
        return;
      }
      // Optional geo-fence coordinates from the request body.
      const geo = req.body?.lat != null && req.body?.lng != null
        ? { lat: Number(req.body.lat), lng: Number(req.body.lng) }
        : undefined;
      const record = await attendanceService.checkIn(req.hrScope, req.user.employeeId, geo);
      res.status(200).json({ success: true, data: record });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async checkOut(req: HrScopedRequest, res: Response) {
    try {
      if (!req.user?.employeeId) {
        res.status(400).json({ success: false, message: "No employee record for this account" });
        return;
      }
      const geo = req.body?.lat != null && req.body?.lng != null
        ? { lat: Number(req.body.lat), lng: Number(req.body.lng) }
        : undefined;
      const record = await attendanceService.checkOut(req.hrScope, req.user.employeeId, geo);
      res.status(200).json({ success: true, data: record });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  /** Geo-fence simulator: evaluates the fence without writing any record. */
  async geoSimulate(req: HrScopedRequest, res: Response) {
    try {
      const result = await attendanceService.geoSimulate(req.hrScope, req.body);
      res.status(200).json({ success: true, data: result });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async list(req: HrScopedRequest, res: Response) {
    try {
      const result = await attendanceService.list(req.hrScope, req.query as any);
      res.status(200).json({ success: true, ...result });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  },
};
