// middlewares/up.middleware.ts
import multer from "multer";
import type { Request } from "express";

// Use memory storage for R2 uploads
const storage = multer.memoryStorage();

// File filter for validation
const fileFilter = (
  req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  // Allowed mime types
  const allowedMimes = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/gif',
    'application/pdf',
  ];

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Invalid file type. Allowed: ${allowedMimes.join(', ')}`));
  }
};

/**
 * Create multer upload middleware for vendor storage
 * @param category - File category (product, document, etc.)
 * @param userType - User type (VENDOR, ADMIN)
 * @param vendorId - Optional vendor ID override
 * @param maxFiles - Maximum number of files for array upload
 */
export const imageUpload = (
  category: string,
  userType: "VENDOR" | "ADMIN",
  vendorId?: string,
  maxFiles: number = 1
) => {
  const upload = multer({
    storage,
    limits: {
      fileSize: 5 * 1024 * 1024, // 5MB per file
      files: maxFiles,
    },
    fileFilter,
  });

  // Return appropriate multer middleware based on maxFiles
  if (maxFiles === 1) {
    return upload.single('file');
  } else {
    return upload.array('files', maxFiles);
  }
};

/**
 * Middleware to validate file uploads
 */
export const validateFileUpload = (
  req: Request,
  res: any,
  next: any
) => {
  const file = req.file;
  const files = req.files as Express.Multer.File[];

  if (!file && (!files || files.length === 0)) {
    return res.status(400).json({
      success: false,
      message: "No file uploaded",
    });
  }

  // Additional validation can be added here
  next();
};
export const categoryimageUpload = (
  category: string,
  userType: "VENDOR" | "ADMIN",
  vendorId?: string,
  maxFiles: number = 1,
  fieldName: string = "file" // Add this parameter
) => {
  const upload = multer({
    storage,
    limits: {
      fileSize: 5 * 1024 * 1024, // 5MB per file
      files: maxFiles,
    },
    fileFilter,
  });
console.log(fieldName,"fieldName");
  // Return appropriate multer middleware based on maxFiles
  if (maxFiles === 1) {
    return upload.single(fieldName); // Use the fieldName parameter
  } else {
    return upload.array(fieldName, maxFiles); // Use the fieldName parameter
  }
};

export const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB per file
    files: 10, // Maximum 10 files
  },
  fileFilter: (req, file, cb) => {
    // Allowed mime types for documents
    const allowedMimes = [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/webp',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];

    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Allowed: ${allowedMimes.join(', ')}`));
    }
  }
}).fields([
  { name: 'nationalIdFront', maxCount: 1 },
  { name: 'nationalIdBack', maxCount: 1 },
  { name: 'passportFront', maxCount: 1 },
  { name: 'passportBack', maxCount: 1 },
  { name: 'tradeLicense', maxCount: 1 },
  { name: 'rjscRegistration', maxCount: 1 },
  { name: 'tinCertificate', maxCount: 1 },
  { name: 'vatCertificate', maxCount: 1 },
  { name: 'otherDocument', maxCount: 1 }
]);