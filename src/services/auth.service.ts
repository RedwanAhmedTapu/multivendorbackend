import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../config/prisma.ts";
import { UserRole } from "@prisma/client";

const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || "access-secret";
const REFRESH_TOKEN_SECRET =
  process.env.REFRESH_TOKEN_SECRET || "refresh-secret";

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

// ------------------- Register User -------------------
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

  if (!email && !phone) throw new Error("Email or phone is required");
  let normalizedPhone = phone || '';

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
  let vendorId: number | null = null;
  let employeeId: number | null = null;

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
      phone:normalizedPhone,
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
  password?: string
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
