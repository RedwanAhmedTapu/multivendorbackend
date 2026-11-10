import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export class FolderService {
  // ─────────────────────────────────────────────────────────────
  // Create folder
  // ─────────────────────────────────────────────────────────────
  async createFolder(vendorId: string, name: string, parentId?: string | null) {
    if (!name || !name.trim()) {
      throw new Error("Folder name is required");
    }

    // If a parent is specified, make sure it exists and belongs to this vendor
    if (parentId) {
      const parent = await prisma.vendorFolder.findFirst({
        where: { id: parentId, vendorId, isActive: true },
      });
      if (!parent) {
        throw new Error("Parent folder not found");
      }
    }

    // Enforce uniqueness of folder name within the same parent (app-level,
    // since there's no more unique path string to rely on)
    const existing = await prisma.vendorFolder.findFirst({
      where: {
        vendorId,
        name: name.trim(),
        parentId: parentId ?? null,
        isActive: true,
      },
    });

    if (existing) {
      throw new Error("A folder with this name already exists here");
    }

    return prisma.vendorFolder.create({
      data: {
        vendorId,
        name: name.trim(),
        parentId: parentId ?? null,
      },
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Get vendor folders (flat list with file counts + child counts)
  // ─────────────────────────────────────────────────────────────
  async getVendorFolders(vendorId: string) {
    const folders = await prisma.vendorFolder.findMany({
      where: { vendorId, isActive: true },
      orderBy: { createdAt: "desc" },
    });

    const foldersWithCounts = await Promise.all(
      folders.map(async (folder) => {
        const [fileCount, childFolderCount] = await Promise.all([
          prisma.storageFile.count({
            where: {
              vendorId,
              folderId: folder.id,
              isActive: true,
            },
          }),
          prisma.vendorFolder.count({
            where: {
              vendorId,
              parentId: folder.id,
              isActive: true,
            },
          }),
        ]);

        return {
          ...folder,
          fileCount,
          childFolderCount,
        };
      })
    );

    return foldersWithCounts;
  }

  // ─────────────────────────────────────────────────────────────
  // Get folders as a nested tree (root folders with children[])
  // ─────────────────────────────────────────────────────────────
  async getVendorFolderTree(vendorId: string) {
    const folders = await this.getVendorFolders(vendorId);

    const byId = new Map<string, any>();
    folders.forEach((f) => byId.set(f.id, { ...f, children: [] }));

    const roots: any[] = [];
    for (const folder of byId.values()) {
      if (folder.parentId && byId.has(folder.parentId)) {
        byId.get(folder.parentId).children.push(folder);
      } else {
        roots.push(folder);
      }
    }

    return roots;
  }

  // ─────────────────────────────────────────────────────────────
  // Get single folder (with immediate children + files)
  // ─────────────────────────────────────────────────────────────
  async getFolderById(folderId: string, vendorId: string) {
    const folder = await prisma.vendorFolder.findFirst({
      where: { id: folderId, vendorId, isActive: true },
      include: {
        children: { where: { isActive: true }, orderBy: { name: "asc" } },
        files: { where: { isActive: true }, orderBy: { createdAt: "desc" } },
      },
    });

    if (!folder) throw new Error("Folder not found");

    return folder;
  }

  // ─────────────────────────────────────────────────────────────
  // Rename folder
  // ─────────────────────────────────────────────────────────────
  async renameFolder(folderId: string, vendorId: string, newName: string) {
    if (!newName || !newName.trim()) {
      throw new Error("New folder name is required");
    }

    const folder = await prisma.vendorFolder.findFirst({
      where: { id: folderId, vendorId },
    });

    if (!folder) throw new Error("Folder not found");

    // Check for a sibling with the same name under the same parent
    const duplicate = await prisma.vendorFolder.findFirst({
      where: {
        vendorId,
        parentId: folder.parentId,
        name: newName.trim(),
        isActive: true,
        id: { not: folderId },
      },
    });

    if (duplicate) {
      throw new Error("A folder with this name already exists here");
    }

    const updated = await prisma.vendorFolder.update({
      where: { id: folderId },
      data: { name: newName.trim() },
    });

    // No path cascading needed anymore — children/files reference this
    // folder by id, which never changes on rename.
    return { success: true, folder: updated };
  }

  // ─────────────────────────────────────────────────────────────
  // Move folder (change its parent — new capability enabled by the
  // id-based hierarchy)
  // ─────────────────────────────────────────────────────────────
  async moveFolder(folderId: string, vendorId: string, newParentId: string | null) {
    const folder = await prisma.vendorFolder.findFirst({
      where: { id: folderId, vendorId },
    });
    if (!folder) throw new Error("Folder not found");

    if (newParentId) {
      if (newParentId === folderId) {
        throw new Error("A folder cannot be its own parent");
      }

      const newParent = await prisma.vendorFolder.findFirst({
        where: { id: newParentId, vendorId, isActive: true },
      });
      if (!newParent) throw new Error("Target parent folder not found");

      // Prevent moving a folder into one of its own descendants
      const isDescendant = await this.isDescendantOf(newParentId, folderId, vendorId);
      if (isDescendant) {
        throw new Error("Cannot move a folder into its own subfolder");
      }
    }

    const duplicate = await prisma.vendorFolder.findFirst({
      where: {
        vendorId,
        parentId: newParentId ?? null,
        name: folder.name,
        isActive: true,
        id: { not: folderId },
      },
    });
    if (duplicate) {
      throw new Error("A folder with this name already exists in the target location");
    }

    const updated = await prisma.vendorFolder.update({
      where: { id: folderId },
      data: { parentId: newParentId ?? null },
    });

    return { success: true, folder: updated };
  }

  // Helper: walk up from `candidateId` to see if `ancestorId` is among its ancestors
  private async isDescendantOf(
    candidateId: string,
    ancestorId: string,
    vendorId: string
  ): Promise<boolean> {
    let currentId: string | null = candidateId;

    while (currentId) {
      if (currentId === ancestorId) return true;

      const current: { parentId: string | null } | null =
        await prisma.vendorFolder.findFirst({
          where: { id: currentId, vendorId },
          select: { parentId: true },
        });

      if (!current) return false;
      currentId = current.parentId;
    }

    return false;
  }

  // ─────────────────────────────────────────────────────────────
  // Delete folder
  // ─────────────────────────────────────────────────────────────
  async deleteFolder(folderId: string, vendorId: string) {
    const folder = await prisma.vendorFolder.findFirst({
      where: { id: folderId, vendorId },
    });

    if (!folder) throw new Error("Folder not found");

    const [fileCount, childCount] = await Promise.all([
      prisma.storageFile.count({
        where: { folderId, vendorId, isActive: true },
      }),
      prisma.vendorFolder.count({
        where: { parentId: folderId, vendorId, isActive: true },
      }),
    ]);

    if (fileCount > 0) {
      throw new Error("Cannot delete folder with files. Move or delete files first.");
    }

    if (childCount > 0) {
      throw new Error("Cannot delete folder with subfolders. Remove subfolders first.");
    }

    await prisma.vendorFolder.update({
      where: { id: folderId },
      data: { isActive: false },
    });

    return { success: true };
  }

  // ─────────────────────────────────────────────────────────────
  // Move files to folder
  // ─────────────────────────────────────────────────────────────
  async moveFilesToFolder(
    fileIds: string[],
    targetFolderId: string | null,
    vendorId: string
  ) {
    // If moving into a folder (not root), verify it exists and belongs to vendor
    if (targetFolderId) {
      const targetFolder = await prisma.vendorFolder.findFirst({
        where: { id: targetFolderId, vendorId, isActive: true },
      });
      if (!targetFolder) {
        throw new Error("Target folder not found");
      }
    }

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

    await prisma.storageFile.updateMany({
      where: {
        id: { in: fileIds },
        vendorId,
      },
      data: {
        folderId: targetFolderId ?? null,
      },
    });

    return { success: true, movedCount: files.length };
  }
}

export const folderService = new FolderService();