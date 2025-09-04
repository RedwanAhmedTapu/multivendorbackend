import type { Request, Response } from "express";
import * as authService from "../services/auth.service.ts";
import jwt from "jsonwebtoken";

const REFRESH_TOKEN_SECRET =
  process.env.REFRESH_TOKEN_SECRET || "refresh-secret";

// ------------------- Register -------------------
export const register = async (req: Request, res: Response) => {
  try {
    const {
      name,
      email,
      phone,
      password,
      role,
      storeName,
      designation,
      department,
    } = req.body;

    // Require at least email or phone
    if (!email && !phone) {
      return res.status(400).json({
        message: "Either email or phone is required for registration",
      });
    }

    // Call service to register user
    const user = await authService.registerUser({
      name,
      email,
      phone,
      password,
      role,
      storeName,
      designation,
      department,
    });

    res.status(201).json({
      message: "User registered successfully",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
    });
  } catch (error: any) {
    // Handle unique constraint errors
    if (error.code === "P2002") {
      return res.status(400).json({ message: "Email or phone already exists" });
    }
    res.status(400).json({ message: error.message });
  }
};

// ------------------- Login -------------------
export const login = async (req: Request, res: Response) => {
  try {
    const { email, phone, password } = req.body;

    if (!email && !phone) {
      return res.status(400).json({ message: "Email or phone is required" });
    }

    const { user, accessToken, refreshToken } = await authService.loginUser(
      email,
      phone,
      password
    );

    // Store refresh token in HTTP-only cookie
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: false, // false in development
      sameSite: "strict", // or "strict" if you want stricter cross-site rules
      maxAge: 24 * 60 * 60 * 1000, // 1 day
    });

    res.json({
      message: "Login successful",
      accessToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
    });
  } catch (error: any) {
    res.status(400).json({ message: error.message });
  }
};

// ------------------- Refresh Token -------------------
export const refresh = (req: Request, res: Response) => {
  const token = req.cookies.refreshToken;

  if (!token) {
    return res.status(401).json({ message: "Refresh token not found" });
  }

  if (!REFRESH_TOKEN_SECRET) {
    return res.status(500).json({ message: "Refresh token secret not set" });
  }

  jwt.verify(token, REFRESH_TOKEN_SECRET, (err: any, payload: any) => {
    if (err) return res.status(403).json({ message: "Invalid refresh token" });

    const accessToken = jwt.sign(
      { id: payload.id },
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
