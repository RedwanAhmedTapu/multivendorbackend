import type { Request, Response } from 'express';
import { CustomerProfileService } from '../services/customerProfile.service.ts';

const profileService = new CustomerProfileService();

export class CustomerProfileController {
  /** GET /customer/profile */
  async getProfile(req: Request, res: Response) {
    try {
      const profile = await profileService.getProfile(req.user!.id);
      if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });
      return res.json({ success: true, data: profile });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * PUT /customer/profile
   * Body: { name?, gender?, dateOfBirth? }
   * Does NOT handle avatar — that goes through POST /avatar
   */
  async updateProfile(req: Request, res: Response) {
    try {
      const updated = await profileService.updateProfile(req.user!.id, req.body);
      return res.json({ success: true, data: updated });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
  }

  /**
   * POST /customer/profile/avatar
   * multipart/form-data  field: "avatar"
   * Uploads to R2 and stores the URL + key in DB.
   */
  async uploadAvatar(req: Request, res: Response) {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, error: 'No file uploaded' });
      }

      const updated = await profileService.uploadAvatar(req.user!.id, req.file);
      return res.json({ success: true, data: updated });
    } catch (err: any) {
      // Surface multer errors (wrong type, too large) cleanly
      const status = err.message.includes('Only') || err.message.includes('size') ? 400 : 500;
      return res.status(status).json({ success: false, error: err.message });
    }
  }

  /** DELETE /customer/profile/avatar */
  async deleteAvatar(req: Request, res: Response) {
    try {
      const updated = await profileService.deleteAvatar(req.user!.id);
      return res.json({ success: true, data: updated });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
  }

  /** POST /customer/profile/request-email-change  —  Body: { newEmail } */
  async requestEmailChange(req: Request, res: Response) {
    try {
      const { newEmail } = req.body;
      if (!newEmail) return res.status(400).json({ success: false, error: 'newEmail is required' });
      await profileService.requestEmailChange(req.user!.id, newEmail);
      return res.json({ success: true, message: 'Verification email sent to new address' });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
  }

  /** POST /customer/profile/verify-email-change  —  Body: { token } */
  async verifyEmailChange(req: Request, res: Response) {
    try {
      const { token } = req.body;
      if (!token) return res.status(400).json({ success: false, error: 'token is required' });
      const updated = await profileService.verifyEmailChange(req.user!.id, token);
      return res.json({ success: true, data: updated, message: 'Email updated successfully' });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
  }

  /** POST /customer/profile/request-phone-change  —  Body: { newPhone } */
  async requestPhoneChange(req: Request, res: Response) {
    try {
      const { newPhone } = req.body;
      if (!newPhone) return res.status(400).json({ success: false, error: 'newPhone is required' });
      await profileService.requestPhoneChange(req.user!.id, newPhone);
      return res.json({ success: true, message: 'OTP sent to new phone number' });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
  }

  /** POST /customer/profile/verify-phone-change  —  Body: { newPhone, otp } */
  async verifyPhoneChange(req: Request, res: Response) {
    try {
      const { newPhone, otp } = req.body;
      if (!newPhone || !otp) {
        return res.status(400).json({ success: false, error: 'newPhone and otp are required' });
      }
      const updated = await profileService.verifyPhoneChange(req.user!.id, newPhone, otp);
      return res.json({ success: true, data: updated, message: 'Phone updated successfully' });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
  }
}