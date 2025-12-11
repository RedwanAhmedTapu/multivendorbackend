// services/vendor.service.ts
import {
  PrismaClient,
  Prisma,
  VendorStatus,
  PayoutStatus,
  OrderStatus,
  DocumentType,
  DocumentVerificationStatus,
  SubscriptionPlan,
  VerificationStatus,
  AccountType,
} from "@prisma/client";
import bcrypt from "bcryptjs";
import type {
  CreateVendorRequest,
  UpdateVendorProfileRequest,
  VendorCommissionRequest,
  VendorPayoutRequest,
  VendorMonthlyChargeRequest,
  VendorOfferRequest,
  VendorFlagRequest,
  VendorFilterQuery,
  VendorWithDetails,
  VendorPerformanceMetrics,
  PayoutSummary,
  FraudDetectionResult,
  BulkCommissionUpdateRequest,
  BulkMonthlyChargeRequest,
  VendorExportOptions,
  VendorPersonalInfoRequest,
  VendorAddressRequest,
  VendorBankInfoRequest,
  VendorDocumentRequest,
  VendorSubscriptionRequest,
  VendorOnboardingStatus,
  VendorVerificationRequest,
  CompleteVendorProfile,
} from "@/types/vendor.types.ts";
import { deleteFromR2 } from "../lib/cloudflare-r2.ts";

const prisma = new PrismaClient();

export class VendorService {
  // ================================
  // VENDOR CRUD OPERATIONS
  // ================================

  async createVendor(data: CreateVendorRequest) {
    const hashedPassword = await bcrypt.hash(data.password, 10);

    return await prisma.$transaction(async (tx) => {
      // Create user first
      const user = await tx.user.create({
        data: {
          email: data.email,
          phone: data.phone,
          password: hashedPassword,
          role: "VENDOR",
        },
      });

      // Create vendor with all related records
      const vendor = await tx.vendor.create({
        data: {
          storeName: data.storeName,
          avatar: data.avatar,
          accountType: data.accountType || AccountType.INDIVIDUAL,
          user: {
            connect: { id: user.id },
          },
          // Initialize related records
          personalInfo: data.personalInfo
            ? {
                create: {
                  idNumber: data.personalInfo.idNumber,
                  idName: data.personalInfo.idName,
                  companyName: data.personalInfo.companyName,
                  businessRegNo: data.personalInfo.businessRegNo,
                  taxIdNumber: data.personalInfo.taxIdNumber,
                },
              }
            : undefined,
          pickupAddress: data.address
            ? {
                create: {
                  detailsAddress: data.address.detailsAddress,
                  city: data.address.city,
                  zone: data.address.zone,
                  area: data.address.area,
                },
              }
            : undefined,
          settings: {
            create: {
              emailNotifications: true,
            },
          },
          subscription: {
            create: {
              planType: SubscriptionPlan.FREE,
              isActive: true,
            },
          },
          onboarding: {
            create: {
              personalInfoComplete: !!data.personalInfo,
              addressComplete: !!data.address,
              bankInfoComplete: false,
              documentsComplete: false,
              overallComplete: false,
            },
          },
        },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              phone: true,
              isActive: true,
              isVerified: true,
            },
          },
          personalInfo: true,
          pickupAddress: true,
          settings: true,
          subscription: true,
          onboarding: true,
        },
      });

      // Initialize performance record
      await tx.vendorPerformance.create({
        data: {
          vendorId: vendor.id,
        },
      });

