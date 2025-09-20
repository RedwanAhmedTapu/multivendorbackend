import { Router } from "express";
import type { Request, Response } from "express";
import {
  register,
  verifyEmail,
  verifyOtp,
  login,
  refresh,
  logout,
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

export default router;
