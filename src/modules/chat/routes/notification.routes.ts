import { Router } from "express";
import * as ctrl from "../controllers/notification.controller.ts";
import {authenticateUser} from "../../../middlewares/auth.middleware.ts";

const router = Router();
router.use(authenticateUser);

router.get("/", ctrl.getSettings);
router.patch("/", ctrl.updateSettings);

export default router;