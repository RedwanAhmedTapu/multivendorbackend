import { Router } from "express";
import * as ctrl from "../controllers/quick-reply.controller.ts";
import {authenticateUser,authorizeRoles} from "../../../middlewares/auth.middleware.ts";

const router = Router();
router.use(authenticateUser);

router.post("/", authorizeRoles("VENDOR"), ctrl.create);
router.patch("/:id",authorizeRoles("VENDOR") , ctrl.update);
router.delete("/:id",authorizeRoles("VENDOR") , ctrl.remove);
router.get("/suggestions", ctrl.getSuggestions); // Anyone can get suggestions
router.get("/", authorizeRoles("VENDOR"), ctrl.listMine); // chat settings: own quick replies incl. inactive

export default router;