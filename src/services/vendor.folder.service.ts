import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export class FolderService {
  
  // Create folder
  async createFolder(vendorId: string, folderName: string, parentPath?: string) {
    const path = parentPath 
      ? `${parentPath}/${folderName}`
      : `${vendorId}/${folderName}`;

    // Check if folder exists
    const existing = await prisma.vendorFolder.findUnique({
      where: { path },
    });

    if (existing) {
      throw new Error("Folder already exists");
    }

    return prisma.vendorFolder.create({
      data: {
        vendorId,
        name: folderName,
        path,
        parentPath,
      },
    });
  }

  // Get vendor folders
  async getVendorFolders(vendorId: string) {
    const folders = await prisma.vendorFolder.findMany({
      where: { vendorId, isActive: true },
      orderBy: { createdAt: 'desc' },
    });

    // Count files in each folder
    const foldersWithCounts = await Promise.all(
      folders.map(async (folder) => {
        const fileCount = await prisma.storageFile.count({
          where: {
            vendorId,
            folder: folder.path,
            isActive: true,
          },
        });

        return {
          ...folder,
          fileCount,
        };
      })
    );

    return foldersWithCounts;
  }

  // Rename folder
  async renameFolder(folderId: string, vendorId: string, newName: string) {
    const folder = await prisma.vendorFolder.findFirst({
      where: { id: folderId, vendorId },
    });

    if (!folder) throw new Error("Folder not found");

    const oldPath = folder.path;
    const pathParts = oldPath.split("/");
    pathParts[pathParts.length - 1] = newName;
    const newPath = pathParts.join("/");

    // Update folder
    await prisma.$transaction(async (tx) => {
      await tx.vendorFolder.update({
        where: { id: folderId },
        data: { name: newName, path: newPath },
      });

      // Update all files in this folder
      await tx.storageFile.updateMany({
        where: { folder: oldPath, vendorId },
        data: { folder: newPath },
      });

      // Update all subfolders
      const subfolders = await tx.vendorFolder.findMany({
        where: {
          vendorId,
          parentPath: { startsWith: oldPath },
        },
      });

      for (const subfolder of subfolders) {
        const updatedPath = subfolder.path.replace(oldPath, newPath);
        const updatedParentPath = subfolder.parentPath?.replace(oldPath, newPath);
        
        await tx.vendorFolder.update({
          where: { id: subfolder.id },
          data: {
            path: updatedPath,
            parentPath: updatedParentPath,
          },
        });
      }
    });

    return { success: true, newPath };
  }

  // Delete folder
  async deleteFolder(folderId: string, vendorId: string) {
    const folder = await prisma.vendorFolder.findFirst({
      where: { id: folderId, vendorId },
    });

    if (!folder) throw new Error("Folder not found");

    // Check if folder has files
    const fileCount = await prisma.storageFile.count({
      where: { folder: folder.path, vendorId, isActive: true },
    });

    if (fileCount > 0) {
      throw new Error("Cannot delete folder with files. Move or delete files first.");
    }

    await prisma.vendorFolder.update({
      where: { id: folderId },
      data: { isActive: false },
    });

    return { success: true };
  }

  // Move files to folder
  async moveFilesToFolder(
    fileIds: string[],
    targetFolderPath: string,
    vendorId: string
  ) {
    // Verify all files belong to vendor
    const files = await prisma.storageFile.findMany({
      where: {
        id: { in: fileIds },
        vendorId,
        isActive: true,
      },
    });

    if (files.length !== fileIds.length) {
      throw new Error("Some files not found");
    }

    // Update files
    await prisma.storageFile.updateMany({
      where: {
        id: { in: fileIds },
        vendorId,
      },
      data: {
        folder: targetFolderPath,
      },
    });

    return { success: true, movedCount: files.length };
  }
}

export const folderService = new FolderService();