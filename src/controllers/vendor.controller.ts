// controllers/vendor.controller.ts
import type { Request, Response } from 'express';
import { VendorService } from '../services/vendor.service.ts';
import { VendorStatus, PayoutStatus, DocumentType } from '@prisma/client';
import { uploadToR2, deleteFromR2 } from '../lib/cloudflare-r2.ts';
import type { 
  CreateVendorRequest, 
  UpdateVendorProfileRequest,
  VendorCommissionRequest,
  VendorPayoutRequest,
  VendorMonthlyChargeRequest,
  VendorOfferRequest,
  VendorFlagRequest,
  VendorFilterQuery,
  BulkCommissionUpdateRequest,
  BulkMonthlyChargeRequest,
  VendorExportOptions,
  VendorAddressRequest,
  VendorPersonalInfoRequest,
  VendorBankInfoRequest,
  VendorDocumentRequest,
  VendorSubscriptionRequest
} from '@/types/vendor.types.ts';

export class VendorController {
  private vendorService: VendorService;

  constructor() {
    this.vendorService = new VendorService();
  }

  // Vendor CRUD Operations
  createVendor = async (req: Request, res: Response) => {
    try {
      const data: CreateVendorRequest = req.body;
      const vendor = await this.vendorService.createVendor(data);
      
      res.status(201).json({
        success: true,
        message: 'Vendor created successfully',
        data: vendor
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to create vendor',
        error: error.message
      });
    }
  };

  getVendors = async (req: Request, res: Response) => {
    try {
      const filters: VendorFilterQuery = {
        status: req.query.status as VendorStatus,
        search: req.query.search as string,
        commissionMin: req.query.commissionMin ? parseFloat(req.query.commissionMin as string) : undefined,
        commissionMax: req.query.commissionMax ? parseFloat(req.query.commissionMax as string) : undefined,
        createdFrom: req.query.createdFrom ? new Date(req.query.createdFrom as string) : undefined,
        createdTo: req.query.createdTo ? new Date(req.query.createdTo as string) : undefined,
        page: req.query.page ? parseInt(req.query.page as string) : 1,
        limit: req.query.limit ? parseInt(req.query.limit as string) : 10,
        sortBy: req.query.sortBy as any,
        sortOrder: req.query.sortOrder as 'asc' | 'desc'
      };

      const result = await this.vendorService.getVendors(filters);
      
      res.json({
        success: true,
        data: result.data,
        pagination: result.pagination
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch vendors',
        error: error.message
      });
    }
  };

  getVendorById = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      console.log(id)

      const vendor = await this.vendorService.getVendorById(id);
      console.log(vendor)
      
      if (!vendor) {
        return res.status(404).json({
          success: false,
          message: 'Vendor not found'
        });
      }

      res.json({
        success: true,
        data: vendor
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch vendor',
        error: error.message
      });
    }
  };

 updateVendorProfile = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const data: UpdateVendorProfileRequest = req.body;
    
    // Get current vendor to check for existing avatar
    const currentVendor = await this.vendorService.getVendorById(id);
    
    if (!currentVendor) {
      return res.status(404).json({
        success: false,
        message: 'Vendor not found'
      });
    }

    // Handle avatar upload if file exists
    if (req.file) {
      // Delete old avatar if it exists
      if (currentVendor.avatar) {
        try {
          // Extract key from current avatar URL
          const oldKey = this.extractKeyFromUrl(currentVendor.avatar);
          if (oldKey) {
            await deleteFromR2(oldKey);
            console.log('🗑️ Old avatar deleted successfully:', oldKey);
          }
        } catch (deleteError) {
          console.error('⚠️ Failed to delete old avatar:', deleteError);
          // Continue with upload even if deletion fails
        }
      }

      // Generate unique filename for new avatar
      const fileExtension = req.file.originalname.split('.').pop();
      const timestamp = Date.now();
      const fileName = `avatar-${timestamp}.${fileExtension}`;
      const key = `vendors/${id}/avatar/${fileName}`;

      // Upload to Cloudflare R2
      const uploadResult = await uploadToR2({
        file: req.file.buffer,
        key: key,
        contentType: req.file.mimetype,
        vendorId: id
      });

      // Set the avatar URL in the data
      data.avatar = uploadResult.url;
      console.log('✅ New avatar uploaded:', data.avatar);
    }

    const vendor = await this.vendorService.updateVendorProfile(id, data);
    
    res.json({
      success: true,
      message: 'Vendor profile updated successfully',
      data: vendor
    });
  } catch (error: any) {
    console.error('❌ Profile update error:', error);
    res.status(400).json({
      success: false,
      message: 'Failed to update vendor profile',
      error: error.message
    });
  }
};

