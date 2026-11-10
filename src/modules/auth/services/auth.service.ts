import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../../../config/prisma.ts";
import { UserRole } from "@prisma/client";

// ── Fail-closed: no hardcoded fallback secret. A missing env var must crash
// startup, not silently sign tokens with a well-known default string that
// anyone reading this source file (or its git history) could forge. ──
const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET;
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET;
if (!ACCESS_TOKEN_SECRET) throw new Error("ACCESS_TOKEN_SECRET is required");
if (!REFRESH_TOKEN_SECRET) throw new Error("REFRESH_TOKEN_SECRET is required");

// ------------------- Generate Tokens -------------------
export const generateTokens = (user: any) => {
  const payload: any = {
    id: user.id,
    role: user.role,
    emailorphone: user.email ?? user.phone ?? null,
  };
  if (user.role === "VENDOR" && user.vendorId) payload.vendorId = user.vendorId;

  const accessToken = jwt.sign(payload, ACCESS_TOKEN_SECRET, {
    expiresIn: "3h",
  });
  const refreshToken = jwt.sign(payload, REFRESH_TOKEN_SECRET, {
    expiresIn: "1d",
  });

  return { accessToken, refreshToken };
};

// ------------------- Public signup role allow-list -------------------
// SECURITY: public (unauthenticated) registration may only create CUSTOMER
// or VENDOR accounts. ADMIN and EMPLOYEE accounts are created exclusively
// through authenticated internal flows (e.g. employee.service.ts
// createAdminEmployee / createVendorEmployee), which do NOT go through
// registerUser. A client-supplied role outside this list is rejected.
export const PUBLIC_SIGNUP_ROLES: readonly UserRole[] = [UserRole.CUSTOMER, UserRole.VENDOR];

export const assertPublicSignupRole = (role: unknown): UserRole => {
  if (typeof role !== "string" || !(PUBLIC_SIGNUP_ROLES as readonly string[]).includes(role)) {
    throw new Error("Invalid role for public registration. Allowed roles: CUSTOMER, VENDOR");
  }
  return role as UserRole;
};

// SECURITY: strip the password hash before a user object is returned in any
// auth response. Everything else (relations, ids, role) is left untouched so
// the existing response contract is preserved.
export const toPublicUser = <T>(user: T): Omit<T, "password"> => {
  if (!user || typeof user !== "object") return user as Omit<T, "password">;
  const { password: _password, ...rest } = user as T & { password?: unknown };
  return rest as Omit<T, "password">;
};

// ------------------- Register User -------------------
// Public-registration service boundary: only reachable from the public
// /register → /verify-otp and /verify-email flows. The role allow-list is
// enforced here as well so no public auth path can bypass it.
export const registerUser = async (data: {
  name?: string;
  email?: string;
  phone?: string;
  password: string;
  role: UserRole;
  storeName?: string;
  designation?: string;
  department?: string;
  isVerified?: boolean;
}) => {
  const {
    name,
    email,
    phone,
    password,
    role,
    storeName,
    designation,
    department,
    isVerified = false,
  } = data;

  // Must run before ANY database write (also prevents the stray Employee row
  // a rejected EMPLOYEE signup used to leave behind).
  assertPublicSignupRole(role);

  if (!email && !phone) throw new Error("Email or phone is required");
  let normalizedPhone = phone || "";

  // Only validate and normalize when a phone was provided
  if (phone) {
    // Ensure the number starts with 0
    if (!phone.startsWith("0")) {
      normalizedPhone = "0" + phone;
    }

    // Ensure it's exactly 11 digits
    if (normalizedPhone.length !== 11) {
      throw new Error("Phone number must be exactly 11 digits long");
    }
  }

  // Check uniqueness
  if (email) {
    const exists = await prisma.user.findFirst({ where: { email } });
    if (exists) throw new Error("User with this email already exists");
  }
  if (phone) {
    const exists = await prisma.user.findFirst({ where: { phone } });
    if (exists) throw new Error("User with this phone already exists");
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  let vendorId: string | null = null;
  let employeeId: string | null = null;

  // Role-specific creation
  if (role === "VENDOR") {
    const vendor = await prisma.vendor.create({
      data: { storeName: storeName || "" },
    });
    vendorId = vendor.id;
  }

  if (role === "EMPLOYEE") {
    const employee = await prisma.employee.create({
      data: { designation, department, permissions: [] },
    });
    employeeId = employee.id;
  }

  const user = await prisma.user.create({
    data: {
      name,
      email,
      phone: normalizedPhone,
      password: hashedPassword,
      role,
      isVerified,
      vendorId: vendorId || undefined,
      employeeId: employeeId || undefined,
      ...(role === "CUSTOMER" ? { customerProfile: { create: {} } } : {}),
    },
    include: { vendor: true, employee: true, customerProfile: true },
  });

  return user;
};

// ------------------- Login User -------------------
export const loginUser = async (
  email?: string,
  phone?: string,
  password?: string,
) => {
  if (!email && !phone) throw new Error("Email or phone is required");

  // ✅ Normalize phone number — add '0' in front if missing
  let normalizedPhone = phone;
  if (phone && !phone.startsWith("0")) {
    normalizedPhone = "0" + phone;
  }

  const user = await prisma.user.findFirst({
    where: { OR: [{ email }, { phone: normalizedPhone }] },
    include: { vendor: true, employee: true, customerProfile: true },
  });

  if (!user) throw new Error("Invalid email/phone or password");
  if (!password) throw new Error("Password is required");

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) throw new Error("Invalid email/phone or password");

  const { accessToken, refreshToken } = generateTokens(user);

  return { user, accessToken, refreshToken };
};

// ------------------- Reset Password -------------------
export const resetPassword = async (userId: string, newPassword: string) => {
  const hashedPassword = await bcrypt.hash(newPassword, 10);

  const user = await prisma.user.update({
    where: { id: userId },
    data: { password: hashedPassword },
  });

  return user;
};
// ------------------- Change Password (Service) -------------------
export const changePassword = async (userId: string, newPassword: string) => {
  const hashedPassword = await bcrypt.hash(newPassword, 10);

  const user = await prisma.user.update({
    where: { id: userId },
    data: { password: hashedPassword },
  });

  return user;
};