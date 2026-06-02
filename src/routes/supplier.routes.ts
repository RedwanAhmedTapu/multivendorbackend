import { Router } from 'express';
import { SupplierController } from '../controllers/supplier.controller.ts';

const router = Router();
const ctrl = new SupplierController();

/**
 * POST   /api/suppliers
 * Create a new supplier and auto-generate AP Liability COA account.
 *
 * Body: CreateSupplierDTO
 * Response: { success, message, data: Supplier & { coaAccount } }
 */
router.post('/', (req, res) => ctrl.create(req, res));

/**
 * GET    /api/suppliers
 * Paginated list of suppliers with outstanding due derived from POs.
 *
 * Query: search, status, supplierType, entityType, entityId, page, limit
 * Response: { success, data: Supplier[], pagination, ... }
 */
router.get('/', (req, res) => ctrl.list(req, res));

/**
 * GET    /api/suppliers/:id
 * Single supplier detail including COA account and total outstanding due.
 *
 * Response: { success, data: Supplier & { coaAccount, totalDue } }
 */
router.get('/:id', (req, res) => ctrl.getById(req, res));

/**
 * PUT    /api/suppliers/:id
 * Update supplier fields. Note: `name` is immutable after creation.
 *
 * Body: UpdateSupplierDTO (name field is ignored even if provided)
 * Response: { success, message, data: Supplier }
 */
router.put('/:id', (req, res) => ctrl.update(req, res));

/**
 * PATCH  /api/suppliers/:id/status
 * Toggle supplier status between ACTIVE and INACTIVE.
 *
 * Response: { success, message, data: { id, name, status } }
 */
router.patch('/:id/status', (req, res) => ctrl.toggleStatus(req, res));

/**
 * GET    /api/suppliers/:id/dues
 * Outstanding due for a supplier across all their purchase orders.
 *
 * Response: { success, data: { supplier, totalDue, pendingOrders[] } }
 */
router.get('/:id/dues', (req, res) => ctrl.getDues(req, res));

export default router;