/**
 * Extract key from R2 URL
 */
private extractKeyFromUrl(url: string): string | null {
  try {
    if (!url) return null;
    
    // Handle public domain URLs: https://pub-xxxx.r2.dev/vendors/xxx/avatar/xxx.jpg
    if (url.includes(process.env.R2_PUBLIC_DOMAIN!)) {
      return url.replace(`${process.env.R2_PUBLIC_DOMAIN!}/`, '');
    } 
    // Handle endpoint URLs: https://xxxx.r2.cloudflarestorage.com/bucket/vendors/xxx/avatar/xxx.jpg
    else if (url.includes(process.env.R2_ENDPOINT!)) {
      return url.replace(`${process.env.R2_ENDPOINT!}/${process.env.R2_BUCKET_NAME!}/`, '');
    }
    // If it's already a key or doesn't match patterns, return as-is
    return url;
  } catch (error) {
    console.error('Error extracting key from URL:', error);
    return null;
  }
}

  approveVendor = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const vendor = await this.vendorService.updateVendorStatus(id, VendorStatus.ACTIVE);
      
      res.json({
        success: true,
        message: 'Vendor approved successfully',
        data: vendor
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to approve vendor',
        error: error.message
      });
    }
  };

  suspendVendor = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const vendor = await this.vendorService.updateVendorStatus(id, VendorStatus.SUSPENDED);
      
      res.json({
        success: true,
        message: 'Vendor suspended successfully',
        data: vendor
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to suspend vendor',
        error: error.message
      });
    }
  };

  deactivateVendor = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const vendor = await this.vendorService.updateVendorStatus(id, VendorStatus.DEACTIVATED);
      
      res.json({
        success: true,
        message: 'Vendor deactivated successfully',
        data: vendor
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to deactivate vendor',
        error: error.message
      });
    }
  };

  deleteVendor = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      await this.vendorService.deleteVendor(id);
      
      res.json({
        success: true,
        message: 'Vendor deleted successfully'
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to delete vendor',
        error: error.message
      });
    }
  };

  // ================================
// VERIFICATION STATUS MANAGEMENT
// ================================

setUnderReview = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const vendor = await this.vendorService.updateVerificationStatus(
      id, 
      'UNDER_REVIEW'
    );
    
    res.json({
      success: true,
      message: 'Vendor verification status updated to under review',
      data: vendor
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: 'Failed to update verification status',
      error: error.message
    });
  }
};

verifyVendor = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { approvedBy } = req.body; // Admin user ID
    
    const vendor = await this.vendorService.verifyVendor(id, approvedBy);
    
    res.json({
      success: true,
      message: 'Vendor verified successfully',
      data: vendor
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: 'Failed to verify vendor',
      error: error.message
    });
  }
};

rejectVendorVerification = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { rejectionReason } = req.body;
    
    if (!rejectionReason) {
      return res.status(400).json({
        success: false,
        message: 'Rejection reason is required'
      });
    }
    
    const vendor = await this.vendorService.rejectVendorVerification(
      id, 
      rejectionReason
    );
    
    res.json({
      success: true,
      message: 'Vendor verification rejected',
      data: vendor
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: 'Failed to reject vendor verification',
      error: error.message
    });
  }
};

suspendVendorVerification = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    
    const vendor = await this.vendorService.suspendVendorVerification(id, reason);
    
    res.json({
      success: true,
      message: 'Vendor verification suspended',
      data: vendor
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: 'Failed to suspend vendor verification',
      error: error.message
    });
  }
};

