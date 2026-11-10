// src/modules/hrm/services/approval.service.ts
//
// Generic multi-step approval engine. Any module (Loan, Leave, Expense,
// Promotion...) can call startApprovalRequest() when it creates a record,
// and actOnRequest() when someone approves/rejects — instead of hardcoding
// single-step approve/reject like leave.service.ts and loan.service.ts
// currently do. Those two modules work fine on their own (single approver);
// wire this in only where the client actually needs a multi-person chain
// (e.g. "Loan > 10,000 needs Branch Manager then Finance").
//
// How to wire a module into this engine, e.g. inside loan.service.ts:
//
//   import { approvalService } from "../../hrm/services/approval.service.ts";
//   const loan = await tx.hrLoan.create({ ... });
//   const request = await approvalService.startRequest(scope, {
//     processType: "LOAN", entityType: "HrLoan", entityId: loan.id, requestedBy: actorUserId,
//   });
//   // if `request` is null, no workflow is configured for LOAN — fall back
//   // to the module's own single-step actOn().

import { prisma } from "../../../config/prisma.ts";
import type { HrScope } from "../types/hrm.types.ts";

export const approvalService = {
  // ── Workflow configuration (admin/vendor sets this up once) ──
  async createWorkflow(
    scope: HrScope,
    data: {
      name: string;
      processType: string;
      steps: Array<{ sequence: number; name: string; approverRole?: string; approverUserId?: string; amountThreshold?: number; required?: boolean }>;
    }
  ) {
    const existing = await prisma.hrApprovalWorkflow.findUnique({
      where: { vendorId_processType: { vendorId: scope.vendorId as any, processType: data.processType } },
    });
    if (existing) throw new Error(`A workflow for ${data.processType} already exists`);

    return prisma.hrApprovalWorkflow.create({
      data: {
        vendorId: scope.vendorId,
        name: data.name,
        processType: data.processType,
        steps: { create: data.steps },
      },
      include: { steps: { orderBy: { sequence: "asc" } } },
    });
  },

  async listWorkflows(scope: HrScope) {
    return prisma.hrApprovalWorkflow.findMany({
      where: { vendorId: scope.vendorId },
      include: { steps: { orderBy: { sequence: "asc" } } },
    });
  },

  async getWorkflowForProcess(scope: HrScope, processType: string) {
    return prisma.hrApprovalWorkflow.findFirst({
      where: { vendorId: scope.vendorId, processType, active: true },
      include: { steps: { orderBy: { sequence: "asc" } } },
    });
  },

  // ── Request lifecycle ──
  /** Returns null if no active workflow exists for this processType — caller should fall back to a direct single-step decision. */
  async startRequest(
    scope: HrScope,
    input: { processType: string; entityType: string; entityId: string; requestedBy: string }
  ) {
    const workflow = await this.getWorkflowForProcess(scope, input.processType);
    if (!workflow || workflow.steps.length === 0) return null;

    return prisma.hrApprovalRequest.create({
      data: {
        vendorId: scope.vendorId,
        workflowId: workflow.id,
        processType: input.processType,
        entityType: input.entityType,
        entityId: input.entityId,
        requestedBy: input.requestedBy,
        currentStep: workflow.steps[0].sequence,
        status: "PENDING",
      },
    });
  },

  async listPending(scope: HrScope, processType?: string) {
    return prisma.hrApprovalRequest.findMany({
      where: { vendorId: scope.vendorId, status: "PENDING", ...(processType ? { processType } : {}) },
      include: { actions: { orderBy: { createdAt: "asc" } } },
      orderBy: { createdAt: "asc" },
    });
  },

  async getById(scope: HrScope, id: string) {
    const request = await prisma.hrApprovalRequest.findFirst({
      where: { id, vendorId: scope.vendorId },
      include: { actions: { orderBy: { createdAt: "asc" } } },
    });
    if (!request) throw new Error("Approval request not found");
    return request;
  },

  /** Approve/reject the current step. On the last step's approval, the whole request completes. */
  async actOnRequest(
    scope: HrScope,
    requestId: string,
    input: { action: "APPROVE" | "REJECT" | "SKIP"; comment?: string },
    userId: string
  ) {
    const request = await prisma.hrApprovalRequest.findFirst({
      where: { id: requestId, vendorId: scope.vendorId },
      include: { actions: true },
    });
    if (!request) throw new Error("Approval request not found");
    if (request.status !== "PENDING") throw new Error("This request has already been completed");

    const workflow = await prisma.hrApprovalWorkflow.findUnique({
      where: { id: request.workflowId },
      include: { steps: { orderBy: { sequence: "asc" } } },
    });
    if (!workflow) throw new Error("Workflow not found");

    return prisma.$transaction(async (tx) => {
      await tx.hrApprovalAction.create({
        data: { requestId, step: request.currentStep, userId, action: input.action, comment: input.comment },
      });

      if (input.action === "REJECT") {
        return tx.hrApprovalRequest.update({
          where: { id: requestId },
          data: { status: "REJECTED", completedAt: new Date() },
        });
      }

      const isLastStep = request.currentStep >= Math.max(...workflow.steps.map((s) => s.sequence));
      if (isLastStep) {
        return tx.hrApprovalRequest.update({
          where: { id: requestId },
          data: { status: "APPROVED", completedAt: new Date() },
        });
      }

      const nextStep = workflow.steps.find((s) => s.sequence > request.currentStep)?.sequence ?? request.currentStep + 1;
      return tx.hrApprovalRequest.update({ where: { id: requestId }, data: { currentStep: nextStep } });
    });
  },
};
