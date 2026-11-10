// src/routes/webauthn.routes.ts
import { Router } from "express";
import type { Request, Response } from "express";
import {
  registerOptions,
  registerVerify,
  loginOptions,
  loginVerify,
  listCredentials,
  removeCredential,
} from "../controllers/webauthn.controller.ts";
import { authenticateUser } from "../../../middlewares/auth.middleware.ts";

const router = Router();

// Add a passkey to an existing (logged-in) account
router.post("/register/options", authenticateUser, (req: Request, res: Response) =>
  registerOptions(req as any, res)
);
router.post("/register/verify", authenticateUser, (req: Request, res: Response) =>
  registerVerify(req as any, res)
);

// Sign in with device PIN / fingerprint / Face ID — no password needed
router.post("/login/options", (req: Request, res: Response) => loginOptions(req, res));
router.post("/login/verify", (req: Request, res: Response) => loginVerify(req, res));

// Manage saved passkeys
router.get("/credentials", authenticateUser, (req: Request, res: Response) =>
  listCredentials(req as any, res)
);
router.delete("/credentials/:id", authenticateUser, (req: Request, res: Response) =>
  removeCredential(req as any, res)
);

export default router;