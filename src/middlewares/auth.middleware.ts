import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../config/prisma.ts";

// ── 1. Fail-closed: kono hardcoded fallback nai ───────────────
const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET;
if (!ACCESS_TOKEN_SECRET) {
  throw new Error("ACCESS_TOKEN_SECRET is required");
}

// ── 2. Strict token shape (any eliminate) ─────────────────────
interface TokenPayload {
  id: string;        // User.id
  role: string;
  iat: number;
  exp: number;
}

function isValidPayload(decoded: unknown): decoded is TokenPayload {
  if (typeof decoded !== "object" || decoded === null) return false;
  const d = decoded as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    typeof d.role === "string" &&
    typeof d.iat === "number" &&
    typeof d.exp === "number"
  );
}

// ── 3. Auth types ─────────────────────────────────────────────
export interface AuthUser {
  id: string;        // Role-specific ID
  rawId: string;     // User table ID
  role: string;
  email: string | null;
  name: string | null;
  vendorId: string | null;
  employeeId: string | null;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

// ── 3b. Admin auto-provision helper ────────────────────────────
// ADMIN accounts don't go through the "create employee" flow the way real
// staff do — there's no manual step for a superadmin to get an Employee
// row. But ConversationParticipant.employeeId and Message.senderEmployeeId
// are real FKs to Employee, so an ADMIN needs a real Employee row to
// directly participate in / send chat messages (separately from
// ConversationAssignment.assigneeId, which has no FK and already works
// for "assign to me" without this).
//
// This transparently creates that row on first use. Two concurrent
// requests can both miss the initial findFirst and both attempt create();
// Employee.userId is @unique, so the loser gets a P2002 — caught and
// resolved by re-fetching rather than failing the request.
async function getOrCreateAdminEmployee(
  userId: string
): Promise<{ id: string; vendorId: string | null } | null> {
  const existing = await prisma.employee.findFirst({
    where: { userId, isActive: true },
    select: { id: true, vendorId: true },
  });
  if (existing) return existing;

  try {
    return await prisma.employee.create({
      data: {
        userId,
        designation: "Admin",
        permissions: {},
        isActive: true,
      },
      select: { id: true, vendorId: true },
    });
  } catch (err: any) {
    // Lost the create race to a concurrent request — the row exists now.
    if (err.code === "P2002") {
      const winner = await prisma.employee.findFirst({
        where: { userId, isActive: true },
        select: { id: true, vendorId: true },
      });
      if (winner) return winner;
    }
    console.error("[Auth] Failed to auto-provision admin Employee row:", err);
    return null;
  }
}

// ── 4. Main middleware ────────────────────────────────────────
export const authenticateUser = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    // Verify with explicit algorithm (prevent algorithm confusion)
    let decoded: unknown;
    try {
      decoded = jwt.verify(token, ACCESS_TOKEN_SECRET, {
        algorithms: ["HS256"],
      });
    } catch {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    if (!isValidPayload(decoded)) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    const normalizedRole = decoded.role.toUpperCase();

    // ── 5. DB verification (token tamper protection) ──────────
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        vendorId: true,
      },
    });

    if (!user || !user.isActive) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    // ── 6. Role escalation prevention ─────────────────────────
    const dbRole = user.role.toUpperCase();
    if (normalizedRole !== dbRole) {
      res.status(403).json({ message: "Forbidden" });
      return;
    }

    // ── 7. Resolve role-specific IDs from DB ──────────────────
    let effectiveId = user.id;
    let vendorId: string | null = null;
    let employeeId: string | null = null;
    let name = user.name;
    let email = user.email;

    switch (normalizedRole) {
      case "VENDOR": {
        if (!user.vendorId) {
          res.status(403).json({ message: "Forbidden" });
          return;
        }
        const vendor = await prisma.vendor.findUnique({
          where: { id: user.vendorId },
          select: { id: true, storeName: true, email: true },
        });
        if (!vendor) {
          res.status(403).json({ message: "Forbidden" });
          return;
        }
        effectiveId = vendor.id;
        vendorId = vendor.id;
        name = vendor.storeName ?? name;
        email = vendor.email ?? email;
        break;
      }

      case "EMPLOYEE": {
        // Real staff created via the admin's "create employee" flow.
        // No auto-provisioning here — a missing row means something is
        // genuinely wrong (deactivated, deleted, or never linked), so
        // this stays strict.
        const employee = await prisma.employee.findFirst({
          where: { userId: user.id, isActive: true },
          select: { id: true, vendorId: true },
        });
        if (!employee) {
          res.status(403).json({ message: "Forbidden" });
          return;
        }
        effectiveId = employee.id;
        employeeId = employee.id;
        vendorId = employee.vendorId;
        break;
      }

      case "ADMIN": {
        // Admin can chat directly (needs a real Employee.id for the FK
        // columns) AND separately assign conversations to other real
        // employees (ConversationAssignment.assigneeId has no FK, so that
        // path already works regardless of this). Auto-provision instead
        // of blocking, since there's no manual setup step for admins.
        const employee = await getOrCreateAdminEmployee(user.id);
        if (!employee) {
          // DB failure during provisioning — fail closed rather than let
          // the admin through with a broken employeeId.
          res.status(500).json({ message: "Internal server error" });
          return;
        }
        effectiveId = employee.id;
        employeeId = employee.id;
        vendorId = employee.vendorId;
        break;
      }

      case "CUSTOMER":
      default:
        effectiveId = user.id;
        break;
    }

    req.user = {
      id: effectiveId,
      rawId: user.id,
      role: normalizedRole,
      email,
      name,
      vendorId,
      employeeId,
    };

    next();
  } catch (err) {
    console.error("[Auth] Unexpected error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// ── 8. Role guard ─────────────────────────────────────────────
export const authorizeRoles = (...allowedRoles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    const userRole = req.user.role.toUpperCase();
    const normalizedAllowed = allowedRoles.map((r) => r.toUpperCase());

    if (!normalizedAllowed.includes(userRole)) {
      res.status(403).json({ message: "Forbidden: insufficient permissions" });
      return;
    }

    next();
  };
};