// src/modules/hrm/controllers/employeeSections.controller.ts
//
// Controllers for the Employee 360 nested resources. Thin pass-throughs —
// Zod validation has already run (validate() middleware in the route) and
// the services enforce tenant scoping. "not found" service errors map to
// 404 so a cross-tenant id is indistinguishable from a missing one.
//
// Bank/MFS numbers are masked server-side (••••last4) unless the viewer
// holds hrBankView — see getHrCapabilities().

import type { Response } from "express";
import { employeeSectionsService } from "../services/employeeSections.service.ts";
import { employeeDocumentsService } from "../services/employeeDocuments.service.ts";
import { maskAccount } from "../services/employeeProfile.service.ts";
import { getHrCapabilities } from "../../../middlewares/permission.middleware.ts";
import type { HrScopedRequest } from "../utils/hrmScope.ts";

function sendResult(res: Response, status: number, data: unknown) {
  res.status(status).json({ success: true, data });
}

function sendError(res: Response, error: any) {
  const status = /not found/i.test(String(error?.message)) ? 404 : 400;
  res.status(status).json({ success: false, message: error?.message ?? "Request failed" });
}

type Handler = (req: HrScopedRequest, res: Response) => Promise<void>;

function handler(run: (req: HrScopedRequest) => Promise<unknown>, status = 200): Handler {
  return async (req, res) => {
    try {
      sendResult(res, status, await run(req));
    } catch (error: any) {
      sendError(res, error);
    }
  };
}

function maskBankRows(rows: any, bankFull: boolean) {
  if (bankFull || !Array.isArray(rows)) return rows;
  return rows.map((b) => ({
    ...b,
    accountNumber: maskAccount(b.accountNumber),
    mfsNumber: maskAccount(b.mfsNumber),
  }));
}

export const employeeSectionController = {
  // Family
  listFamily: handler((req) => employeeSectionsService.listFamily(req.hrScope, req.params.id)),
  createFamilyMember: handler((req) => employeeSectionsService.createFamilyMember(req.hrScope, req.params.id, req.body), 201),
  updateFamilyMember: handler((req) => employeeSectionsService.updateFamilyMember(req.hrScope, req.params.id, req.params.sectionId, req.body)),
  removeFamilyMember: handler((req) => employeeSectionsService.removeFamilyMember(req.hrScope, req.params.id, req.params.sectionId)),

  // Education
  listEducation: handler((req) => employeeSectionsService.listEducation(req.hrScope, req.params.id)),
  createEducation: handler((req) => employeeSectionsService.createEducation(req.hrScope, req.params.id, req.body), 201),
  updateEducation: handler((req) => employeeSectionsService.updateEducation(req.hrScope, req.params.id, req.params.sectionId, req.body)),
  removeEducation: handler((req) => employeeSectionsService.removeEducation(req.hrScope, req.params.id, req.params.sectionId)),

  // Previous employment
  listPreviousEmployment: handler((req) => employeeSectionsService.listPreviousEmployment(req.hrScope, req.params.id)),
  createPreviousEmployment: handler((req) => employeeSectionsService.createPreviousEmployment(req.hrScope, req.params.id, req.body), 201),
  updatePreviousEmployment: handler((req) => employeeSectionsService.updatePreviousEmployment(req.hrScope, req.params.id, req.params.sectionId, req.body)),
  removePreviousEmployment: handler((req) => employeeSectionsService.removePreviousEmployment(req.hrScope, req.params.id, req.params.sectionId)),

  // Bank / MFS — numbers masked unless the viewer holds hrBankView.
  listBankAccounts: handler(async (req) =>
    maskBankRows(await employeeSectionsService.listBankAccounts(req.hrScope, req.params.id),
      (await getHrCapabilities(req.user)).hrBankView)
  ),
  createBankAccount: handler(async (req) =>
    maskBankRows([await employeeSectionsService.createBankAccount(req.hrScope, req.params.id, req.body)],
      (await getHrCapabilities(req.user)).hrBankView)[0],
    201),
  updateBankAccount: handler(async (req) =>
    maskBankRows([await employeeSectionsService.updateBankAccount(req.hrScope, req.params.id, req.params.sectionId, req.body)],
      (await getHrCapabilities(req.user)).hrBankView)[0]
  ),
  removeBankAccount: handler((req) => employeeSectionsService.removeBankAccount(req.hrScope, req.params.id, req.params.sectionId)),
};

export const employeeDocumentController = {
  list: handler((req) => employeeDocumentsService.list(req.hrScope, req.params.id)),
  /** multipart/form-data: file + metadata fields. */
  create: handler(async (req) => {
    const { category, docType, title, docNumber, issueDate, expiryDate, notes } = req.body;
    return employeeDocumentsService.createFromUpload(
      req.hrScope,
      req.params.id,
      (req as any).file,
      { category, docType, title, docNumber, issueDate, expiryDate, notes },
      req.hrScope.actorUserId
    );
  }, 201),
  update: handler((req) => employeeDocumentsService.update(req.hrScope, req.params.id, req.params.sectionId, req.body)),
  verify: handler((req) => employeeDocumentsService.verify(req.hrScope, req.params.id, req.params.sectionId, req.hrScope.actorUserId)),
  remove: handler((req) => employeeDocumentsService.remove(req.hrScope, req.params.id, req.params.sectionId)),
  /** multipart/form-data: file. Replaces the profile photo. */
  setPhoto: handler(async (req) => {
    return employeeDocumentsService.setProfilePhoto(req.hrScope, req.params.id, (req as any).file);
  }),
};
