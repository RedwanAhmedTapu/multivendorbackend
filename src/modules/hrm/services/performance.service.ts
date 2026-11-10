// src/modules/hrm/services/performance.service.ts
import { prisma } from "../../../config/prisma.ts";
import type { HrScope } from "../types/hrm.types.ts";

export const reviewCycleService = {
  async create(scope: HrScope, data: { name: string; year: number; startDate: string; endDate: string }) {
    return prisma.hrReviewCycle.create({ data: { ...data, vendorId: scope.vendorId } });
  },
  async list(scope: HrScope) {
    return prisma.hrReviewCycle.findMany({ where: { vendorId: scope.vendorId }, orderBy: { year: "desc" } });
  },
  async close(scope: HrScope, id: string) {
    return prisma.hrReviewCycle.update({ where: { id }, data: { status: "CLOSED" } });
  },
};

export const performanceReviewService = {
  async create(scope: HrScope, data: { cycleId: string; employeeId: string; reviewerId?: string }) {
    const existing = await prisma.hrPerformanceReview.findUnique({
      where: { cycleId_employeeId: { cycleId: data.cycleId, employeeId: data.employeeId } },
    });
    if (existing) return existing;
    return prisma.hrPerformanceReview.create({ data: { ...data, vendorId: scope.vendorId } });
  },

  async submit(scope: HrScope, id: string, data: { ratingsJson: Record<string, number>; overallRating: number; managerComments?: string }) {
    const review = await prisma.hrPerformanceReview.findFirst({ where: { id, vendorId: scope.vendorId } });
    if (!review) throw new Error("Review not found");
    return prisma.hrPerformanceReview.update({
      where: { id },
      data: { ...data, status: "SUBMITTED", submittedAt: new Date() },
    });
  },

  async acknowledge(scope: HrScope, id: string, employeeComments: string) {
    const review = await prisma.hrPerformanceReview.findFirst({ where: { id, vendorId: scope.vendorId } });
    if (!review) throw new Error("Review not found");
    if (review.status !== "SUBMITTED") throw new Error("Review must be SUBMITTED before it can be acknowledged");
    return prisma.hrPerformanceReview.update({ where: { id }, data: { employeeComments, status: "ACKNOWLEDGED" } });
  },

  async finalize(scope: HrScope, id: string) {
    return prisma.hrPerformanceReview.update({ where: { id }, data: { status: "FINAL" } });
  },

  async list(scope: HrScope, filters: { cycleId?: string; employeeId?: string; status?: string }) {
    return prisma.hrPerformanceReview.findMany({
      where: { vendorId: scope.vendorId, ...filters },
      include: { cycle: true },
      orderBy: { createdAt: "desc" },
    });
  },
};

export const kpiService = {
  async createTemplate(scope: HrScope, data: { name: string; designationId?: string; itemsJson: Array<{ name: string; target: number; unit: string; weight: number }> }) {
    return prisma.hrKpiTemplate.create({ data: { ...data, vendorId: scope.vendorId } });
  },
  async listTemplates(scope: HrScope) {
    return prisma.hrKpiTemplate.findMany({ where: { vendorId: scope.vendorId, active: true } });
  },

  async assign(scope: HrScope, data: { employeeId: string; templateId?: string; periodLabel: string; dueDate?: string }) {
    return prisma.hrKpiAssignment.create({ data: { ...data, vendorId: scope.vendorId } });
  },

  async submitResults(scope: HrScope, id: string, resultsJson: Array<{ item: string; achieved: number }>) {
    const assignment = await prisma.hrKpiAssignment.findFirst({ where: { id, vendorId: scope.vendorId } });
    if (!assignment) throw new Error("KPI assignment not found");
    return prisma.hrKpiAssignment.update({ where: { id }, data: { resultsJson, status: "SUBMITTED" } });
  },

  async review(scope: HrScope, id: string) {
    const assignment = await prisma.hrKpiAssignment.findFirst({ where: { id, vendorId: scope.vendorId } });
    if (!assignment) throw new Error("KPI assignment not found");
    if (assignment.status !== "SUBMITTED") throw new Error("Must be SUBMITTED before review");
    return prisma.hrKpiAssignment.update({ where: { id }, data: { status: "REVIEWED" } });
  },

  async list(scope: HrScope, filters: { employeeId?: string; status?: string }) {
    return prisma.hrKpiAssignment.findMany({ where: { vendorId: scope.vendorId, ...filters }, orderBy: { createdAt: "desc" } });
  },
};
