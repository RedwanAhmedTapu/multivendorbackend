import { Router } from 'express';
import { OrderChargeController } from '../controllers/orderCharge.controller.ts';
import { authenticateUser, authorizeRoles } from '../middlewares/auth.middleware.ts';

const router = Router();
const ctrl = new OrderChargeController();

// ─────────────────────────────────────────────
// PUBLIC / CHECKOUT
// ─────────────────────────────────────────────

/** Used by checkout/cart page to compute order summary dynamically */
router.get('/summary', ctrl.getOrderSummary.bind(ctrl));

// ─────────────────────────────────────────────
// ADMIN-AUTHENTICATED
// ─────────────────────────────────────────────
router.use(authenticateUser, authorizeRoles('ADMIN'));

router.post('/',              ctrl.createCharge.bind(ctrl));
router.get('/',               ctrl.listCharges.bind(ctrl));
router.get('/:id',             ctrl.getCharge.bind(ctrl));
router.patch('/:id',           ctrl.updateCharge.bind(ctrl));
router.patch('/:id/toggle',    ctrl.toggleCharge.bind(ctrl));
router.delete('/:id',          ctrl.deleteCharge.bind(ctrl));

export const orderChargeRoutes = router;