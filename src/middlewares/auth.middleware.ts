// src/middlewares/auth.middleware.ts
import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../config/prisma.ts";

const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || "access-secret";

// Extend Express Request to include `user`
export interface AuthRequest extends Request {
  user?: {
    id: string;
    role: string;
    email?: string | null;
    name?: string | null;
    vendorId?: string | null;
  };
}

// ------------------- Authenticate User -------------------
export const authenticateUser = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Authorization header missing" });
    }

    const token = authHeader.split(" ")[1];

    let decoded: any;
    try {
      decoded = jwt.verify(token, ACCESS_TOKEN_SECRET);
    } catch (err: any) {
      console.error("JWT verification failed:", err.message);
      return res.status(403).json({ message: "Invalid or expired token" });
    }

    // Look up user in DB
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: {
        id: true,
        role: true,
        email: true,
        name: true,
        vendorId: true,
      },
    });

    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    // Attach user to request
    req.user = {
      id: user.id,
      role: user.role,
      email: user.email,
      name: user.name,
      vendorId: user.vendorId ?? null,
    };

    next();
  } catch (err: any) {
    console.error("Auth middleware error:", err.message);
    return res.status(500).json({ message: "Authentication failed" });
  }
};

// ------------------- Authorize Roles -------------------
export const authorizeRoles = (...roles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      console.log(req.user)
      return res
        .status(403)
        .json({ message: "Forbidden: insufficient permissions" });
    }
    next();
  };
};
