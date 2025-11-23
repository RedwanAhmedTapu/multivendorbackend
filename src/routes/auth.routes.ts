import { Router } from "express";
import type { Request, Response } from "express";
import {
  register,
  verifyEmail,
  verifyOtp,
  login,
  refresh,
  logout,
  socialLogin,
  forgotPassword,      // Add this
  resetPassword,       // Add this
  verifyResetToken,    // Add this
} from "../controllers/auth.controller.ts";

const router = Router();

// Registration flows
router.post("/register", (req: Request, res: Response) => register(req, res));
router.post("/verify-email", (req: Request, res: Response) => verifyEmail(req, res));
router.post("/verify-otp", (req: Request, res: Response) => verifyOtp(req, res));

// Auth flows
router.post("/login", (req: Request, res: Response) => login(req, res));
router.get("/refresh", (req: Request, res: Response) => refresh(req, res));
router.post("/logout", (req: Request, res: Response) => logout(req, res));

// Social signup/login
router.post("/social-login", (req: Request, res: Response) => socialLogin(req, res));

// Password reset flows
router.post("/forgot-password", (req: Request, res: Response) => forgotPassword(req, res));
router.post("/verify-reset-token", (req: Request, res: Response) => verifyResetToken(req, res));
router.post("/reset-password", (req: Request, res: Response) => resetPassword(req, res));

export default router;