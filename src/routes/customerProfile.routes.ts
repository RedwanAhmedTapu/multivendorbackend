import { Router } from 'express';
import type { Request, Response } from 'express';
import { CustomerProfileController } from '../controllers/customerProfile.controller.ts';
import { authenticateUser } from '../middlewares/auth.middleware.ts';
import { avatarUpload } from '../middlewares/avatar-upload.middleware.ts';

const router = Router();
const ctrl = new CustomerProfileController();

router.use(authenticateUser);

router.get('/',                       (req, res) => ctrl.getProfile(req, res));
router.put('/',                       (req, res) => ctrl.updateProfile(req, res));

// Avatar — multer runs before the controller
router.post(  '/avatar', avatarUpload, (req, res) => ctrl.uploadAvatar(req, res));
router.delete('/avatar',               (req, res) => ctrl.deleteAvatar(req, res));

// Email change — two-step
router.post('/request-email-change',  (req, res) => ctrl.requestEmailChange(req, res));
router.post('/verify-email-change',   (req, res) => ctrl.verifyEmailChange(req, res));

// Phone change — two-step
router.post('/request-phone-change',  (req, res) => ctrl.requestPhoneChange(req, res));
router.post('/verify-phone-change',   (req, res) => ctrl.verifyPhoneChange(req, res));

export default router;