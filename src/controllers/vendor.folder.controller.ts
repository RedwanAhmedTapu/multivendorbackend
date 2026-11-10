import { folderService } from "../services/vendor.folder.service.ts";
import type { Request, Response } from "express";

export class FolderController {
  // ─────────────────────────────────────────────────────────────
  // Create folder
  // ─────────────────────────────────────────────────────────────
  async createFolder(req: Request, res: Response) {
    try {
      const vendorId = req.user?.vendorId?.toString();
      if (!vendorId) {
        return res.status(400).json({
          success: false,
          message: "Vendor ID not found",
        });
      }

      const { name, parentId } = req.body;

      if (!name) {
        return res.status(400).json({
          success: false,
          message: "Folder name is required",
        });
      }

      const folder = await folderService.createFolder(vendorId, name, parentId || null);

      res.json({
        success: true,
        folder,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message || "Failed to create folder",
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Get folders (flat, with file/subfolder counts)
  // ─────────────────────────────────────────────────────────────
  async getFolders(req: Request, res: Response) {
    try {
      const vendorId = req.user?.vendorId?.toString();
      if (!vendorId) {
        return res.status(400).json({
          success: false,
          message: "Vendor ID not found",
        });
      }

      const folders = await folderService.getVendorFolders(vendorId);

      res.json({
        success: true,
        folders,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: error.message || "Failed to fetch folders",
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Get folders as nested tree
  // ─────────────────────────────────────────────────────────────
  async getFolderTree(req: Request, res: Response) {
    try {
      const vendorId = req.user?.vendorId?.toString();
      if (!vendorId) {
        return res.status(400).json({
          success: false,
          message: "Vendor ID not found",
        });
      }

      const tree = await folderService.getVendorFolderTree(vendorId);

      res.json({
        success: true,
        tree,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: error.message || "Failed to fetch folder tree",
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Get single folder (with children + files)
  // ─────────────────────────────────────────────────────────────
  async getFolderById(req: Request, res: Response) {
    try {
      const vendorId = req.user?.vendorId?.toString();
      if (!vendorId) {
        return res.status(400).json({
          success: false,
          message: "Vendor ID not found",
        });
      }

      const { folderId } = req.params;

      const folder = await folderService.getFolderById(folderId, vendorId);

      res.json({
        success: true,
        folder,
      });
    } catch (error: any) {
      const status = error.message === "Folder not found" ? 404 : 500;
      res.status(status).json({
        success: false,
        message: error.message || "Failed to fetch folder",
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Rename folder
  // ─────────────────────────────────────────────────────────────
  async renameFolder(req: Request, res: Response) {
    try {
      const vendorId = req.user?.vendorId?.toString();
      if (!vendorId) {
        return res.status(400).json({
          success: false,
          message: "Vendor ID not found",
        });
      }

      const { folderId } = req.params;
      const { newName } = req.body;

      if (!newName) {
        return res.status(400).json({
          success: false,
          message: "newName is required",
        });
      }

      const result = await folderService.renameFolder(folderId, vendorId, newName);

      res.json({
        success: true,
        ...result,
      });
    } catch (error: any) {
      const status = error.message === "Folder not found" ? 404 : 400;
      res.status(status).json({
        success: false,
        message: error.message || "Failed to rename folder",
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Move folder (change parent)
  // ─────────────────────────────────────────────────────────────
  async moveFolder(req: Request, res: Response) {
    try {
      const vendorId = req.user?.vendorId?.toString();
      if (!vendorId) {
        return res.status(400).json({
          success: false,
          message: "Vendor ID not found",
        });
      }

      const { folderId } = req.params;
      const { newParentId } = req.body;

      const result = await folderService.moveFolder(
        folderId,
        vendorId,
        newParentId ?? null
      );

      res.json({
        success: true,
        ...result,
      });
    } catch (error: any) {
      const status = error.message === "Folder not found" ? 404 : 400;
      res.status(status).json({
        success: false,
        message: error.message || "Failed to move folder",
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Delete folder
  // ─────────────────────────────────────────────────────────────
  async deleteFolder(req: Request, res: Response) {
    try {
      const vendorId = req.user?.vendorId?.toString();
      if (!vendorId) {
        return res.status(400).json({
          success: false,
          message: "Vendor ID not found",
        });
      }

      const { folderId } = req.params;

      await folderService.deleteFolder(folderId, vendorId);

      res.json({
        success: true,
        message: "Folder deleted successfully",
      });
    } catch (error: any) {
      const status = error.message === "Folder not found" ? 404 : 400;
      res.status(status).json({
        success: false,
        message: error.message || "Failed to delete folder",
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Move files
  // ─────────────────────────────────────────────────────────────
  async moveFiles(req: Request, res: Response) {
    try {
      const vendorId = req.user?.vendorId?.toString();
      if (!vendorId) {
        return res.status(400).json({
          success: false,
          message: "Vendor ID not found",
        });
      }

      const { fileIds, targetFolderId } = req.body;

      if (!Array.isArray(fileIds) || fileIds.length === 0) {
        return res.status(400).json({
          success: false,
          message: "File IDs are required",
        });
      }

      const result = await folderService.moveFilesToFolder(
        fileIds,
        targetFolderId ?? null,
        vendorId
      );

      res.json({
        success: true,
        message: `Moved ${result.movedCount} file(s)`,
        ...result,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message || "Failed to move files",
      });
    }
  }
}

export const folderController = new FolderController();