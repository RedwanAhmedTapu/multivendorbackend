// src/modules/hrm/routes/employeeSections.routes.ts
//
// Nested Employee 360 resources, mounted at /api/hrm/employees (after the
// core profile router — all paths here are two-segment, so nothing collides
// with the profile routes above).
//
//   GET/POST   /:id/family               PUT/DELETE /:id/family/:sectionId
//   GET/POST   /:id/education            PUT/DELETE /:id/education/:sectionId
//   GET/POST   /:id/previous-employment  PUT/DELETE /:id/previous-employment/:sectionId
//   GET/POST   /:id/bank-accounts        PUT/DELETE /:id/bank-accounts/:sectionId
//   GET        /:id/documents            POST /:id/documents (multipart file)
//              PUT/DELETE /:id/documents/:sectionId · POST /:id/documents/:sectionId/verify
//   POST       /:id/photo (multipart)    — replaces the profile photo
//   GET        /:id/history              — career timeline
//   POST       /promotions|transfers|salary-revisions /:id  (+ /:rid/act)
//
// Granular gates (P0): reads ride hrEmployeeView, section writes
// hrEmployeeEdit, document actions their own hrDocs* keys, and the
// salary-revision lifecycle the SENSITIVE hrSalaryEdit gate. Vendor
// isolation is enforced inside the services via the profile scope check.

import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { authenticateUser, authorizeRoles } from "../../../middlewares/auth.middleware.ts";
import { requireHr } from "../../../middlewares/permission.middleware.ts";
import { validate } from "../../../middlewares/vendor.schema.validation.middleware.ts";
import { attachHrScope } from "../utils/hrmScope.ts";
import {
  employeeSectionController,
  employeeDocumentController,
} from "../controllers/employeeSections.controller.ts";
import { employeeLifecycleController } from "../controllers/employeeLifecycle.controller.ts";
import {
  createFamilyMemberSchema, updateFamilyMemberSchema,
  createEducationSchema, updateEducationSchema,
  createPreviousEmploymentSchema, updatePreviousEmploymentSchema,
  createBankAccountSchema, updateBankAccountSchema,
  createDocumentSchema, updateDocumentSchema,
  createPromotionSchema, createTransferSchema, createSalaryRevisionSchema,
  lifecycleActSchema,
} from "../validators/employeeSections.validator.ts";

const router = Router();

router.use(authenticateUser, authorizeRoles("ADMIN", "VENDOR", "EMPLOYEE"), attachHrScope);

const view = requireHr("hrEmployeeView");
const edit = requireHr("hrEmployeeEdit");
const docsUpload = requireHr("hrDocsUpload");
const docsVerify = requireHr("hrDocsVerify");
const docsDelete = requireHr("hrDocsDelete");
const salaryEdit = requireHr("hrSalaryEdit");

// Documents/photos upload through memoryStorage + the shared R2 pipeline.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Express 5's path-to-regexp does not support ":param(regex)" routes, so the
// three lifecycle kinds are declared as explicit literal paths and the kind
// is injected into req.params for the shared controller. Salary revisions
// ride the sensitive hrSalaryEdit gate; promotions/transfers hrEmployeeEdit.
const LIFECYCLE_CREATE_SCHEMAS = {
  promotions: createPromotionSchema,
  transfers: createTransferSchema,
  "salary-revisions": createSalaryRevisionSchema,
} as const;
const LIFECYCLE_KINDS = ["promotions", "transfers", "salary-revisions"] as const;
const asLifecycleKind = (kind: (typeof LIFECYCLE_KINDS)[number]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    (req.params as any).kind = kind;
    next();
  };

for (const kind of LIFECYCLE_KINDS) {
  const gate = kind === "salary-revisions" ? salaryEdit : edit;
  router.post(`/${kind}/:id`, gate, validate(LIFECYCLE_CREATE_SCHEMAS[kind]), asLifecycleKind(kind), employeeLifecycleController.create);
  router.patch(`/${kind}/:id/:sectionId/act`, gate, validate(lifecycleActSchema), asLifecycleKind(kind), employeeLifecycleController.act);
}

// ── Family ───────────────────────────────────────────────────────────────
router.get("/:id/family", view, employeeSectionController.listFamily);
router.post("/:id/family", edit, validate(createFamilyMemberSchema), employeeSectionController.createFamilyMember);
router.put("/:id/family/:sectionId", edit, validate(updateFamilyMemberSchema), employeeSectionController.updateFamilyMember);
router.delete("/:id/family/:sectionId", edit, employeeSectionController.removeFamilyMember);

// ── Education ────────────────────────────────────────────────────────────
router.get("/:id/education", view, employeeSectionController.listEducation);
router.post("/:id/education", edit, validate(createEducationSchema), employeeSectionController.createEducation);
router.put("/:id/education/:sectionId", edit, validate(updateEducationSchema), employeeSectionController.updateEducation);
router.delete("/:id/education/:sectionId", edit, employeeSectionController.removeEducation);

// ── Previous employment ──────────────────────────────────────────────────
router.get("/:id/previous-employment", view, employeeSectionController.listPreviousEmployment);
router.post("/:id/previous-employment", edit, validate(createPreviousEmploymentSchema), employeeSectionController.createPreviousEmployment);
router.put("/:id/previous-employment/:sectionId", edit, validate(updatePreviousEmploymentSchema), employeeSectionController.updatePreviousEmployment);
router.delete("/:id/previous-employment/:sectionId", edit, employeeSectionController.removePreviousEmployment);

// ── Bank / MFS ───────────────────────────────────────────────────────────
router.get("/:id/bank-accounts", view, employeeSectionController.listBankAccounts);
router.post("/:id/bank-accounts", edit, validate(createBankAccountSchema), employeeSectionController.createBankAccount);
router.put("/:id/bank-accounts/:sectionId", edit, validate(updateBankAccountSchema), employeeSectionController.updateBankAccount);
router.delete("/:id/bank-accounts/:sectionId", edit, employeeSectionController.removeBankAccount);

// ── Documents ────────────────────────────────────────────────────────────
router.get("/:id/documents", view, employeeDocumentController.list);
router.post("/:id/documents", docsUpload, upload.single("file"), employeeDocumentController.create);
router.put("/:id/documents/:sectionId", docsUpload, validate(updateDocumentSchema), employeeDocumentController.update);
router.post("/:id/documents/:sectionId/verify", docsVerify, employeeDocumentController.verify);
router.delete("/:id/documents/:sectionId", docsDelete, employeeDocumentController.remove);

// ── Profile photo ────────────────────────────────────────────────────────
router.post("/:id/photo", edit, upload.single("file"), employeeDocumentController.setPhoto);

// ── History timeline ─────────────────────────────────────────────────────
router.get("/:id/history", view, employeeLifecycleController.listHistory);

export default router;