requestReVerification = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const vendor = await this.vendorService.requestReVerification(id);
    
    res.json({
      success: true,
      message: 'Re-verification request submitted successfully',
      data: vendor
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: 'Failed to request re-verification',
      error: error.message
    });
  }
};
// ================================
  // PERSONAL INFO MANAGEMENT
  // ================================

   createOrUpdatePersonalInfo=async(req: Request, res: Response) =>{
  console.log('Personal info request:', req.body);
  try {
    const vendorId = req.params.id;
    const data: VendorPersonalInfoRequest = req.body;

    const personalInfo = await this.vendorService.createOrUpdatePersonalInfo(vendorId, data);
    
    res.json({
      success: true,
      data: personalInfo,
      message: 'Personal information updated successfully'
    });
  } catch (error) {
    console.error('Error updating personal info:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update personal information',
      error: error.message
    });
  }
}

 getPersonalInfo=async(req: Request, res: Response) =>{
  try {
    const vendorId = req.params.id;
    const personalInfo = await this.vendorService.getPersonalInfo(vendorId);
    
    res.json({
      success: true,
      data: personalInfo
    });
  } catch (error) {
    console.error('Error fetching personal info:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch personal information',
      error: error.message
    });
  }
}

// NEW: Get required document types
 getRequiredDocumentTypes=async(req: Request, res: Response) =>{
  try {
    const vendorId = req.params.id;
    const requiredTypes = await this.vendorService.getRequiredDocumentTypes(vendorId);
    
    res.json({
      success: true,
      data: requiredTypes
    });
  } catch (error) {
    console.error('Error fetching required document types:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch required document types',
      error: error.message
    });
  }
}

getCompleteProfile = async (req: Request, res: Response) => {
  try {
    const vendorId = req.params.vendorId;
    
    const completeProfile = await this.vendorService.getCompleteVendorProfile(vendorId);
    
    if (!completeProfile) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found"
      });
    }

    res.json({
      success: true,
      data: completeProfile
    });
  } catch (error) {
    console.error("Error fetching complete vendor profile:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch vendor profile"
    });
  }
}
  // ================================
  // ADDRESS MANAGEMENT
  // ================================

  createOrUpdateAddress = async (req: Request, res: Response) => {
  try {
    const vendorId = req.params.id;
    const data: VendorAddressRequest = req.body;

    const address = await this.vendorService.createOrUpdateAddress(vendorId, data);

    res.json({
      success: true,
      data: address,
      message: 'Address updated successfully'
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Failed to update address',
      error: error.message
    });
  }
};


 getAddress = async (req: Request, res: Response) => {
  try {
    const vendorId = req.params.id;
    const address = await this.vendorService.getAddress(vendorId);
    
    res.json({
      success: true,
      data: address
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch address',
      error: error.message
    });
  }
};

// ================================
// BANK INFO MANAGEMENT
// ================================
createOrUpdateBankInfo = async (req: Request, res: Response) => {
  try {
    const vendorId = req.params.id;
    const data: VendorBankInfoRequest = req.body;

    const bankInfo = await this.vendorService.createOrUpdateBankInfo(vendorId, data);
    
    res.json({
      success: true,
      data: bankInfo,
      message: 'Bank information updated successfully'
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Failed to update bank information',
      error: error.message
    });
  }
};

getBankInfo = async (req: Request, res: Response) => {
  try {
    const vendorId = req.params.id;
    const bankInfo = await this.vendorService.getBankInfo(vendorId);
    
    res.json({
      success: true,
      data: bankInfo
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch bank information',
      error: error.message
    });
  }
};

