// tests/hrm-selfservice.security.test.ts
//
// Security boundary tests for the HRM self-service submissions
// (leave / loan / advance / expense / resignation apply).
//
// Contract under test: a self-service endpoint resolves the acting employee
// STRICTLY from the authenticated session (req.user) and never from
// req.body — so one employee cannot submit actions on behalf of another,
// and ADMIN/VENDOR (who have no real HR identity) are rejected.
//
// These are pure unit tests: the services are mocked with node:test's
// mock.method, so no database connection is ever made. Run with:
//   npx tsx --test tests/hrm-selfservice.security.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { selfEmployeeId } from "../src/modules/hrm/utils/hrmScope.ts";
import { leaveController } from "../src/modules/hrm/controllers/leave.controller.ts";
import { loanController } from "../src/modules/hrm/controllers/loan.controller.ts";
import { advanceController, expenseController } from "../src/modules/hrm/controllers/advanceExpense.controller.ts";
import { resignationController } from "../src/modules/hrm/controllers/resignation.controller.ts";
import { leaveService } from "../src/modules/hrm/services/leave.service.ts";
import { loanService } from "../src/modules/hrm/services/loan.service.ts";
import { advanceService, expenseService } from "../src/modules/hrm/services/advanceExpense.service.ts";
import { resignationService } from "../src/modules/hrm/services/resignation.service.ts";

const SCOPE = { vendorId: null, actorUserId: "U_ME", role: "EMPLOYEE" };

function authUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "EMP_ME",
    rawId: "U_ME",
    role: "EMPLOYEE",
    email: "me@test.local",
    name: "Me",
    vendorId: null,
    employeeId: "EMP_ME",
    ...overrides,
  };
}

function mockReq(user: Record<string, unknown> | undefined, body: Record<string, unknown> = {}) {
  return { hrScope: SCOPE, user, body, params: {}, query: {} } as any;
}

function mockRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  return res;
}

// ── 1. selfEmployeeId helper contract ────────────────────────────

test("selfEmployeeId returns the session's own employee id for EMPLOYEE role", () => {
  const req = mockReq(authUser(), { employeeId: "EMP_SOMEBODY_ELSE" });
  // Even when the body carries a different employeeId, the helper reads
  // only the session — the body is never consulted.
  assert.equal(selfEmployeeId(req), "EMP_ME");
});

test("selfEmployeeId returns null for ADMIN (chat-FK shadow row is not an HR identity)", () => {
  const req = mockReq(authUser({ id: "EMP_SHADOW", role: "ADMIN", employeeId: "EMP_SHADOW" }));
  assert.equal(selfEmployeeId(req), null);
});

test("selfEmployeeId returns null for VENDOR (owners have no Employee row)", () => {
  const req = mockReq(authUser({ id: "VEN_1", rawId: "U_OWNER", role: "VENDOR", employeeId: null, vendorId: "VEN_1" }));
  assert.equal(selfEmployeeId(req), null);
});

test("selfEmployeeId returns null when unauthenticated", () => {
  assert.equal(selfEmployeeId(mockReq(undefined)), null);
});

// ── 2. Per-endpoint: client-provided employeeId is ignored ───────

type Case = {
  name: string;
  call: (req: any, res: any) => Promise<unknown>;
  service: Record<string, (...args: any[]) => unknown>;
  method: string;
  body: Record<string, unknown>;
};

