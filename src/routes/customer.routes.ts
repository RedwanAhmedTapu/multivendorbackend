// routes/customer.routes.ts
import { CustomerController } from "../controllers/customer.controller.ts";
import { Router } from "express";

const router = Router();
const controller = new CustomerController();

// Customers
router.get("/", controller.getCustomers.bind(controller));
router.get("/:id", controller.getCustomer.bind(controller));
router.put("/:id/block", controller.toggleBlock.bind(controller));
router.put("/:id/profile", controller.updateProfile.bind(controller));

// Reviews
router.get("/:userId/reviews", controller.getReviews.bind(controller));
router.put("/reviews/:reviewId/moderate", controller.moderateReview.bind(controller));

// Complaints
router.get("/complaints/list", controller.getComplaints.bind(controller));
router.put("/complaints/:complaintId/status", controller.updateComplaintStatus.bind(controller));
router.post("/complaints/:complaintId/messages", controller.addComplaintMessage.bind(controller));

// Wallet
router.get("/:userId/wallet-transactions", controller.getWalletTransactions.bind(controller));
router.post("/:userId/wallet-adjust", controller.adjustWallet.bind(controller));

// Loyalty
router.get("/:userId/loyalty-transactions", controller.getLoyaltyTransactions.bind(controller));
router.post("/:userId/loyalty-adjust", controller.adjustLoyalty.bind(controller));

// Export
router.post("/export", controller.exportCustomers.bind(controller));

export default router;
