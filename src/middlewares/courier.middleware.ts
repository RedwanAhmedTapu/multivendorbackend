// courier.middleware.ts - Middleware for courier routes

import type { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Error handler middleware
 */
export const courierErrorHandler = (
  error: any,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  console.error('Courier API Error:', error);

  // Check if response already sent
  if (res.headersSent) {
    return next(error);
  }

  // Handle specific error types
  if (error.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      message: 'Validation error',
      errors: error.errors || error.message,
    });
  }

  if (error.name === 'UnauthorizedError' || error.message.includes('Unauthorized')) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized access',
      error: error.message,
    });
  }

  if (error.message.includes('not found') || error.message.includes('Not found')) {
    return res.status(404).json({
      success: false,
      message: 'Resource not found',
      error: error.message,
    });
  }

  // Handle Axios errors
  if (error.isAxiosError) {
    const status = error.response?.status || 500;
    return res.status(status).json({
      success: false,
      message: 'Courier API request failed',
      error: error.response?.data?.message || error.message,
      details: error.response?.data,
    });
  }

  // Handle Prisma errors
  if (error.code && error.code.startsWith('P')) {
    return res.status(400).json({
      success: false,
      message: 'Database operation failed',
      error: error.message,
    });
  }

  // Default error response
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong',
  });
};

/**
 * Authentication middleware - Verify user/vendor
 */
export const authenticate = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    // Extract token from header
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Authentication token required',
      });
    }

    // TODO: Verify JWT token and extract user/vendor info
    // This is a placeholder - implement your actual authentication logic
    // const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // req.user = decoded;

    next();
  } catch (error) {
    res.status(401).json({
      success: false,
      message: 'Invalid authentication token',
    });
  }
};

/**
 * Vendor authorization middleware
 */
export const authorizeVendor = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const vendorId = req.body.vendorId || req.query.vendorId;

    if (!vendorId) {
      return res.status(400).json({
        success: false,
        message: 'Vendor ID is required',
      });
    }

    // TODO: Verify that the authenticated user has access to this vendor
    // const user = req.user;
    // if (user.vendorId !== vendorId && !user.isAdmin) {
    //   return res.status(403).json({
    //     success: false,
    //     message: 'Access denied to this vendor',
    //   });
    // }

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Validate courier provider middleware
 */
export const validateCourierProvider = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const courierProviderId = req.body.courierProviderId || req.query.courierProviderId;

    if (!courierProviderId) {
      return res.status(400).json({
        success: false,
        message: 'Courier provider ID is required',
      });
    }

    // Check if courier provider exists and is active
    const provider = await prisma.courier_providers.findFirst({
      where: {
        id: courierProviderId as string,
        isActive: true,
      },
    });

    if (!provider) {
      return res.status(404).json({
        success: false,
        message: 'Courier provider not found or inactive',
      });
    }

    // Attach provider to request for later use
    (req as any).courierProvider = provider;

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Rate limiting middleware for webhook endpoints
 */
export const webhookRateLimit = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // TODO: Implement rate limiting logic
  // For production, use a proper rate limiting library like express-rate-limit
  // or implement Redis-based rate limiting
  next();
};

/**
 * Webhook signature verification middleware
 */
export const verifyWebhookSignature = (provider: 'pathao' | 'redx') => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      // TODO: Implement signature verification based on provider
      // Each courier service may have different signature verification methods

      if (provider === 'pathao') {
        // Pathao webhook verification logic
        // const signature = req.headers['x-pathao-signature'];
        // Verify signature
      } else if (provider === 'redx') {
        // RedX webhook verification logic
        // const token = req.query.token;
        // Verify token
      }

      next();
    } catch (error) {
      res.status(401).json({
        success: false,
        message: 'Webhook signature verification failed',
      });
    }
  };
};

/**
 * Request logger middleware
 */
export const courierRequestLogger = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const startTime = Date.now();

  // Log request
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);

  // Log response
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`
    );
  });

  next();
};

/**
 * Validate environment middleware
 */
export const validateEnvironment = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const environment = req.body.environment || req.query.environment || 'PRODUCTION';

  if (!['SANDBOX', 'PRODUCTION'].includes(environment)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid environment. Must be SANDBOX or PRODUCTION',
    });
  }

  next();
};

/**
 * Sanitize input middleware
 */
export const sanitizeInput = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // Remove any potential XSS or injection attempts
  const sanitize = (obj: any): any => {
    if (typeof obj === 'string') {
      // Basic sanitization - enhance based on your needs
      return obj.trim().replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    }
    if (Array.isArray(obj)) {
      return obj.map(sanitize);
    }
    if (obj && typeof obj === 'object') {
      const sanitized: any = {};
      for (const key in obj) {
        sanitized[key] = sanitize(obj[key]);
      }
      return sanitized;
    }
    return obj;
  };

  req.body = sanitize(req.body);
  req.query = sanitize(req.query);

  next();
};

/**
 * Validate request body schema
 */
export const validateSchema = (schema: any) => {
  return (req: Request, res: Response, next: NextFunction) => {
    // TODO: Implement schema validation using Joi, Yup, or Zod
    // Example with Joi:
    // const { error, value } = schema.validate(req.body);
    // if (error) {
    //   return res.status(400).json({
    //     success: false,
    //     message: 'Validation error',
    //     errors: error.details.map(d => d.message),
    //   });
    // }
    // req.body = value;
    next();
  };
};

/**
 * CORS middleware for webhook endpoints
 */
export const webhookCors = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // Allow webhook requests from courier providers
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST');
  res.header('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  next();
};

/**
 * Check credentials availability middleware
 */
export const checkCredentials = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { courierProviderId, vendorId, environment = 'PRODUCTION' } = 
      req.body.courierProviderId ? req.body : req.query;

    const credentials = await prisma.courier_credentials.findFirst({
      where: {
        courierProviderId: courierProviderId as string,
        vendorId: vendorId as string || null,
        environment: environment as 'SANDBOX' | 'PRODUCTION',
        isActive: true,
      },
    });

    if (!credentials) {
      return res.status(404).json({
        success: false,
        message: 'Courier credentials not found or inactive',
      });
    }

    // Attach credentials to request
    (req as any).courierCredentials = credentials;

    next();
  } catch (error) {
    next(error);
  }
};