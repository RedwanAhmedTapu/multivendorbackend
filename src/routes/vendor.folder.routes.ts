import { Router } from "express";
import { authenticateUser, authorizeRoles } from "../middlewares/auth.middleware.ts";
import { folderController } from "../controllers/vendor.folder.controller.ts";

const router = Router();

router.use(authenticateUser);
router.use(authorizeRoles("VENDOR"));

// Folder routes
router.post("/folders", folderController.createFolder);
router.get("/folders", folderController.getFolders);
router.put("/folders/:folderId/rename", folderController.renameFolder);
router.delete("/folders/:folderId", folderController.deleteFolder);
router.post("/files/move", folderController.moveFiles);

export default router;