// ================================
// DOCUMENT MANAGEMENT
// ================================

 uploadDocuments = async (req: Request, res: Response) => {
  try {
    const vendorId = req.params.id;
    
    // Check if files were uploaded
    if (!req.files || typeof req.files !== 'object') {
      return res.status(400).json({
        success: false,
        message: 'No files uploaded'
      });
    }

    const files = req.files as { [fieldname: string]: Express.Multer.File[] };
    const uploadResults: any[] = [];
    const errors: any[] = [];

    // Document type mapping
    const documentTypeMap: Record<string, string> = {
      nationalIdFront: 'NATIONAL_ID_FRONT',
      nationalIdBack: 'NATIONAL_ID_BACK',
      passportFront: 'PASSPORT_FRONT',
      passportBack: 'PASSPORT_BACK',
      tradeLicense: 'TRADE_LICENSE',
      rjscRegistration: 'RJSC_REGISTRATION',
      tinCertificate: 'TIN_CERTIFICATE',
      vatCertificate: 'VAT_CERTIFICATE',
      otherDocument: 'OTHER'
    };

    // Process each uploaded file
    for (const [fieldName, fileArray] of Object.entries(files)) {
      const file = fileArray[0]; // Get first file from array
      const documentType = documentTypeMap[fieldName];

      if (!documentType) {
        errors.push({
          field: fieldName,
          message: `Unknown document type: ${fieldName}`
        });
        continue;
      }

      try {
        // Generate unique filename
        const fileExtension = file.originalname.split('.').pop();
        const timestamp = Date.now();
        const fileName = `${fieldName}-${timestamp}.${fileExtension}`;
        const key = `vendors/${vendorId}/documents/${fileName}`;

        // Upload to Cloudflare R2
        const uploadResult = await uploadToR2({
          file: file.buffer,
          key: key,
          contentType: file.mimetype,
          vendorId: vendorId
        });

        // Save document record to database
        const document = await this.vendorService.uploadDocument(vendorId, {
          type: documentType,
          title: file.originalname,
          filePath: uploadResult.url,
          verificationStatus: 'PENDING'
        });

        uploadResults.push({
          fieldName,
          documentType,
          document,
          uploadUrl: uploadResult.url
        });

      } catch (uploadError: any) {
        console.error(`Error uploading ${fieldName}:`, uploadError);
        errors.push({
          field: fieldName,
          message: uploadError.message
        });
      }
    }

    // Return response
    if (uploadResults.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No documents were uploaded successfully',
        errors
      });
    }

    res.json({
      success: true,
      message: `${uploadResults.length} document(s) uploaded successfully`,
      data: uploadResults,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error: any) {
    console.error('Error uploading documents:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload documents',
      error: error.message
    });
  }
};


 getDocuments=async(req: Request, res: Response)=> {
  try {
    const vendorId = req.params.id;
    const documents = await this.vendorService.getDocuments(vendorId);
    
    res.json({
      success: true,
      data: documents
    });
  } catch (error) {
    console.error('Error fetching documents:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch documents',
      error: error.message
    });
  }
}

 updateDocumentStatus=async(req: Request, res: Response)=> {
  try {
    const documentId = req.params.documentId;
    const { status, rejectionReason } = req.body;

    const document = await this.vendorService.updateDocumentStatus(documentId, status, rejectionReason);
    
    res.json({
      success: true,
      data: document,
      message: 'Document status updated successfully'
    });
  } catch (error) {
    console.error('Error updating document status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update document status',
      error: error.message
    });
  }
}
deleteDocument = async (req: Request, res: Response) => {
  try {
    const { documentId } = req.params;

    const document = await this.vendorService.deleteDocument(documentId);

    res.json({
      success: true,
      message: 'Document deleted successfully',
      data: document
    });
  } catch (error: any) {
    console.error('Error deleting document:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete document',
      error: error.message
    });
  }
};

// ================================
// SUBSCRIPTION MANAGEMENT
// ================================
createOrUpdateSubscription = async (req: Request, res: Response) => {
  try {
    const vendorId = req.params.id;
    const data: VendorSubscriptionRequest = req.body;

    const subscription = await this.vendorService.createOrUpdateSubscription(vendorId, data);
    
    res.json({
      success: true,
      data: subscription,
      message: 'Subscription updated successfully'
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Failed to update subscription',
      error: error.message
    });
  }
};

