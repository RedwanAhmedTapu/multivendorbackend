// src/controllers/pos.controller.ts
//
// Vendor POS HTTP layer. The vendor ALWAYS comes from req.vendorScope and the
// acting person ALWAYS from req.posActor — both set by the session gate from
// the authenticated owner/employee (Employee row re-read every request).
// Body/query/path vendorId, staffId and any terminal token are ignored.

import type { Response } from "express";
import { Prisma } from "@prisma/client";
import { posService } from "../services/pos.service.ts";
import { posSubscriptionService } from "../services/pos-subscription.service.ts";
import { AppError } from "../middlewares/error.middleware.ts";
import { posActorCan, type PosActor, type PosRequest } from "../middlewares/pos-auth.middleware.ts";

function scope(req: PosRequest): string {
  if (!req.vendorScope) throw new AppError("Forbidden: vendor access only", 403);
  return req.vendorScope;
}

function actorOf(req: PosRequest): PosActor {
  if (!req.posActor) throw new AppError("Forbidden", 403);
  return req.posActor;
}

// Server-side record of a database failure the client only sees generically.
// Schema identifiers only (error code, model, column/constraint names) — never
// the request body, parameter values, tokens or the raw Prisma message.
const SAFE_PRISMA_META = ["modelName", "column", "target", "field_name", "constraint", "table"];
function logPrismaFailure(res: Response, error: Prisma.PrismaClientKnownRequestError) {
  const meta: Record<string, string> = {};
  for (const k of SAFE_PRISMA_META) {
    const v = (error.meta as Record<string, unknown> | undefined)?.[k];
    if (typeof v === "string") meta[k] = v.slice(0, 120);
    else if (Array.isArray(v)) meta[k] = v.filter((x) => typeof x === "string").join(",").slice(0, 120);
  }
  const req = res.req;
  const route = req ? `${req.method} ${req.baseUrl ?? ""}${req.route?.path ?? ""}` : "POS";
  console.error(`[pos] ${route} failed: Prisma ${error.code}`, meta);
}

function fail(res: Response, error: unknown) {
  if (error instanceof AppError) {
    return res.status(error.statusCode).json({ success: false, message: error.message });
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    logPrismaFailure(res, error);
    const status = error.code === "P2034" ? 409 : error.code === "P2025" ? 404 : 400;
    return res.status(status).json({ success: false, message: status === 409 ? "The store was busy — please try again" : "Request could not be completed" });
  }
  if (error instanceof Error) {
    // Business-rule errors from shared helpers (e.g. insufficient stock).
    return res.status(400).json({ success: false, message: error.message });
  }
  return res.status(500).json({ success: false, message: "Internal server error" });
}

const qstr = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const qdate = (v: unknown) => {
  if (typeof v !== "string" || !v) return undefined;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : undefined;
};

export class PosController {
  // ── lookup ───────────────────────────────────────────────────────────────
  async lookupVariantByCode(req: PosRequest, res: Response) {
    try {
      res.json({ success: true, data: await posService.findVariantByCode(scope(req), String(req.params.code ?? "")) });
    } catch (error) {
      fail(res, error);
    }
  }

  async listProducts(req: PosRequest, res: Response) {
    try {
      const take = req.query.take ? parseInt(String(req.query.take), 10) || 60 : 60;
      res.json({ success: true, data: await posService.listProducts(scope(req), { q: qstr(req.query.q), take }) });
    } catch (error) {
      fail(res, error);
    }
  }

  // ── sales ────────────────────────────────────────────────────────────────
  async createSale(req: PosRequest, res: Response) {
    try {
      const result = await posService.createSale(scope(req), actorOf(req), req.body ?? {});
      res.status(201).json({ success: true, message: "Sale created successfully", data: result });
    } catch (error) {
      fail(res, error);
    }
  }

  async refundSale(req: PosRequest, res: Response) {
    try {
      const result = await posService.refundSale(scope(req), actorOf(req), req.params.id, req.body ?? {});
      res.json({ success: true, message: "Refund processed successfully", data: result });
    } catch (error) {
      fail(res, error);
    }
  }

  async voidSale(req: PosRequest, res: Response) {
    try {
      const result = await posService.voidSale(scope(req), actorOf(req), req.params.id, req.body?.reason);
      res.json({ success: true, message: "Sale voided successfully", data: result });
    } catch (error) {
      fail(res, error);
    }
  }

  async payDue(req: PosRequest, res: Response) {
    try {
      const result = await posService.payDue(scope(req), actorOf(req), req.params.id, req.body ?? {});
      res.json({ success: true, message: "Due payment recorded successfully", data: result });
    } catch (error) {
      fail(res, error);
    }
  }

