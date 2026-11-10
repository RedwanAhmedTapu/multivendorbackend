import { Router } from "express";
import * as ctrl from "../controllers/auto-reply.controller.ts";
import {authenticateUser,authorizeRoles} from "../../../middlewares/auth.middleware.ts";

const router = Router();
router.use(authenticateUser);
router.use(authorizeRoles("VENDOR"));

router.post("/", ctrl.create);
router.patch("/:id", ctrl.update);
router.delete("/:id", ctrl.remove);
router.get("/", ctrl.getList);
router.get("/mine", ctrl.listMine); // chat settings: own rules incl. inactive

export default router;