getSubscription = async (req: Request, res: Response) => {
  try {
    const vendorId = req.params.id;
    const subscription = await this.vendorService.getSubscription(vendorId);
    
    res.json({
      success: true,
      data: subscription
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch subscription',
      error: error.message
    });
  }
};

// ================================
// ONBOARDING & SETTINGS
// ================================
getOnboardingStatus = async (req: Request, res: Response) => {
  try {
    const vendorId = req.params.id;
    const onboardingStatus = await this.vendorService.getOnboardingStatus(vendorId);
    
    res.json({
      success: true,
      data: onboardingStatus
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch onboarding status',
      error: error.message
    });
  }
};

getSettings = async (req: Request, res: Response) => {
  try {
    const vendorId = req.params.id;
    const settings = await this.vendorService.getSettings(vendorId);
    
    res.json({
      success: true,
      data: settings
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch settings',
      error: error.message
    });
  }
};

updateSettings = async (req: Request, res: Response) => {
  try {
    const vendorId = req.params.id;
    const { emailNotifications } = req.body;

    const settings = await this.vendorService.updateSettings(vendorId, emailNotifications);
    
    res.json({
      success: true,
      data: settings,
      message: 'Settings updated successfully'
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Failed to update settings',
      error: error.message
    });
  }
};

  // Commission Management
   setCommissionRate = async (req: Request, res: Response) => {
    console.log(req.params,"bulk")
    try {
      const { id } = req.params;
      const data: VendorCommissionRequest = req.body;

      const result = await this.vendorService.setCommissionRate(id, data);

      res.status(200).json({
        success: true,
        message: `Commission rate set successfully${data.categoryId ? ` for category ${data.categoryId}` : ""}`,
        data: result,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: "Failed to set commission rate",
        error: error.message,
      });
    }
  };

  getCommissionHistory = async (req: Request, res: Response) => {

    try {
      const { id } = req.params;
      const history = await this.vendorService.getCommissionHistory(id);
      
      res.json({
        success: true,
        data: history
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch commission history',
        error: error.message
      });
    }
  };

  bulkUpdateCommissions = async (req: Request, res: Response) => {
      console.log(req.body,"controller data")

    try {
      const data: BulkCommissionUpdateRequest = req.body;
      const result = await this.vendorService.bulkUpdateCommissions(data);
      
      res.json({
        success: true,
        message: `Commission rates updated for ${result.updated} vendors`,
        data: result
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to update commission rates',
        error: error.message
      });
    }
  };

  // Payout Management
  createPayout = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const data: VendorPayoutRequest = req.body;
      
      const payout = await this.vendorService.createPayout(id, data);
      
      res.status(201).json({
        success: true,
        message: 'Payout created successfully',
        data: payout
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to create payout',
        error: error.message
      });
    }
  };

  updatePayoutStatus = async (req: Request, res: Response) => {
    try {
      const { payoutId } = req.params;
      const { status, paidAt } = req.body;
      
      const payout = await this.vendorService.updatePayoutStatus(
        payoutId, 
        status as PayoutStatus, 
        paidAt ? new Date(paidAt) : undefined
      );
      
      res.json({
        success: true,
        message: 'Payout status updated successfully',
        data: payout
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to update payout status',
        error: error.message
      });
    }
  };

  getVendorPayouts = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const payouts = await this.vendorService.getVendorPayouts(id);
      
      res.json({
        success: true,
        data: payouts
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch vendor payouts',
        error: error.message
      });
    }
  };

  getPayoutSummary = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const summary = await this.vendorService.getPayoutSummary(id);
      
      res.json({
        success: true,
        data: summary
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch payout summary',
        error: error.message
      });
    }
  };

  // Monthly Charges
  setMonthlyCharge = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const data: VendorMonthlyChargeRequest = req.body;
      
      const charge = await this.vendorService.setMonthlyCharge(id, data);
      
      res.status(201).json({
        success: true,
        message: 'Monthly charge set successfully',
        data: charge
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to set monthly charge',
        error: error.message
      });
    }
  };

  bulkSetMonthlyCharges = async (req: Request, res: Response) => {
    try {
      const data: BulkMonthlyChargeRequest = req.body;
      const result = await this.vendorService.bulkSetMonthlyCharges(data);
      
      res.json({
        success: true,
        message: `Monthly charges set for ${data.vendorIds.length} vendors`,
        data: result
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to set monthly charges',
        error: error.message
      });
    }
  };

  getVendorCharges = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const charges = await this.vendorService.getVendorCharges(id);
      
      res.json({
        success: true,
        data: charges
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch vendor charges',
        error: error.message
      });
    }
  };

 

  // Performance Monitoring
  getVendorPerformance = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const performance = await this.vendorService.getVendorPerformance(id);
      
      if (!performance) {
        return res.status(404).json({
          success: false,
          message: 'Performance data not found'
        });
      }

      res.json({
        success: true,
        data: performance
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch vendor performance',
        error: error.message
      });
    }
  };

  updateVendorPerformance = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const performance = await this.vendorService.updateVendorPerformance(id);
      
      res.json({
        success: true,
        message: 'Vendor performance updated successfully',
        data: performance
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to update vendor performance',
        error: error.message
      });
    }
  };

  // Fraud Detection
  detectFraud = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const fraudResult = await this.vendorService.detectFraud(id);
      
      res.json({
        success: true,
        data: fraudResult
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to detect fraud',
        error: error.message
      });
    }
  };

  // Flag Management
  flagVendor = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const data: VendorFlagRequest = req.body;
      
      const flag = await this.vendorService.flagVendor(id, data);
      
      res.status(201).json({
        success: true,
        message: 'Vendor flagged successfully',
        data: flag
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Failed to flag vendor',
        error: error.message
      });
    }
  };

  getVendorFlags = async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const flags = await this.vendorService.getVendorFlags(id);
      
      res.json({
        success: true,
        data: flags
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch vendor flags',
        error: error.message
      });
    }
  };

  // // Chat/Conversation Management
  // getVendorConversations = async (req: Request, res: Response) => {
  //   try {
  //     const { vendorId, userId } = req.query;
      
  //     const conversations = await this.vendorService.getVendorConversations(
  //       vendorId as string,
  //       userId as string
  //     );
      
  //     res.json({
  //       success: true,
  //       data: conversations
  //     });
  //   } catch (error: any) {
  //     res.status(500).json({
  //       success: false,
  //       message: 'Failed to fetch conversations',
  //       error: error.message
  //     });
  //   }
  // };

  // getConversationMessages = async (req: Request, res: Response) => {
  //   try {
  //     const { conversationId } = req.params;
  //     const messages = await this.vendorService.getConversationMessages(conversationId);
      
  //     res.json({
  //       success: true,
  //       data: messages
  //     });
  //   } catch (error: any) {
  //     res.status(500).json({
  //       success: false,
  //       message: 'Failed to fetch conversation messages',
  //       error: error.message
  //     });
  //   }
  // };

  // sendMessage = async (req: Request, res: Response) => {
  //   try {
  //     const { conversationId } = req.params;
  //     const { senderId, content, metadata } = req.body;
      
  //     const message = await this.vendorService.sendMessage(
  //       conversationId,
  //       senderId,
  //       content,
  //       metadata
  //     );
      
  //     res.status(201).json({
  //       success: true,
  //       message: 'Message sent successfully',
  //       data: message
  //     });
  //   } catch (error: any) {
  //     res.status(400).json({
  //       success: false,
  //       message: 'Failed to send message',
  //       error: error.message
  //     });
  //   }
  // };

  // Export functionality
  exportVendors = async (req: Request, res: Response) => {
    try {
      const options: VendorExportOptions = {
        format: (req.query.format as 'csv' | 'xlsx') || 'csv',
        fields: (req.query.fields as string)?.split(',') || ['storeName', 'email', 'status'],
        filters: {
          status: req.query.status as VendorStatus,
          search: req.query.search as string,
          // ... other filters
        }
      };
      
      const exportData = await this.vendorService.exportVendors(options);
      
      res.json({
        success: true,
        data: exportData,
        count: exportData.length
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: 'Failed to export vendors',
        error: error.message
      });
    }
  };
}