      return vendor;
    });
  }
  async getVendorById(id: string): Promise<VendorWithDetails | null> {
    try {
      return await prisma.vendor.findUnique({
        where: { id },
        include: {
          // Essential user info
          user: {
            select: {
              id: true,
              email: true,
              phone: true,
              isActive: true,
              isVerified: true,
            },
          },
          // Basic vendor info
          personalInfo: true,
          settings: true,
         commissions: {
          select: {
            id: true,
            categoryId: true,
            rate: true,
            category: {
              select: {
                name: true,  
              },
            },
          },
        },

          // Counts only (no full relations)
          _count: {
            select: {
              products: true,
              orders: true,
              flags: true,
              employees: true,
              documents: true,
              followers: true,
              commissions: true,
              payouts: true,
              advertisements: true,
            },
          },
        },
      });
    } catch (error) {
      console.error("Error fetching vendor:", error);
      throw error;
    }
  }

  async getVendors(filters: VendorFilterQuery) {
    const {
      status,
      verificationStatus,
      accountType, // CHANGED: from sellerType to accountType
      search,
      commissionMin,
      commissionMax,
      createdFrom,
      createdTo,
      page = 1,
      limit = 10,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = filters;

    const skip = (page - 1) * limit;

    const where: Prisma.VendorWhereInput = {
      ...(status && { status }),
      ...(verificationStatus && { verificationStatus }),
      ...(accountType && { accountType }), // CHANGED: from sellerType to accountType
      ...(search && {
        OR: [
          { storeName: { contains: search, mode: "insensitive" } },
          { user: { email: { contains: search, mode: "insensitive" } } },
          // REMOVED: personalInfo firstName/lastName searches since they're no longer in the schema
          // ADDED: Search in new personal info fields
          {
            personalInfo: { idName: { contains: search, mode: "insensitive" } },
          },
          {
            personalInfo: {
              companyName: { contains: search, mode: "insensitive" },
            },
          },
          {
            personalInfo: {
              businessRegNo: { contains: search, mode: "insensitive" },
            },
          },
        ],
      }),
      ...(commissionMin !== undefined && {
        currentCommissionRate: { gte: commissionMin },
      }),
      ...(commissionMax !== undefined && {
        currentCommissionRate: { lte: commissionMax },
      }),
      ...(createdFrom && { createdAt: { gte: createdFrom } }),
      ...(createdTo && { createdAt: { lte: createdTo } }),
    };

    const [vendors, total] = await Promise.all([
      prisma.vendor.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              phone: true,
              isActive: true,
              isVerified: true,
            },
          },
          personalInfo: true,
          bankInfo: true,
          documents: {
            // ADDED: Include documents array
            take: 5, // Limit to recent documents
            orderBy: { createdAt: "desc" },
          },
          pickupAddress: true,
          subscription: true,
          performance: true,
          onboarding: true,
          _count: {
            select: {
              products: true,
              orders: true,
              flags: true,
              documents: true, // ADDED: Count of documents
            },
          },
        },
      }),
      prisma.vendor.count({ where }),
    ]);

    return {
      data: vendors,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async updateVendorProfile(id: string, data: UpdateVendorProfileRequest) {
    // Get current vendor data to check for old avatar
    const currentVendor = await this.getVendorById(id);
    console.log(data);
    // Update vendor
    const vendor = await prisma.vendor.update({
      where: { id },
      data: {
        storeName: data.storeName,
        avatar: data.avatar,
        accountType: data.accountType,
        status: data.status,
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            phone: true,
            isActive: true,
            isVerified: true,
          },
        },
        personalInfo: true,
        bankInfo: true,
        pickupAddress: true,
      },
    });

    return vendor;
  }

  async updateVendorStatus(id: string, status: VendorStatus) {
    return await prisma.vendor.update({
      where: { id },
      data: { status },
    });
  }

  async deleteVendor(id: string) {
    return await prisma.$transaction(async (tx) => {
      const vendor = await tx.vendor.findUnique({
        where: { id },
        include: { user: true },
      });

      if (!vendor) {
        throw new Error("Vendor not found");
      }

      await tx.vendor.delete({
        where: { id },
      });

      if (vendor.user) {
        await tx.user.delete({
          where: { id: vendor.user.id },
        });
      }

      return { message: "Vendor deleted successfully" };
    });
  }

  // ================================
  // PERSONAL INFO MANAGEMENT
  // ================================

  async createOrUpdatePersonalInfo(
    vendorId: string,
    data: VendorPersonalInfoRequest
  ) {
    return await prisma.$transaction(async (tx) => {
      // First get vendor to check account type
      const vendor = await tx.vendor.findUnique({
        where: { id: vendorId },
        select: { accountType: true },
      });

      if (!vendor) {
        throw new Error("Vendor not found");
      }

      const personalInfo = await tx.vendorPersonalInfo.upsert({
        where: { vendorId },
        update: {
          // Individual-specific fields
          idNumber: data.idNumber,
          idName: data.idName,
          // Business-specific fields
          companyName: data.companyName,
          businessRegNo: data.businessRegNo,
          taxIdNumber: data.taxIdNumber,
        },
        create: {
          vendorId,
          // Individual-specific fields
          idNumber: data.idNumber,
          idName: data.idName,
          // Business-specific fields
          companyName: data.companyName,
          businessRegNo: data.businessRegNo,
          taxIdNumber: data.taxIdNumber,
        },
      });

      // Validate required fields based on account type
      if (vendor.accountType === "INDIVIDUAL") {
        if (!data.idNumber || !data.idName) {
          throw new Error(
            "ID number and ID name are required for individual accounts"
          );
        }
      } else if (vendor.accountType === "BUSINESS") {
        if (!data.companyName || !data.businessRegNo) {
          throw new Error(
            "Company name and business registration number are required for business accounts"
          );
        }
      }

      // Update onboarding progress
      await tx.vendorOnboardingChecklist.upsert({
        where: { vendorId },
        update: {
          personalInfoComplete: true,
          overallComplete: await this.calculateOverallCompletion(tx, vendorId),
        },
        create: {
          vendorId,
          personalInfoComplete: true,
          addressComplete: false,
          bankInfoComplete: false,
          documentsComplete: false,
          overallComplete: false,
        },
      });

      return personalInfo;
    });
  }

  async getPersonalInfo(vendorId: string) {
    return await prisma.vendorPersonalInfo.findUnique({
      where: { vendorId },
    });
  }

  async deletePersonalInfo(vendorId: string) {
    return await prisma.vendorPersonalInfo.delete({
      where: { vendorId },
    });
  }

  // UPDATED: Complete vendor profile
  async getCompleteVendorProfile(
    vendorId: string
  ): Promise<CompleteVendorProfile | null> {
    console.log(
      "🔍 [DEBUG] Starting getCompleteVendorProfile for vendor:",
      vendorId
    );

    try {
      console.log("🔍 [DEBUG] Executing Prisma query...");

      const result = await prisma.vendor.findUnique({
        where: { id: vendorId },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              phone: true,
              isActive: true,
              isVerified: true,
            },
          },
          personalInfo: true,
          bankInfo: true,
          documents: true, // ✅ This should be documents
          pickupAddress: true,
          settings: true,
          subscription: true,
          onboarding: true,
          performance: true,
          _count: {
            select: {
              products: true,
              orders: true,
              flags: true,
            },
          },
        },
      });

      console.log("✅ [DEBUG] Query executed successfully");
      console.log(
        "✅ [DEBUG] Result:",
        result ? "Found vendor" : "Vendor not found"
      );

      return result as CompleteVendorProfile | null;
    } catch (error: any) {
      console.error("❌ [DEBUG] Error in getCompleteVendorProfile:", error);
      console.error("❌ [DEBUG] Error message:", error.message);
      console.error("❌ [DEBUG] Error stack:", error.stack);
      throw error;
    }
  }

  // ================================
  // ADDRESS MANAGEMENT
  // ================================

  async createOrUpdateAddress(vendorId: string, data: VendorAddressRequest) {
    return await prisma.$transaction(async (tx) => {
      const address = await tx.vendorAddress.upsert({
        where: { vendorId },
        update: {
          detailsAddress: data.detailsAddress,
          city: data.city,
          zone: data.zone,
          area: data.area,
        },
        create: {
          vendorId,
          detailsAddress: data.detailsAddress,
          city: data.city,
          zone: data.zone,
          area: data.area,
        },
      });

      // Update onboarding progress
      await tx.vendorOnboardingChecklist.upsert({
        where: { vendorId },
        update: {
          addressComplete: true,
          overallComplete: await this.calculateOverallCompletion(tx, vendorId),
        },
        create: {
          vendorId,
          personalInfoComplete: false,
          addressComplete: true,
          bankInfoComplete: false,
          documentsComplete: false,
          overallComplete: false,
        },
      });

      return address;
    });
  }

  async getAddress(vendorId: string) {
    return await prisma.vendorAddress.findUnique({
      where: { vendorId },
    });
  }

  // ================================
  // BANK INFO MANAGEMENT
  // ================================

  async createOrUpdateBankInfo(vendorId: string, data: VendorBankInfoRequest) {
    return await prisma.$transaction(async (tx) => {
      const bankInfo = await tx.vendorBankInfo.upsert({
        where: { vendorId },
        update: {
          accountName: data.accountName,
          accountNumber: data.accountNumber,
          bankName: data.bankName,
          branchName: data.branchName,
        },
        create: {
          vendorId,
          accountName: data.accountName,
          accountNumber: data.accountNumber,
          bankName: data.bankName,
          branchName: data.branchName,
        },
      });

      // Update onboarding progress
      await tx.vendorOnboardingChecklist.upsert({
        where: { vendorId },
        update: {
          bankInfoComplete: true,
          overallComplete: await this.calculateOverallCompletion(tx, vendorId),
        },
        create: {
          vendorId,
          personalInfoComplete: false,
          addressComplete: false,
          bankInfoComplete: true,
          documentsComplete: false,
          overallComplete: false,
        },
      });

      return bankInfo;
    });
  }

  async getBankInfo(vendorId: string) {
    return await prisma.vendorBankInfo.findUnique({
      where: { vendorId },
    });
  }

  // ================================
  // DOCUMENT MANAGEMENT - UPDATED
  // ================================

  async uploadDocument(vendorId: string, data: VendorDocumentRequest) {
    return await prisma.$transaction(async (tx) => {
      // Check if vendor exists and get account type
      const vendor = await tx.vendor.findUnique({
        where: { id: vendorId },
        select: { accountType: true },
      });

      if (!vendor) {
        throw new Error("Vendor not found");
      }

      // Validate document type based on account type
      if (vendor.accountType === "INDIVIDUAL") {
        const validIndividualTypes = [
          "NATIONAL_ID_FRONT",
          "NATIONAL_ID_BACK",
          "PASSPORT_FRONT",
          "PASSPORT_BACK",
        ];
        if (!validIndividualTypes.includes(data.type)) {
          throw new Error("Invalid document type for individual account");
        }
      } else if (vendor.accountType === "BUSINESS") {
        const validBusinessTypes = [
          "NATIONAL_ID_FRONT",
          "NATIONAL_ID_BACK",
          "PASSPORT_FRONT",
          "PASSPORT_BACK",
          "TRADE_LICENSE",
          "RJSC_REGISTRATION",
          "TIN_CERTIFICATE",
          "VAT_CERTIFICATE",
          "OTHER",
        ];
        if (!validBusinessTypes.includes(data.type)) {
          throw new Error("Invalid document type for business account");
        }
      }

      // Check if document of this type already exists
      const existingDocument = await tx.vendorDocument.findFirst({
        where: {
          vendorId,
          type: data.type as any,
        },
      });

      if (existingDocument) {
        // Delete old file from R2
        try {
          const oldKey = this.extractKeyFromUrl(existingDocument.filePath);
          if (oldKey) {
            await deleteFromR2(oldKey);
          }
        } catch (deleteError) {
          console.error("Failed to delete old document:", deleteError);
        }

        // Update existing document
        const updatedDocument = await tx.vendorDocument.update({
          where: { id: existingDocument.id },
          data: {
            title: data.title,
            filePath: data.filePath,
            verificationStatus: data.verificationStatus || "PENDING",
            updatedAt: new Date(),
          },
        });

        return updatedDocument;
      }

      // Create new document
      const document = await tx.vendorDocument.create({
        data: {
          vendorId,
          type: data.type as any,
          title: data.title,
          filePath: data.filePath,
          verificationStatus: data.verificationStatus || "PENDING",
        },
      });

      // Check if all required documents are uploaded
      const requiredDocumentsComplete =
        await this.checkRequiredDocumentsComplete(
          tx,
          vendorId,
          vendor.accountType
        );

      if (requiredDocumentsComplete) {
        await tx.vendorOnboardingChecklist.upsert({
          where: { vendorId },
          update: {
            documentsComplete: true,
            overallComplete: await this.calculateOverallCompletion(
              tx,
              vendorId
            ),
          },
          create: {
            vendorId,
            personalInfoComplete: false,
            addressComplete: false,
            bankInfoComplete: false,
            documentsComplete: true,
            overallComplete: false,
          },
        });
      }

      return document;
    });
  }
  // Helper: Extract key from R2 URL
  private extractKeyFromUrl(url: string): string | null {
    try {
      if (!url) return null;

      if (url.includes(process.env.R2_PUBLIC_DOMAIN!)) {
        return url.replace(`${process.env.R2_PUBLIC_DOMAIN!}/`, "");
      } else if (url.includes(process.env.R2_ENDPOINT!)) {
        return url.replace(
          `${process.env.R2_ENDPOINT!}/${process.env.R2_BUCKET_NAME!}/`,
          ""
        );
      }
      return url;
    } catch (error) {
      console.error("Error extracting key from URL:", error);
      return null;
    }
  }

  // UPDATED: Check if all required documents are uploaded based on account type
  private async checkRequiredDocumentsComplete(
    tx: any,
    vendorId: string,
    accountType: AccountType
  ): Promise<boolean> {
    const documents = await tx.vendorDocument.findMany({
      where: { vendorId },
      select: { type: true },
    });

    const uploadedTypes = documents.map((doc) => doc.type);

    if (accountType === "INDIVIDUAL") {
      // For individual: need either NID front+back OR Passport front+back
      const hasNID =
        uploadedTypes.includes("NATIONAL_ID_FRONT") &&
        uploadedTypes.includes("NATIONAL_ID_BACK");
      const hasPassport =
        uploadedTypes.includes("PASSPORT_FRONT") &&
        uploadedTypes.includes("PASSPORT_BACK");

      return hasNID || hasPassport;
    } else if (accountType === "BUSINESS") {
      // For business: at least one business document is required
      const businessDocumentTypes = [
        "TRADE_LICENSE",
        "RJSC_REGISTRATION",
        "TIN_CERTIFICATE",
        "VAT_CERTIFICATE",
      ];
      return uploadedTypes.some((type) => businessDocumentTypes.includes(type));
    }

    return false;
  }

  // UPDATED: Get required document types based on account type
  async getRequiredDocumentTypes(vendorId: string) {
    const vendor = await prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { accountType: true },
    });

    if (!vendor) {
      throw new Error("Vendor not found");
    }

    if (vendor.accountType === "INDIVIDUAL") {
      return {
        required: [
          { type: "NATIONAL_ID_FRONT", label: "National ID Front" },
          { type: "NATIONAL_ID_BACK", label: "National ID Back" },
        ],
        alternatives: [
          { type: "PASSPORT_FRONT", label: "Passport Front" },
          { type: "PASSPORT_BACK", label: "Passport Back" },
        ],
      };
    } else {
      return {
        required: [{ type: "TRADE_LICENSE", label: "Trade License" }],
        alternatives: [
          { type: "RJSC_REGISTRATION", label: "RJSC Registration" },
          { type: "TIN_CERTIFICATE", label: "TIN Certificate" },
          { type: "VAT_CERTIFICATE", label: "VAT Certificate" },
        ],
      };
    }
  }

  async getDocuments(vendorId: string) {
    return await prisma.vendorDocument.findMany({
      where: { vendorId },
      orderBy: { createdAt: "desc" },
    });
  }

  async updateDocumentStatus(
    documentId: string,
    status: DocumentVerificationStatus,
    rejectionReason?: string
  ) {
    return await prisma.vendorDocument.update({
      where: { id: documentId },
      data: {
        verificationStatus: status,
        rejectionReason: rejectionReason,
      },
    });
  }

  async deleteDocument(documentId: string) {
    return await prisma.$transaction(async (tx) => {
      const document = await tx.vendorDocument.findUnique({
        where: { id: documentId },
      });

      if (!document) {
        throw new Error("Document not found");
      }

      // Delete from R2
      try {
        const key = this.extractKeyFromUrl(document.filePath);
        if (key) {
          await deleteFromR2(key);
        }
      } catch (deleteError) {
        console.error("Failed to delete from R2:", deleteError);
      }

      // Delete from database
      await tx.vendorDocument.delete({
        where: { id: documentId },
      });

      return document;
    });
  }

  // UPDATED: Calculate overall completion
  private async calculateOverallCompletion(
    tx: any,
    vendorId: string
  ): Promise<boolean> {
    const checklist = await tx.vendorOnboardingChecklist.findUnique({
      where: { vendorId },
      select: {
        personalInfoComplete: true,
        addressComplete: true,
        bankInfoComplete: true,
        documentsComplete: true,
      },
    });

    if (!checklist) {
      return false;
    }

    return (
      checklist.personalInfoComplete &&
      checklist.addressComplete &&
      checklist.bankInfoComplete &&
      checklist.documentsComplete
    );
  }

  // ================================
  // SUBSCRIPTION MANAGEMENT
  // ================================

  async createOrUpdateSubscription(
    vendorId: string,
    data: VendorSubscriptionRequest
  ) {
    return await prisma.vendorSubscription.upsert({
      where: { vendorId },
      update: {
        planType: data.planType,
        isActive: data.isActive,
      },
      create: {
        vendorId,
        planType: data.planType,
        isActive: data.isActive,
      },
    });
  }

  async getSubscription(vendorId: string) {
    return await prisma.vendorSubscription.findUnique({
      where: { vendorId },
    });
  }

  async cancelSubscription(vendorId: string) {
    return await prisma.vendorSubscription.update({
      where: { vendorId },
      data: {
        isActive: false,
      },
    });
  }

  // ================================
  // ONBOARDING MANAGEMENT
  // ================================

  async getOnboardingStatus(
    vendorId: string
  ): Promise<VendorOnboardingStatus | null> {
    return await prisma.vendorOnboardingChecklist.findUnique({
      where: { vendorId },
    });
  }

  // ================================
  // SETTINGS MANAGEMENT
  // ================================

  async getSettings(vendorId: string) {
    return await prisma.vendorSettings.findUnique({
      where: { vendorId },
    });
  }

  async updateSettings(vendorId: string, emailNotifications: boolean) {
    return await prisma.vendorSettings.upsert({
      where: { vendorId },
      update: {
        emailNotifications,
      },
      create: {
        vendorId,
        emailNotifications,
      },
    });
  }

  // ================================
  // VERIFICATION MANAGEMENT
  // ================================

  async verifyVendor(vendorId: string) {
    return await prisma.$transaction(async (tx) => {
      const vendor = await tx.vendor.update({
        where: { id: vendorId },
        data: {
          verificationStatus: VerificationStatus.VERIFIED,
          verifiedAt: new Date(),
          status: VendorStatus.ACTIVE,
        },
      });

      return vendor;
    });
  }

  async rejectVendor(vendorId: string, rejectionReason: string) {
    return await prisma.vendor.update({
      where: { id: vendorId },
      data: {
        verificationStatus: VerificationStatus.REJECTED,
        rejectedAt: new Date(),
        rejectionReason,
      },
    });
  }

 /**
 * Update verification status
 */
