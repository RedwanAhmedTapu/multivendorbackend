import { Router } from "express";
import * as ctrl from "../controllers/read-receipt.controller.ts";
import { authenticateUser } from "../../../middlewares/auth.middleware.ts";

const router = Router();
router.use(authenticateUser); 

router.post("/", ctrl.markAsRead);

export default router;