const cases: Case[] = [
  {
    name: "POST /hrm/leave/requests/mine (leaveController.createRequest)",
    call: (req, res) => leaveController.createRequest(req, res),
    service: leaveService as unknown as Record<string, (...args: any[]) => unknown>,
    method: "createRequest",
    body: { leaveTypeId: "LT1", fromDate: "2026-01-01", toDate: "2026-01-02" },
  },
  {
    name: "POST /hrm/loans/apply (loanController.apply)",
    call: (req, res) => loanController.apply(req, res),
    service: loanService as unknown as Record<string, (...args: any[]) => unknown>,
    method: "apply",
    body: { type: "PERSONAL", principal: 10000, installments: 6 },
  },
  {
    name: "POST /hrm/advances/apply (advanceController.apply)",
    call: (req, res) => advanceController.apply(req, res),
    service: advanceService as unknown as Record<string, (...args: any[]) => unknown>,
    method: "apply",
    body: { amount: 5000, installments: 3 },
  },
  {
    name: "POST /hrm/expenses/submit (expenseController.submit)",
    call: (req, res) => expenseController.submit(req, res),
    service: expenseService as unknown as Record<string, (...args: any[]) => unknown>,
    method: "submit",
    body: { category: "TRAVEL", title: "Client visit", amount: 1200 },
  },
  {
    name: "POST /hrm/resignations (resignationController.submit)",
    call: (req, res) => resignationController.submit(req, res),
    service: resignationService as unknown as Record<string, (...args: any[]) => unknown>,
    method: "submit",
    body: { reason: "personal", resignationDate: "2026-03-01" },
  },
];

for (const c of cases) {
  test(`${c.name} — submits as the SESSION employee, ignoring body.employeeId`, async () => {
    const spy = mock.method(c.service, c.method, async (...args: any[]) => ({ mocked: true, args }));
    try {
      // Attacker "ME" tries to submit on behalf of victim "EMP_VICTIM".
      const res = mockRes();
      await c.call(mockReq(authUser(), { ...c.body, employeeId: "EMP_VICTIM" }), res);

      assert.equal(res.statusCode, 201);
      assert.equal(res.body?.success, true);
      assert.equal(spy.mock.callCount(), 1);
      // The service received the session identity, NOT the body identity.
      const data = spy.mock.calls[0].arguments[1];
      assert.equal(data.employeeId, "EMP_ME");
      assert.notEqual(data.employeeId, "EMP_VICTIM");
    } finally {
      spy.mock.restore();
    }
  });

  test(`${c.name} — a legitimate employee submission still works`, async () => {
    const spy = mock.method(c.service, c.method, async (...args: any[]) => ({ mocked: true, args }));
    try {
      const res = mockRes();
      await c.call(mockReq(authUser(), c.body), res);
      assert.equal(res.statusCode, 201);
      assert.equal(spy.mock.calls[0].arguments[1].employeeId, "EMP_ME");
    } finally {
      spy.mock.restore();
    }
  });

  test(`${c.name} — ADMIN (no HR identity) is rejected with 400`, async () => {
    const spy = mock.method(c.service, c.method, async (...args: any[]) => ({ mocked: true, args }));
    try {
      const res = mockRes();
      await c.call(
        mockReq(authUser({ id: "EMP_SHADOW", rawId: "U_ADMIN", role: "ADMIN", employeeId: "EMP_SHADOW" }), {
          ...c.body,
          employeeId: "EMP_VICTIM",
        }),
        res
      );
      assert.equal(res.statusCode, 400);
      assert.match(res.body?.message ?? "", /No employee record/i);
      assert.equal(spy.mock.callCount(), 0);
    } finally {
      spy.mock.restore();
    }
  });

  test(`${c.name} — VENDOR (no HR identity) is rejected with 400`, async () => {
    const spy = mock.method(c.service, c.method, async (...args: any[]) => ({ mocked: true, args }));
    try {
      const res = mockRes();
      await c.call(
        mockReq(authUser({ id: "VEN_1", rawId: "U_OWNER", role: "VENDOR", employeeId: null, vendorId: "VEN_1" }), {
          ...c.body,
          employeeId: "EMP_VICTIM",
        }),
        res
      );
      assert.equal(res.statusCode, 400);
      assert.match(res.body?.message ?? "", /No employee record/i);
      assert.equal(spy.mock.callCount(), 0);
    } finally {
      spy.mock.restore();
    }
  });
}
