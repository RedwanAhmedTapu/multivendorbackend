import { Router } from "express";
import * as ctrl from "../controllers/conversation.controller.ts";
import {authenticateUser,authorizeRoles} from "../../../middlewares/auth.middleware.ts";
import { getSupportQueue } from "../controllers/conversation.controller.ts";
import { blockVendorEmployees, requirePermission } from "../../../middlewares/permission.middleware.ts";
import { staffLookup, staffStart } from "../controllers/staff-chat.controller.ts";

const router = Router();
router.use(authenticateUser);

router.use(authorizeRoles("ADMIN", "EMPLOYEE", "VENDOR", "CUSTOMER", "DELIVERY"));

// Phase 0: conversation administration (status, assignment, labels, notes,
// the support queue, creating a conversation for others) is admin-side support
// work: ADMIN, or an admin-side EMPLOYEE (not a vendor's staff) holding the
// existing customerSupport permission — the same chain the admin order routes use.
const supportStaff = [authorizeRoles("ADMIN", "EMPLOYEE"), blockVendorEmployees, requirePermission("customerSupport")];

router.post("/", ...supportStaff, ctrl.create);
router.post("/find-or-create", ctrl.findOrCreate);
router.get("/", ctrl.getMyList);
router.patch("/:id/status", ...supportStaff, ctrl.updateStatus);

// Admin Support Routes
router.post("/:id/assign", ...supportStaff, ctrl.assign);
router.post("/:id/labels", ...supportStaff, ctrl.addLabel);
router.post("/:id/notes", ...supportStaff, ctrl.addNote);
router.get("/support-queue", ...supportStaff, getSupportQueue);
// Admin inbox "New chat": search, then open or reuse a support conversation.
router.get("/staff-lookup", ...supportStaff, staffLookup);
router.post("/staff-start", ...supportStaff, staffStart);
export default router;