import { Router } from 'express';
import { StockController } from '../controllers/Stock.controller.ts';

const router = Router();
const ctrl = new StockController();

// ─────────────────────────────────────────────────────────────────────────────
// STATIC / AGGREGATE ROUTES  (must come before /:variantId)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET    /api/stock/stats
 * Aggregate inventory stats across all variants and warehouses.
 *
 * Response:
 * {
 *   success: true,
 *   data: {
 *     totalVariants, totalStock, totalValue, totalAvailable,
 *     totalDamaged, totalReserved,
 *     lowStockCount, outOfStockCount, overstockCount
 *   }
 * }
 */
router.get('/stats', (req, res) => ctrl.stats(req, res));

// ─────────────────────────────────────────────────────────────────────────────
// MUTATION ROUTES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST   /api/stock/adjust
 * Manual count correction — deducts qty from a warehouse and posts a
 * STOCK_ADJUSTMENT journal voucher (DR Stock Adjustment Expense → CR Inventory).
 *
 * Body: StockAdjustDTO
 * {
 *   variantId, warehouseId, quantity,
 *   reason?, notes?,
 *   entityType, entityId?
 * }
 * Response: { success, message, data: { voucherNumber, amount } }
 */
router.post('/adjust', (req, res) => ctrl.adjust(req, res));

/**
 * POST   /api/stock/damage
 * Mark units as damaged — moves qty from available to damagedQty and posts a
 * DAMAGE_RECORDED journal voucher (DR Damaged Goods Expense → CR Inventory).
 *
 * Body: StockDamageDTO  (same shape as StockAdjustDTO)
 * Response: { success, message, data: { voucherNumber, amount } }
 */
router.post('/damage', (req, res) => ctrl.damage(req, res));

/**
 * POST   /api/stock/transfer
 * Move qty between two warehouses. Total ProductVariant.stock is unchanged;
 * only WarehouseStock rows are updated. Posts a STOCK_TRANSFER voucher.
 *
 * Body: StockTransferDTO
 * {
 *   variantId, fromWarehouseId, toWarehouseId, quantity,
 *   reason?, notes?,
 *   entityType, entityId?
 * }
 * Response: { success, message, data: { voucherNumber, amount } }
 */
router.post('/transfer', (req, res) => ctrl.transfer(req, res));

/**
 * POST   /api/stock/sell-damage
 * Sell previously damaged stock at a discounted/salvage price.
 * Removes units from damagedQty and posts a DAMAGE_STOCK_SOLD voucher
 * (DR Cash/Bank → CR Damage Sale Income).
 *
 * Body: StockSellDamageDTO
 * {
 *   variantId, warehouseId, quantity, saleAmount, receiptCoaAccountId,
 *   notes?,
 *   entityType, entityId?
 * }
 * Response: { success, message, data: { voucherNumber, saleAmount } }
 */
router.post('/sell-damage', (req, res) => ctrl.sellDamage(req, res));

// ─────────────────────────────────────────────────────────────────────────────
// LIST ROUTE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET    /api/stock
 * Paginated inventory list with per-warehouse stock pills.
 *
 * Query params:
 *   page        — default 1
 *   limit       — default 10
 *   warehouseId — filter to one warehouse
 *   categoryId  — filter by product category
 *   status      — in_stock | low_stock | out_stock | overstock
 *   q           — search by product name or SKU
 *
 * Response:
 * {
 *   success: true,
 *   data: [{
 *     variantId, sku, productName, variantName, avgCost, price,
 *     reorderLevel, totalStock, damagedQty, reservedQty, availableStock,
 *     status,
 *     warehouseBreakdown: [{ warehouseId, warehouseName, quantity, reservedQty, damagedQty }]
 *   }],
 *   pagination: { page, limit, total, pages }
 * }
 */
router.get('/', (req, res) => ctrl.list(req, res));

// ─────────────────────────────────────────────────────────────────────────────
// VARIANT DETAIL ROUTE  (must come after static routes)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET    /api/stock/:variantId
 * Per-variant stock detail across all warehouses with recent movements.
 *
 * Response:
 * {
 *   success: true,
 *   data: {
 *     variant: { id, sku, name, productName, totalStock, damagedQty,
 *                reservedQty, availableStock, avgCost, reorderLevel },
 *     warehouseBreakdown: [{ warehouseId, warehouseName, quantity,
 *                            reservedQty, damagedQty, available }],
 *     recentMovements: StockMovement[]   // last 20
 *   }
 * }
 */
router.get('/:variantId', (req, res) => ctrl.getVariant(req, res));

export default router;