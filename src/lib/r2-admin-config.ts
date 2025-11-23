// lib/r2-admin-config.ts
export const R2_ADMIN_CONFIG = {
  bucket: process.env.R2_BUCKET_NAME!,
  endpoint: process.env.R2_ENDPOINT!,
  publicDomain: process.env.R2_PUBLIC_DOMAIN || null,
  adminFolder: "admin", // Root folder for all admin assets
};

// Admin-specific upload function (no quota checks)
export async function uploadToR2Admin(params: {
  file: Buffer;
  key: string;
  contentType: string;
}): Promise<{ url: string; key: string }> {
  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  
  const s3Client = new S3Client({
    region: "auto",
    endpoint: R2_ADMIN_CONFIG.endpoint,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });

  const command = new PutObjectCommand({
    Bucket: R2_ADMIN_CONFIG.bucket,
    Key: params.key,
    Body: params.file,
    ContentType: params.contentType,
    Metadata: {
      uploadedBy: "admin",
      uploadedAt: new Date().toISOString(),
    },
  });

  await s3Client.send(command);

  // Build URL
  const baseUrl = R2_ADMIN_CONFIG.publicDomain
    ? R2_ADMIN_CONFIG.publicDomain
    : `${R2_ADMIN_CONFIG.endpoint}/${R2_ADMIN_CONFIG.bucket}`;

  return {
    key: params.key,
    url: `${baseUrl}/${params.key}`,
  };
}

// Admin-specific delete function
export async function deleteFromR2Admin(key: string): Promise<void> {
  const { S3Client, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
  
  const s3Client = new S3Client({
    region: "auto",
    endpoint: R2_ADMIN_CONFIG.endpoint,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });

  const command = new DeleteObjectCommand({
    Bucket: R2_ADMIN_CONFIG.bucket,
    Key: key,
  });

  await s3Client.send(command);
}

// ========== HELPER FUNCTIONS FOR DIFFERENT FOLDERS ==========

// Category images
export function generateCategoryImageKey(fileName: string): string {
  const timestamp = Date.now();
  const safeFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
  return `${R2_ADMIN_CONFIG.adminFolder}/categories/${timestamp}-${safeFileName}`;
}

// Slider/Banner images
export function generateSliderImageKey(fileName: string): string {
  const timestamp = Date.now();
  const safeFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
  return `${R2_ADMIN_CONFIG.adminFolder}/sliders/${timestamp}-${safeFileName}`;
}

// Product images (if needed for admin)
export function generateProductImageKey(fileName: string): string {
  const timestamp = Date.now();
  const safeFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
  return `${R2_ADMIN_CONFIG.adminFolder}/products/${timestamp}-${safeFileName}`;
}

// User avatars (if needed for admin)
export function generateUserAvatarKey(fileName: string): string {
  const timestamp = Date.now();
  const safeFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
  return `${R2_ADMIN_CONFIG.adminFolder}/avatars/${timestamp}-${safeFileName}`;
}

// Offer banner images - NEW FUNCTION
export function generateOfferBannerKey(offerType: string, fileName: string): string {
  const timestamp = Date.now();
  const safeFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
  const normalizedOfferType = offerType.toLowerCase().replace(/_/g, '-');
  return `${R2_ADMIN_CONFIG.adminFolder}/offerimage/${normalizedOfferType}/${timestamp}-${safeFileName}`;
}

// Alternative: Generic offer image function
export function generateOfferImageKey(fileName: string, offerType?: string): string {
  const timestamp = Date.now();
  const safeFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
  
  if (offerType) {
    const normalizedOfferType = offerType.toLowerCase().replace(/_/g, '-');
    return `${R2_ADMIN_CONFIG.adminFolder}/offerimage/${normalizedOfferType}/${timestamp}-${safeFileName}`;
  }
  
  return `${R2_ADMIN_CONFIG.adminFolder}/offerimage/general/${timestamp}-${safeFileName}`;
}

// Generic function for any folder
export function generateFileKey(folder: string, fileName: string): string {
  const timestamp = Date.now();
  const safeFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
  return `${R2_ADMIN_CONFIG.adminFolder}/${folder}/${timestamp}-${safeFileName}`;
}

// Helper to extract file key from URL - NEW FUNCTION
export function extractFileKeyFromUrl(url: string): string | null {
  try {
    if (!url) return null;
    
    // If using public domain
    if (R2_ADMIN_CONFIG.publicDomain && url.includes(R2_ADMIN_CONFIG.publicDomain)) {
      return url.replace(`${R2_ADMIN_CONFIG.publicDomain}/`, '');
    } 
    // If using direct endpoint URL
    else if (url.includes(R2_ADMIN_CONFIG.endpoint)) {
      return url.replace(`${R2_ADMIN_CONFIG.endpoint}/${R2_ADMIN_CONFIG.bucket}/`, '');
    }
    
    // Fallback: try to extract after bucket name
    const urlParts = url.split('/');
    const bucketIndex = urlParts.indexOf(R2_ADMIN_CONFIG.bucket);
    if (bucketIndex !== -1 && bucketIndex < urlParts.length - 1) {
      return urlParts.slice(bucketIndex + 1).join('/');
    }
    
    // If URL is just the key (relative path)
    if (url.startsWith(R2_ADMIN_CONFIG.adminFolder + '/')) {
      return url;
    }
    
    return null;
  } catch (error) {
    console.error("Error extracting fileKey from URL:", error);
    return null;
  }
}