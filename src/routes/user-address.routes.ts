// src/routes/user-address.routes.ts
import { Router } from 'express';
import { UserAddressController } from '../controllers/user-address.controller.ts';
import { authenticateUser } from '../middlewares/auth.middleware.ts';

const router = Router();
const controller = new UserAddressController();

// All routes require authentication
router.use(authenticateUser);

// Upsert address (create if no id, update if id provided)
router.post(
  '/addresses/upsert',
  controller.upsertAddress
);

// Get all addresses for the authenticated user
router.get(
  '/addresses',
  controller.getAddresses
);

// Get default address
router.get(
  '/addresses/default',
  controller.getDefaultAddress
);

// Get address count
router.get(
  '/addresses/count',
  controller.getAddressCount
);

// Get specific address by id
router.get(
  '/addresses/:id',
  controller.getAddressById
);

// Create new address
router.post(
  '/addresses',
  controller.createAddress
);

// Update address
router.patch(
  '/addresses/:id',
  controller.updateAddress
);

// Delete address
router.delete(
  '/addresses/:id',
  controller.deleteAddress
);

// Set address as default
router.patch(
  '/addresses/:id/set-default',
  controller.setDefaultAddress
);

// Toggle address as default
router.patch(
  '/addresses/:id/toggle-default',
  controller.toggleDefaultAddress
);

export default router;