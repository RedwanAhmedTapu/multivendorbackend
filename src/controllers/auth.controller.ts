import type { Request, Response } from "express";
import * as authService from "../services/auth.service.ts";
import * as verificationService from "../services/verification.service.ts";
import jwt from "jsonwebtoken";

const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || "refresh-secret";

// ------------------- Register -------------------
export const register = async (req: Request, res: Response) => {
  try {
    const { email, phone } = req.body;
    if (!email && !phone)
      return res.status(400).json({ message: "Email or phone required" });

    if (email) {
      await verificationService.sendEmailVerification(email);
      return res.json({ message: "Check your email to verify account" });
    }
    if (phone) {
      await verificationService.sendOtp(phone);
      return res.json({ message: "OTP sent to phone" });
    }
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
};

// ------------------- Verify Email -------------------
export const verifyEmail = async (req: Request, res: Response) => {
  try {
    const { token, name, password, role, storeName, designation, department } = req.body;

    const email = await verificationService.verifyEmail(token);
    if (!email) return res.status(400).json({ message: "Invalid or expired token" });

    const user = await authService.registerUser({
      name,
      email,
      password,
      role,
      storeName,
      designation,
      department,
      isVerified: true,
    });

    res.json({ message: "Email verified & account created", user });
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
};

// ------------------- Verify OTP -------------------
export const verifyOtp = async (req: Request, res: Response) => {
  try {
    const { phone, otp, name, password, role, storeName, designation, department } = req.body;

    const verifiedPhone = await verificationService.verifyOtp(phone, otp);
    if (!verifiedPhone) return res.status(400).json({ message: "Invalid or expired OTP" });

    const user = await authService.registerUser({
      name,
      phone: verifiedPhone,
      password,
      role,
      storeName,
      designation,
      department,
      isVerified: true,
    });

    res.json({ message: "Phone verified & account created", user });
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
};

// ------------------- Login -------------------
export const login = async (req: Request, res: Response) => {
  try {
    const { email, phone, password } = req.body;
    const { user, accessToken, refreshToken } = await authService.loginUser(email, phone, password);

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 24 * 60 * 60 * 1000,
    });

    res.json({ message: "Login successful", accessToken, user });
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
};

// ------------------- Refresh Token -------------------
export const refresh = (req: Request, res: Response) => {
  const token = req.cookies.refreshToken;
  if (!token) return res.status(401).json({ message: "Refresh token not found" });

  jwt.verify(token, REFRESH_TOKEN_SECRET, (err: any, payload: any) => {
    if (err) return res.status(403).json({ message: "Invalid refresh token" });

    const accessToken = jwt.sign(
      {
        id: payload.id,
        role: payload.role,
        vendorId: payload.vendorId ?? null,
        emailorphone: payload.emailorphone ?? null,
      },
      process.env.ACCESS_TOKEN_SECRET || "access-secret",
      { expiresIn: "1h" }
    );
    res.json({ accessToken });
  });
};

// ------------------- Logout -------------------
export const logout = (req: Request, res: Response) => {
  res.clearCookie("refreshToken", { httpOnly: true, sameSite: "strict" });
  res.json({ message: "Logged out successfully" });
};
