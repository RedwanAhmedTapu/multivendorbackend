import { Router } from "express";
import { authenticateUser, authorizeRoles } from "../middlewares/auth.middleware.ts";
import { folderController } from "../controllers/vendor.folder.controller.ts";

const router = Router();

router.use(authenticateUser);
router.use(authorizeRoles("VENDOR"));

// Folder routes
router.post("/folders", folderController.createFolder);
router.get("/folders", folderController.getFolders);
router.get("/folders/tree", folderController.getFolderTree);
router.get("/folders/:folderId", folderController.getFolderById);
router.put("/folders/:folderId/rename", folderController.renameFolder);
router.put("/folders/:folderId/move", folderController.moveFolder);
router.delete("/folders/:folderId", folderController.deleteFolder);

// File routes
router.post("/files/move", folderController.moveFiles);

export default router;