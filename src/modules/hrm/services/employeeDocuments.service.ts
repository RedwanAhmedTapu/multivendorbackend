// src/modules/hrm/services/employeeDocuments.service.ts
//
// Employee documents + profile photo for the Employee 360 page.
//
// Storage reuses the EXISTING Cloudflare R2 pipeline (lib/cloudflare-r2.ts —
// the same uploadToR2/deleteFromR2 every other module uses). Unlike the
// generic /api/upload route, the storage key is derived SERVER-SIDE from
// the authenticated scope and the profile ownership check, so one tenant
// can never write into another tenant's prefix:
//
//   hr/{vendorId | "platform"}/{employeeProfileId}/documents/<ts>-<name>
//   hr/{vendorId | "platform"}/{employeeProfileId}/photo/<ts>-<name>
//
// The DB stores the relative key in fileUrl/photoUrl; the public URL is
// `${R2_PUBLIC_DOMAIN}/${key}` at render time (same convention as products).

import { prisma } from "../../../config/prisma.ts";
import { uploadToR2, deleteFromR2 } from "../../../lib/cloudflare-r2.ts";
import { employeeProfileService } from "./employeeProfile.service.ts";
import { EmployeeNotFoundError } from "./employeeSections.service.ts";
import type { HrScope } from "../types/hrm.types.ts";

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/webp", "image/heic",
  "application/pdf",
]);

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-80) || "file";
}

function filePrefix(scope: HrScope, employeeId: string, kind: "documents" | "photo") {
  return `hr/${scope.vendorId ?? "platform"}/${employeeId}/${kind}`;
}

async function assertEmployee(scope: HrScope, employeeId: string) {
  const profile = await employeeProfileService.findScopedProfile(scope, employeeId);
  if (!profile) throw new EmployeeNotFoundError();
  return profile;
}

export const employeeDocumentsService = {
  async list(scope: HrScope, employeeId: string) {
    await assertEmployee(scope, employeeId);
    return prisma.hrEmployeeDocument.findMany({ where: { employeeId }, orderBy: { createdAt: "desc" } });
  },

  /** Upload a file to R2 and create the document row in one call. */
  async createFromUpload(
    scope: HrScope,
    employeeId: string,
    file: { buffer: Buffer; originalname: string; mimetype: string; size: number } | undefined,
    data: {
      category?: string; docType: string; title: string; docNumber?: string;
      issueDate?: string; expiryDate?: string; notes?: string;
    },
    actorUserId: string
  ) {
    await assertEmployee(scope, employeeId);

    if (!file) throw new Error("A document file is required");
    if (!ALLOWED_MIME.has(file.mimetype)) throw new Error("Only PDF or image files (JPEG/PNG/WebP/HEIC) are allowed");
    if (file.size > MAX_FILE_BYTES) throw new Error("File exceeds the 10 MB limit");

    const key = `${filePrefix(scope, employeeId, "documents")}/${Date.now()}-${safeFileName(file.originalname)}`;
    await uploadToR2({
      file: file.buffer,
      key,
      contentType: file.mimetype,
      vendorId: scope.vendorId ?? "platform",
    });

    return prisma.hrEmployeeDocument.create({
      data: {
        vendorId: scope.vendorId,
        employeeId,
        category: data.category ?? "IDENTITY",
        docType: data.docType,
        title: data.title,
        docNumber: data.docNumber,
        issueDate: data.issueDate,
        expiryDate: data.expiryDate,
        notes: data.notes,
        fileUrl: key,
        verified: false,
      },
    });
  },

  /** Edit metadata only — the file itself is replaced by deleting + re-uploading. */
  async update(scope: HrScope, employeeId: string, documentId: string, data: Record<string, unknown>) {
    await assertEmployee(scope, employeeId);
    const existing = await prisma.hrEmployeeDocument.findFirst({ where: { id: documentId, employeeId } });
    if (!existing) throw new Error("Document not found");
    return prisma.hrEmployeeDocument.update({ where: { id: documentId }, data });
  },

  async verify(scope: HrScope, employeeId: string, documentId: string, actorUserId: string) {
    await assertEmployee(scope, employeeId);
    const existing = await prisma.hrEmployeeDocument.findFirst({ where: { id: documentId, employeeId } });
    if (!existing) throw new Error("Document not found");
    return prisma.hrEmployeeDocument.update({
      where: { id: documentId },
      data: { verified: true, verifiedBy: actorUserId, verifiedAt: new Date() },
    });
  },

  async remove(scope: HrScope, employeeId: string, documentId: string) {
    await assertEmployee(scope, employeeId);
    const existing = await prisma.hrEmployeeDocument.findFirst({ where: { id: documentId, employeeId } });
    if (!existing) throw new Error("Document not found");

    await prisma.hrEmployeeDocument.delete({ where: { id: documentId } });

    // Best-effort storage cleanup — a relative key only (full URLs point at
    // files uploaded through other flows; leave those alone).
    if (existing.fileUrl && !/^https?:\/\//i.test(existing.fileUrl)) {
      try {
        await deleteFromR2(existing.fileUrl);
      } catch (err) {
        console.warn(`[HRM] Failed to delete R2 object ${existing.fileUrl}:`, err);
      }
    }
    return { removed: true };
  },

  /** Replace (or set) the profile photo. */
  async setProfilePhoto(
    scope: HrScope,
    employeeId: string,
    file: { buffer: Buffer; originalname: string; mimetype: string; size: number } | undefined
  ) {
    await assertEmployee(scope, employeeId);

    if (!file) throw new Error("A photo file is required");
    if (!file.mimetype.startsWith("image/")) throw new Error("Only image files are allowed");
    if (file.size > MAX_FILE_BYTES) throw new Error("File exceeds the 10 MB limit");

    const key = `${filePrefix(scope, employeeId, "photo")}/${Date.now()}-${safeFileName(file.originalname)}`;
    await uploadToR2({
      file: file.buffer,
      key,
      contentType: file.mimetype,
      vendorId: scope.vendorId ?? "platform",
    });

    const previous = await prisma.hrEmployeeProfile.findUnique({ where: { id: employeeId }, select: { photoUrl: true } });
    await prisma.hrEmployeeProfile.update({ where: { id: employeeId }, data: { photoUrl: key } });

    if (previous?.photoUrl && !/^https?:\/\//i.test(previous.photoUrl) && previous.photoUrl !== key) {
      try {
        await deleteFromR2(previous.photoUrl);
      } catch (err) {
        console.warn(`[HRM] Failed to delete previous photo ${previous.photoUrl}:`, err);
      }
    }
    return { photoUrl: key };
  },
};
