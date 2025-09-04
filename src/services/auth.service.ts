import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../config/prisma.ts";
import { UserRole } from "@prisma/client";

const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || "access-secret";
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || "refresh-secret";

// ------------------- Generate Tokens -------------------
export const generateTokens = (userId: number) => {
  const accessToken = jwt.sign({ id: userId }, ACCESS_TOKEN_SECRET, {
    expiresIn: "1h",
  });

  const refreshToken = jwt.sign({ id: userId }, REFRESH_TOKEN_SECRET, {
    expiresIn: "1d",
  });

  return { accessToken, refreshToken };
};

// ------------------- Register User -------------------
export const registerUser = async (data: {
  name: string;
  email?: string;
  phone?: string;
  password: string;
  role: UserRole;
  storeName?: string;
  designation?: string;
  department?: string;
}) => {
  const { name, email, phone, password, role, storeName, designation, department } = data;

  // Require at least email or phone
  if (!email && !phone) throw new Error("Email or phone is required");

  // Check if email or phone already exists
  if (email) {
    const existingEmail = await prisma.user.findFirst({ where: { email } });
    if (existingEmail) throw new Error("User already exists with this email");
  }

  if (phone) {
    const existingPhone = await prisma.user.findFirst({ where: { phone } });
    if (existingPhone) throw new Error("User already exists with this phone");
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  // Create user with role-specific relation
  const user = await prisma.user.create({
    data: {
      name,
      email,
      phone,
      password: hashedPassword,
      role,
      ...(role === "VENDOR" && storeName
        ? { vendor: { create: { storeName } } }
        : role === "EMPLOYEE"
        ? {
            employee: {
              create: {
                ...(designation ? { designation } : {}),
                ...(department ? { department } : {}),
                permissions: [],
              },
            },
          }
        : role === "CUSTOMER"
        ? { customerProfile: { create: {} } }
        : {}),
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

  // Find user by email or phone
  const orConditions = [];
  if (email) orConditions.push({ email });
  if (phone) orConditions.push({ phone });

  const user = await prisma.user.findFirst({
    where: {
      OR: orConditions,
    },
  });

  if (!user) throw new Error("Invalid email/phone or password");

  if (!password) throw new Error("Password is required");

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) throw new Error("Invalid email/phone or password");

  const { accessToken, refreshToken } = generateTokens(user.id);

  return { user, accessToken, refreshToken };
};
