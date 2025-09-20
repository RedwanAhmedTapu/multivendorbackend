// controllers/customerController.ts
import type { Request, Response } from "express";
import type {
  ExportOptions,
  ComplaintStatus,
  ComplaintPriority,
  CustomerFilter,
} from "@/types/customer.types.ts";

import { CustomerService } from "../services/customer.service.ts";

const customerService = new CustomerService();

export class CustomerController {
  // Get all customers
  async getCustomers(req: Request, res: Response) {
  try {
    const rawStatus = (req.query.status as string) || "all";

    // Ensure status is valid
    const status = ["active", "blocked", "all"].includes(rawStatus)
      ? (rawStatus as "active" | "blocked" | "all")
      : "all";

    const filters: CustomerFilter = {
      status,
      search: (req.query.search as string) || undefined,
      page: req.query.page ? Number(req.query.page) : 1,
      limit: req.query.limit ? Number(req.query.limit) : 10,
      sortBy: (req.query.sortBy as string) || "createdAt",
      sortOrder: (req.query.sortOrder as "asc" | "desc") || "desc",
      minWallet: req.query.minWallet ? Number(req.query.minWallet) : undefined,
      maxWallet: req.query.maxWallet ? Number(req.query.maxWallet) : undefined,
      minLoyalty: req.query.minLoyalty ? Number(req.query.minLoyalty) : undefined,
      maxLoyalty: req.query.maxLoyalty ? Number(req.query.maxLoyalty) : undefined,
      startDate: req.query.startDate
        ? new Date(req.query.startDate as string)
        : undefined,
      endDate: req.query.endDate
        ? new Date(req.query.endDate as string)
        : undefined,
    };

    const result = await customerService.getCustomers(filters);
    res.json(result);
  } catch (error) {
    console.error(error); // log error for debugging
    res.status(500).json({ error: "Failed to fetch customers" });
  }
}


  // Get customer by ID
  async getCustomer(req: Request, res: Response) {
    try {
      const customer = await customerService.getCustomerById(req.params.id);
      if (!customer)
        return res.status(404).json({ error: "Customer not found" });
      res.json(customer);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch customer" });
    }
  }

  // Block/unblock customer
  async toggleBlock(req: Request, res: Response) {
       const { block, reason } = req.body;
  console.log(req.body)
    try {
   

      const customer = await customerService.toggleCustomerBlock(
        req.params.id,
        block,
        reason
      );
      res.json(customer);
    } catch (error) {

      res.status(500).json({ error: "Failed to update customer status" });
    }
  }

  // Update customer profile
  async updateProfile(req: Request, res: Response) {
    try {
      const customer = await customerService.updateCustomerProfile(
        req.params.id,
        req.body
      );
      res.json(customer);
    } catch (error) {
      res.status(500).json({ error: "Failed to update customer profile" });
    }
  }

  // Get customer reviews
  async getReviews(req: Request, res: Response) {
    try {
      const filters = {
        status: req.query.status as "approved" | "flagged" | "pending",
        page: req.query.page ? Number(req.query.page) : 1,
        limit: req.query.limit ? Number(req.query.limit) : 10,
      };
      const result = await customerService.getCustomerReviews(
        req.params.userId,
        filters
      );
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch reviews" });
    }
  }

  // Moderate review
  async moderateReview(req: Request, res: Response) {
    try {
      const { action, reason } = req.body;
      const review = await customerService.moderateReview(
        req.params.reviewId,
        action,
        reason
      );
      res.json(review);
    } catch (error) {
      res.status(500).json({ error: "Failed to moderate review" });
    }
  }

  // Get complaints
  async getComplaints(req: Request, res: Response) {
    try {
      const filters = {
        status: req.query.status as ComplaintStatus,
        priority: req.query.priority as ComplaintPriority,
        userId: req.query.userId as string,
        page: req.query.page ? Number(req.query.page) : 1,
        limit: req.query.limit ? Number(req.query.limit) : 10,
      };
      const result = await customerService.getComplaints(filters);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch complaints" });
    }
  }

  // Update complaint status
  async updateComplaintStatus(req: Request, res: Response) {
    try {
      const { status, assignedTo } = req.body;
      const complaint = await customerService.updateComplaintStatus(
        req.params.complaintId,
        status,
        assignedTo
      );
      res.json(complaint);
    } catch (error) {
      res.status(500).json({ error: "Failed to update complaint" });
    }
  }

  // Add message to complaint
  async addComplaintMessage(req: Request, res: Response) {
    try {
      const { senderId, content, isInternal } = req.body;
      const message = await customerService.addComplaintMessage(
        req.params.complaintId,
        senderId,
        content,
        isInternal
      );
      res.json(message);
    } catch (error) {
      res.status(500).json({ error: "Failed to add message to complaint" });
    }
  }

  // Get wallet transactions
  async getWalletTransactions(req: Request, res: Response) {
    try {
      const filters = {
        type: req.query.type as any,
        page: req.query.page ? Number(req.query.page) : 1,
        limit: req.query.limit ? Number(req.query.limit) : 10,
      };
      const result = await customerService.getWalletTransactions(
        req.params.userId,
        filters
      );
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch wallet transactions" });
    }
  }

  // Get loyalty transactions
  async getLoyaltyTransactions(req: Request, res: Response) {
    try {
      const filters = {
        type: req.query.type as any,
        page: req.query.page ? Number(req.query.page) : 1,
        limit: req.query.limit ? Number(req.query.limit) : 10,
      };
      const result = await customerService.getLoyaltyTransactions(
        req.params.userId,
        filters
      );
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch loyalty transactions" });
    }
  }

  // Adjust wallet balance
  async adjustWallet(req: Request, res: Response) {
    try {
      const { amount, description, type } = req.body;
      const result = await customerService.adjustWalletBalance(
        req.params.userId,
        amount,
        description,
        type
      );
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: "Failed to adjust wallet balance" });
    }
  }

  // Adjust loyalty points
  async adjustLoyalty(req: Request, res: Response) {
    try {
      const { points, description, type } = req.body;
      const result = await customerService.adjustLoyaltyPoints(
        req.params.userId,
        points,
        description,
        type
      );
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: "Failed to adjust loyalty points" });
    }
  }

  // Export customers
  async exportCustomers(req: Request, res: Response) {
    try {
      const options: ExportOptions = req.body;
      const result = await customerService.exportCustomers(options);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: "Failed to export customers" });
    }
  }
}
