import { folderService } from "../services/vendor.folder.service.ts";
import type { Request, Response } from "express";

export class FolderController {
  
  // Create folder
  async createFolder(req: Request, res: Response) {
    try {
      const vendorId = req.user?.vendorId?.toString();
      if (!vendorId) {
        return res.status(400).json({
          success: false,
          message: "Vendor ID not found",
        });
      }

      const { name, parentPath } = req.body;

      if (!name) {
        return res.status(400).json({
          success: false,
          message: "Folder name is required",
        });
      }

      const folder = await folderService.createFolder(vendorId, name, parentPath);

      res.json({
        success: true,
        folder,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: error.message || "Failed to create folder",
      });
    }
  }

  // Get folders
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

  // Rename folder
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

      const result = await folderService.renameFolder(folderId, vendorId, newName);

      res.json({
        success: true,
        ...result,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: error.message || "Failed to rename folder",
      });
    }
  }

  // Delete folder
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

      const result = await folderService.deleteFolder(folderId, vendorId);

      res.json({
        success: true,
        message: "Folder deleted successfully",
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: error.message || "Failed to delete folder",
      });
    }
  }

  // Move files
  async moveFiles(req: Request, res: Response) {
    try {
      const vendorId = req.user?.vendorId?.toString();
      if (!vendorId) {
        return res.status(400).json({
          success: false,
          message: "Vendor ID not found",
        });
      }

      const { fileIds, targetFolderPath } = req.body;

      if (!Array.isArray(fileIds) || fileIds.length === 0) {
        return res.status(400).json({
          success: false,
          message: "File IDs are required",
        });
      }

      const result = await folderService.moveFilesToFolder(
        fileIds,
        targetFolderPath,
        vendorId
      );

      res.json({
        success: true,
        message: `Moved ${result.movedCount} file(s)`,
        ...result,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: error.message || "Failed to move files",
      });
    }
  }
}

export const folderController = new FolderController();