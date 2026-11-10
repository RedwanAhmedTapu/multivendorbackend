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
  forgotPassword,      
  resetPassword,       
  verifyResetToken,
  changePassword,   
  getLoginHistory,
  getLastLogin,
  getMe, 
} from "../controllers/auth.controller.ts";
import { authenticateUser } from '../../../middlewares/auth.middleware.ts';
import { loginRateLimiter, authGeneralRateLimiter } from '../../../middlewares/rateLimit.middleware.ts';


const router = Router();

// Defense-in-depth for the whole auth router. OTP/email/reset flows have
// their own tighter Redis-backed per-account limits inside
// verification.service.ts — this is just a broad per-IP ceiling.
router.use(authGeneralRateLimiter);

// Registration flows
router.post("/register", (req: Request, res: Response) => register(req, res));
router.post("/verify-email", (req: Request, res: Response) => verifyEmail(req, res));
router.post("/verify-otp", (req: Request, res: Response) => verifyOtp(req, res));

// Auth flows
// ⚠️ loginRateLimiter: previously /login had NO brute-force protection —
// unlimited password guesses were possible against any account.
router.post("/login", loginRateLimiter, (req: Request, res: Response) => login(req, res));
router.post("/refresh", (req: Request, res: Response) => refresh(req, res));
router.post("/logout", (req: Request, res: Response) => logout(req, res));

// Social signup/login
router.post("/social-login", (req: Request, res: Response) => socialLogin(req, res));

// Password reset flows
router.post("/forgot-password", (req: Request, res: Response) => forgotPassword(req, res));
router.post("/verify-reset-token", (req: Request, res: Response) => verifyResetToken(req, res));
router.post("/reset-password", (req: Request, res: Response) => resetPassword(req, res));
router.post("/change-password",authenticateUser, (req: Request, res: Response) => changePassword(req, res));

// loginhistory
router.get("/login-history", authenticateUser, (req, res) => getLoginHistory(req as any, res));
router.get("/last-login", authenticateUser, (req, res) => getLastLogin(req as any, res));


 router.get("/me", authenticateUser, (req, res) => getMe(req as any, res));

export default router;