async updateVerificationStatus(
  vendorId: string, 
  status: VerificationStatus
) {
  return await prisma.vendor.update({
    where: { id: vendorId },
    data: {
      verificationStatus: status,
      ...(status === 'UNDER_REVIEW' && { 
        rejectedAt: null,
        rejectionReason: null 
      })
    },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          phone: true,
        }
      },
      personalInfo: true,
      documents: true
    }
  });
}

/**
 * Verify vendor - approve documents and activate account
 */
async verifyVendor(vendorId: string, approvedBy?: string) {
  return await prisma.$transaction(async (tx) => {
    // Check if all required documents are uploaded and approved
    const vendor = await tx.vendor.findUnique({
      where: { id: vendorId },
      include: {
        documents: true,
        onboarding: true,
        personalInfo: true,
        bankInfo: true,
        pickupAddress: true
      }
    });

    if (!vendor) {
      throw new Error('Vendor not found');
    }

    // Validate onboarding completion
    if (!vendor.onboarding?.overallComplete) {
      throw new Error('Vendor must complete all onboarding steps before verification');
    }

    // Check if required documents exist
    if (!vendor.documents || vendor.documents.length === 0) {
      throw new Error('No documents uploaded for verification');
    }

    // Update all documents to APPROVED
    await tx.vendorDocument.updateMany({
      where: { vendorId },
      data: {
        verificationStatus: 'APPROVED'
      }
    });

    // Update vendor verification status
    const updatedVendor = await tx.vendor.update({
      where: { id: vendorId },
      data: {
        verificationStatus: VerificationStatus.VERIFIED,
        verifiedAt: new Date(),
        status: VendorStatus.ACTIVE, // Automatically activate when verified
        rejectedAt: null,
        rejectionReason: null
      },
      include: {
        user: true,
        personalInfo: true,
        documents: true,
        onboarding: true
      }
    });

    // TODO: Send verification success email/notification

    return updatedVendor;
  });
}

