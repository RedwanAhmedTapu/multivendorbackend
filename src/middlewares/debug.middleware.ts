// middlewares/debug.middleware.ts
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';

export const debugFormData = (req: Request, res: Response, next: NextFunction) => {
  console.log('=== DEBUG: Checking request ===');
  console.log('Content-Type:', req.headers['content-type']);
  
  // Use multer to parse ANY field and see what's there
  const upload = multer().any();
  
  upload(req, res, (err) => {
    if (err) {
      console.log('Multer error:', err.message);
    }
    
    console.log('=== DEBUG: After multer parsing ===');
    console.log('Files found:', req.files);
    console.log('Body fields:', Object.keys(req.body));
    
    if (req.files && Array.isArray(req.files)) {
      (req.files as Express.Multer.File[]).forEach((file, index) => {
        console.log(`File ${index + 1}:`, {
          fieldname: file.fieldname,
          originalname: file.originalname,
          mimetype: file.mimetype,
          size: file.size
        });
      });
    }
    
    next();
  });
};