  async getSale(req: PosRequest, res: Response) {
    try {
      const sale = await posService.getSaleById(scope(req), req.params.id);
      if (!sale) return res.status(404).json({ success: false, message: "Sale not found" });
      res.json({ success: true, data: sale });
    } catch (error) {
      fail(res, error);
    }
  }

  async listSales(req: PosRequest, res: Response) {
    try {
      const { status, customerId, staffId, startDate, endDate, q, page, limit } = req.query;
      const result = await posService.listSales({
        vendorId: scope(req),
        status: (["PAID", "PENDING", "REFUNDED", "VOIDED"] as const).find((s) => s === status),
        customerId: qstr(customerId),
        staffId: qstr(staffId),
        startDate: qdate(startDate),
        endDate: qdate(endDate),
        q: qstr(q)?.slice(0, 50),
        page: page ? parseInt(String(page), 10) || 1 : undefined,
        limit: limit ? parseInt(String(limit), 10) || 20 : undefined,
      });
      res.json({ success: true, ...result });
    } catch (error) {
      fail(res, error);
    }
  }

  async getDashboard(req: PosRequest, res: Response) {
    try {
      const vendorId = scope(req);
      const [summary, subscription] = await Promise.all([
        posService.getDashboardSummary(vendorId),
        posSubscriptionService.getVendorStatus(vendorId),
      ]);
      res.json({ success: true, data: { ...summary, subscription } });
    } catch (error) {
      fail(res, error);
    }
  }

  // ── customers ────────────────────────────────────────────────────────────
  async listCustomers(req: PosRequest, res: Response) {
    try {
      res.json({ success: true, data: await posService.listCustomers(scope(req), qstr(req.query.q)) });
    } catch (error) {
      fail(res, error);
    }
  }

  async getCustomer(req: PosRequest, res: Response) {
    try {
      const customer = await posService.getCustomerById(scope(req), req.params.id);
      if (!customer) return res.status(404).json({ success: false, message: "Customer not found" });
      res.json({ success: true, data: customer });
    } catch (error) {
      fail(res, error);
    }
  }

  async createCustomer(req: PosRequest, res: Response) {
    try {
      const customer = await posService.createCustomer(scope(req), req.body ?? {}, posActorCan(actorOf(req), "posCredit"), actorOf(req));
      res.status(201).json({ success: true, message: "Customer created successfully", data: customer });
    } catch (error) {
      fail(res, error);
    }
  }

  async updateCustomer(req: PosRequest, res: Response) {
    try {
      const customer = await posService.updateCustomer(scope(req), req.params.id, req.body ?? {}, posActorCan(actorOf(req), "posCredit"), actorOf(req));
      res.json({ success: true, message: "Customer updated successfully", data: customer });
    } catch (error) {
      fail(res, error);
    }
  }

  // ── staff ────────────────────────────────────────────────────────────────
  async listStaff(req: PosRequest, res: Response) {
    try {
      res.json({ success: true, data: await posService.listStaff(scope(req)) });
    } catch (error) {
      fail(res, error);
    }
  }

  /** The signed-in person as the POS sees them (for the UI; the server re-checks every call). */
  async me(req: PosRequest, res: Response) {
    try {
      const a = actorOf(req);
      res.json({
        success: true,
        data: { vendorId: scope(req), userId: a.userId, employeeId: a.employeeId, isOwner: a.isOwner, displayName: a.displayName, grants: a.grants },
      });
    } catch (error) {
      fail(res, error);
    }
  }

  // ── bank accounts ────────────────────────────────────────────────────────
  async listBankAccounts(req: PosRequest, res: Response) {
    try {
      res.json({ success: true, data: await posService.listBankAccounts(scope(req)) });
    } catch (error) {
      fail(res, error);
    }
  }

  async createBankAccount(req: PosRequest, res: Response) {
    try {
      const account = await posService.createBankAccount(scope(req), req.body ?? {});
      res.status(201).json({ success: true, message: "Bank account added successfully", data: account });
    } catch (error) {
      fail(res, error);
    }
  }

  // ── settings & subscription ──────────────────────────────────────────────
  async getSettings(req: PosRequest, res: Response) {
    try {
      res.json({ success: true, data: await posService.getOrCreateSettings(scope(req)) });
    } catch (error) {
      fail(res, error);
    }
  }

  async updateSettings(req: PosRequest, res: Response) {
    try {
      const settings = await posService.updateSettings(scope(req), req.body ?? {});
      res.json({ success: true, message: "Settings updated successfully", data: settings });
    } catch (error) {
      fail(res, error);
    }
  }

  async getSubscription(req: PosRequest, res: Response) {
    try {
      res.json({ success: true, data: await posSubscriptionService.getVendorStatus(scope(req)) });
    } catch (error) {
      fail(res, error);
    }
  }
}