/**
 * Reject vendor verification with reason
 */
async rejectVendorVerification(vendorId: string, rejectionReason: string) {
  return await prisma.$transaction(async (tx) => {
    // Update vendor status
    const vendor = await tx.vendor.update({
      where: { id: vendorId },
      data: {
        verificationStatus: VerificationStatus.REJECTED,
        rejectedAt: new Date(),
        rejectionReason,
        verifiedAt: null
      },
      include: {
        user: true,
        personalInfo: true,
        documents: true
      }
    });

    // Update document status to REJECTED
    await tx.vendorDocument.updateMany({
      where: { vendorId },
      data: {
        verificationStatus: 'REJECTED'
      }
    });

    // TODO: Send rejection email/notification with reason

    return vendor;
  });
}

/**
 * Suspend vendor verification (e.g., expired documents, fraud suspicion)
 */
async suspendVendorVerification(vendorId: string, reason?: string) {
  return await prisma.vendor.update({
    where: { id: vendorId },
    data: {
      verificationStatus: VerificationStatus.SUSPENDED,
      rejectionReason: reason || 'Verification suspended by admin',
      status: VendorStatus.SUSPENDED // Also suspend vendor operations
    },
    include: {
      user: true,
      personalInfo: true,
      documents: true
    }
  });
}

