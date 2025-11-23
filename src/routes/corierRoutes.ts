import { Router } from "express";
import {
  createOrder,
  calculateCost,
  trackOrder,
  batchTrackOrders,
  getAreas,
  getZones,
  getCities,
  getBalance,
  getStores,
  getAllAtOnceZoneAreaCity
} from "../controllers/courierController.ts";

const router = Router();
router.get("/:provider/all-locations", getAllAtOnceZoneAreaCity);

// Create new order
router.post("/create-order", createOrder);

// Calculate delivery cost
router.post("/calculate-cost", calculateCost);

// Track single order
router.get("/:provider/track/:trackingId", trackOrder);

// Batch track multiple orders
router.post("/batch-track", batchTrackOrders);

// ----------------- Location Data ------------------

// Get cities (root level for Pathao)
router.get("/:provider/cities", getCities);

// Get zones for a city (cityId required as query param)
router.get("/:provider/zones", getZones);

// Get areas for a zone (zoneId required as query param)
router.get("/:provider/areas", getAreas);

// ----------------- Account & Stores ------------------

// Get wallet/balance
router.get("/:provider/balance", getBalance);

// Get pickup stores
router.get("/:provider/stores", getStores);

export default router;
