import { Router } from "express";
import * as ctrl from "../controllers/message.controller.ts";
import {authenticateUser,} from "../../../middlewares/auth.middleware.ts";

const router = Router();
router.use(authenticateUser);

router.post("/", ctrl.send);
router.get("/conversation/:conversationId", ctrl.getList);
router.post("/:messageId/react", ctrl.react);
router.delete("/:messageId", ctrl.remove);

export default router;