/**
 * Request re-verification after rejection
 */
async requestReVerification(vendorId: string) {
  return await prisma.$transaction(async (tx) => {
    const vendor = await tx.vendor.findUnique({
      where: { id: vendorId },
      include: {
        onboarding: true,
        documents: true
      }
    });

    if (!vendor) {
      throw new Error('Vendor not found');
    }

    // Only rejected or suspended vendors can request re-verification
    if (!['REJECTED', 'SUSPENDED'].includes(vendor.verificationStatus)) {
      throw new Error('Only rejected or suspended vendors can request re-verification');
    }

    // Check if vendor has updated required information
    if (!vendor.onboarding?.overallComplete) {
      throw new Error('Please complete all required information before requesting re-verification');
    }

    // Reset verification status
    const updatedVendor = await tx.vendor.update({
      where: { id: vendorId },
      data: {
        verificationStatus: VerificationStatus.PENDING,
        rejectedAt: null,
        rejectionReason: null,
        verifiedAt: null
      },
      include: {
        user: true,
        personalInfo: true,
        documents: true
      }
    });

    // Reset document statuses to PENDING
    await tx.vendorDocument.updateMany({
      where: { vendorId },
      data: {
        verificationStatus: 'PENDING'
      }
    });

    // TODO: Notify admin team about re-verification request

    return updatedVendor;
  });
}

  // ================================
  // COMMISSION MANAGEMENT (UPDATED)
  // ================================

 async setCommissionRate(vendorId: string, data: VendorCommissionRequest) {
  return await prisma.$transaction(async (tx) => {

    await tx.vendorCommission.upsert({
      where: {
        vendorId_categoryId: {
          vendorId,
          categoryId: data.categoryId || null,   // composite key
        },
      },

      update: {
        rate: data.rate,
      },

      create: {
        vendorId,
        categoryId: data.categoryId || null,
        rate: data.rate,
      },
    });

    // Update only global commission (no category ID)
    if (!data.categoryId) {
      await tx.vendor.update({
        where: { id: vendorId },
        data: { currentCommissionRate: data.rate },
      });
    }

    return { success: true, message: "Commission rate set successfully" };
  });
}


  async getCommissionHistory(vendorId: string, categoryId?: string) {
    return await prisma.vendorCommission.findMany({
      where: {
        vendorId,
        ...(categoryId ? { categoryId } : {}), 
      },
      include: { category: true },
      orderBy: { createdAt: "desc" },
    });
  }

 async bulkUpdateCommissions(data: BulkCommissionUpdateRequest) {
  return await prisma.$transaction(async (tx) => {
    
    // 1️⃣ Validate vendorIds
    const existingVendors = await tx.vendor.findMany({
      where: { id: { in: data.vendorIds } },
      select: { id: true },
    });

    const existingIds = existingVendors.map(v => v.id);
    const missingIds = data.vendorIds.filter(id => !existingIds.includes(id));

    if (missingIds.length > 0) {
      throw new Error(`Invalid vendorId(s): ${missingIds.join(", ")}`);
    }

    // 2️⃣ Upsert commissions (NOT create)
    const promises = data.vendorIds.map(vendorId =>
      tx.vendorCommission.upsert({
        where: {
          vendorId_categoryId: {
            vendorId,
            categoryId: data.categoryId || null,
          }
        },
        create: {
          vendorId,
          categoryId: data.categoryId || null,
          rate: data.rate,
          note: data.note,
          effectiveFrom: data.effectiveFrom || new Date(),
        },
        update: {
          rate: data.rate,
          note: data.note,
          effectiveFrom: data.effectiveFrom || new Date(),
        }
      })
    );

    await Promise.all(promises);

    

    return { updated: data.vendorIds.length };
  });
}


  // ================================
  // PAYOUT MANAGEMENT
  // ================================

  async createPayout(vendorId: string, data: VendorPayoutRequest) {
    return await prisma.vendorPayout.create({
      data: {
        vendorId,
        amount: data.amount,
        method: data.method,
        period: data.period,
        note: data.note,
      },
      include: {
        vendor: {
          select: {
            storeName: true,
          },
        },
      },
    });
  }

  async updatePayoutStatus(id: string, status: PayoutStatus, paidAt?: Date) {
    return await prisma.vendorPayout.update({
      where: { id },
      data: {
        status,
        ...(status === "PAID" && { paidAt: paidAt || new Date() }),
      },
    });
  }

  async getVendorPayouts(vendorId: string) {
    return await prisma.vendorPayout.findMany({
      where: { vendorId },
      orderBy: { createdAt: "desc" },
    });
  }

  async getPayoutSummary(vendorId: string): Promise<PayoutSummary> {
    const payouts = await prisma.vendorPayout.groupBy({
      by: ["status"],
      where: { vendorId },
      _sum: { amount: true },
    });

    const lastPayout = await prisma.vendorPayout.findFirst({
      where: { vendorId, status: "PAID" },
      orderBy: { paidAt: "desc" },
    });

    const orderSummary = await prisma.order.aggregate({
      where: { vendorId, status: "DELIVERED" },
      _sum: { totalAmount: true },
    });

    const totalRevenue = orderSummary._sum.totalAmount || 0;
    const totalPaid =
      payouts.find((p) => p.status === "PAID")?._sum.amount || 0;

    return {
      vendorId,
      totalPending:
        payouts.find((p) => p.status === "PENDING")?._sum.amount || 0,
      totalPaid,
      totalFailed: payouts.find((p) => p.status === "FAILED")?._sum.amount || 0,
      lastPayoutDate: lastPayout?.paidAt ?? undefined,
      currentBalance: totalRevenue - totalPaid,
    };
  }

  // ================================
  // MONTHLY CHARGES
  // ================================

  async setMonthlyCharge(vendorId: string, data: VendorMonthlyChargeRequest) {
    return await prisma.vendorMonthlyCharge.create({
      data: {
        vendorId,
        amount: data.amount,
        description: data.description,
        effectiveFrom: data.effectiveFrom || new Date(),
        effectiveTo: data.effectiveTo,
      },
    });
  }

  async bulkSetMonthlyCharges(data: BulkMonthlyChargeRequest) {
    const charges = data.vendorIds.map((vendorId) => ({
      vendorId,
      amount: data.amount,
      description: data.description,
      effectiveFrom: data.effectiveFrom || new Date(),
    }));

    return await prisma.vendorMonthlyCharge.createMany({
      data: charges,
    });
  }

  async getVendorCharges(vendorId: string) {
    return await prisma.vendorMonthlyCharge.findMany({
      where: { vendorId },
      orderBy: { createdAt: "desc" },
    });
  }

  // ================================
  // PERFORMANCE MONITORING
  // ================================

  async getVendorPerformance(
    vendorId: string
  ): Promise<VendorPerformanceMetrics | null> {
    const performance = await prisma.vendorPerformance.findUnique({
      where: { vendorId },
    });

    if (!performance) return null;

    const orders = await prisma.order.groupBy({
      by: ["status"],
      where: { vendorId },
      _count: true,
    });

    const completedOrders =
      orders.find((o) => o.status === "DELIVERED")?._count || 0;
    const cancelledOrders =
      orders.find((o) => o.status === "CANCELLED")?._count || 0;
    const returnedOrders =
      orders.find((o) => o.status === "RETURNED")?._count || 0;

    return {
      vendorId,
      totalSales: performance.totalSales,
      totalOrders: performance.totalOrders,
      fulfillmentRatePct: performance.fulfillmentRatePct,
      avgRating: performance.avgRating,
      monthlyGrowth: 0,
      completedOrders,
      cancelledOrders,
      returnedOrders,
    };
  }

  async updateVendorPerformance(vendorId: string) {
    const [orderStats, avgRating] = await Promise.all([
      prisma.order.aggregate({
        where: { vendorId },
        _sum: { totalAmount: true },
        _count: true,
      }),
      prisma.review.aggregate({
        where: { product: { vendorId } },
        _avg: { rating: true },
      }),
    ]);

    const deliveredOrders = await prisma.order.count({
      where: { vendorId, status: "DELIVERED" },
    });

    const fulfillmentRate =
      orderStats._count > 0 ? (deliveredOrders / orderStats._count) * 100 : 100;

    return await prisma.vendorPerformance.upsert({
      where: { vendorId },
      update: {
        totalSales: orderStats._sum.totalAmount || 0,
        totalOrders: orderStats._count,
        fulfillmentRatePct: fulfillmentRate,
        avgRating: avgRating._avg.rating || 0,
        lastCalculatedAt: new Date(),
      },
      create: {
        vendorId,
        totalSales: orderStats._sum.totalAmount || 0,
        totalOrders: orderStats._count,
        fulfillmentRatePct: fulfillmentRate,
        avgRating: avgRating._avg.rating || 0,
        lastCalculatedAt: new Date(),
      },
    });
  }

  // ================================
  // FRAUD DETECTION
  // ================================

  async detectFraud(vendorId: string): Promise<FraudDetectionResult> {
    const [orders, vendor] = await Promise.all([
      prisma.order.findMany({
        where: { vendorId },
        include: { items: { include: { variant: true } } },
      }),
      this.getVendorPerformance(vendorId),
    ]);

    const totalOrders = orders.length;
    const cancelledOrders = orders.filter(
      (o) => o.status === "CANCELLED"
    ).length;
    const declineRate =
      totalOrders > 0 ? (cancelledOrders / totalOrders) * 100 : 0;

    const prices = orders.flatMap((o) => o.items.map((i) => i.price));
    const avgPrice =
      prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
    const maxPrice = Math.max(...prices, 0);
    const priceVariation =
      avgPrice > 0 ? ((maxPrice - avgPrice) / avgPrice) * 100 : 0;

    const flags = {
      excessiveOrderDeclines: declineRate > 20,
      suspiciousPricing: priceVariation > 200,
      unusualOrderPatterns: false,
      lowFulfillmentRate: (vendor?.fulfillmentRatePct || 100) < 80,
    };

    let riskScore = 0;
    const recommendations: string[] = [];

    if (flags.excessiveOrderDeclines) riskScore += 25;
    if (flags.suspiciousPricing) riskScore += 30;
    if (flags.lowFulfillmentRate) riskScore += 20;

    if (flags.excessiveOrderDeclines)
      recommendations.push("High order decline rate detected");
    if (flags.suspiciousPricing)
      recommendations.push("Suspicious pricing patterns detected");
    if (flags.lowFulfillmentRate)
      recommendations.push("Low order fulfillment rate");

    return { vendorId, riskScore, flags, recommendations };
  }

  // ================================
  // FLAG MANAGEMENT
  // ================================

  async flagVendor(vendorId: string, data: VendorFlagRequest) {
    return await prisma.vendorFlag.create({
      data: {
        vendorId,
        reason: data.reason,
        severity: data.severity,
        meta: data.meta,
      },
    });
  }

  async getVendorFlags(vendorId: string) {
    return await prisma.vendorFlag.findMany({
      where: { vendorId },
      orderBy: { createdAt: "desc" },
    });
  }

  // ================================
  // EXPORT FUNCTIONALITY
  // ================================

  async exportVendors(options: VendorExportOptions) {
    const vendors = await this.getVendors(options.filters || {});

    const exportData = vendors.data.map((vendor) => {
      const row: any = {};

      if (options.fields.includes("storeName"))
        row.storeName = vendor.storeName;
      if (options.fields.includes("email")) row.email = vendor.user?.email;
      if (options.fields.includes("phone")) row.phone = vendor.user?.phone;
      if (options.fields.includes("status")) row.status = vendor.status;
      if (options.fields.includes("verificationStatus"))
        row.verificationStatus = vendor.verificationStatus;
      if (options.fields.includes("commissionRate"))
        row.commissionRate = vendor.currentCommissionRate;
      if (options.fields.includes("totalSales"))
        row.totalSales = vendor.performance?.totalSales;
      if (options.fields.includes("totalOrders"))
        row.totalOrders = vendor.performance?.totalOrders;
      if (options.fields.includes("createdAt"))
        row.createdAt = vendor.createdAt;
      if (options.fields.includes("firstName"))
        row.firstName = vendor.personalInfo?.firstName;
      if (options.fields.includes("lastName"))
        row.lastName = vendor.personalInfo?.lastName;

      return row;
    });

    return exportData;
  }
}
