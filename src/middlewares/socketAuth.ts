import jwt from 'jsonwebtoken';
import { Socket } from 'socket.io';
import { prisma } from '../config/prisma.ts';

interface AuthenticatedSocket extends Socket {
  data: {
    user: {
      id: string;       // ← NOW role-specific ID (vendorId for vendors)
      role: string;
      name: string;
      email: string;
      rawId: string;    // ← Original user table ID (kept for reference)
    };
  };
}

export const authenticateSocket = async (
  socket: AuthenticatedSocket,
  next: Function
) => {
  try {
    const raw = socket.handshake.auth.token;
    if (!raw) {
      return next(new Error('Authentication error: No token provided'));
    }

    const cleanToken = raw.replace(/^Bearer\s+/i, '');

    const decoded = jwt.verify(
      cleanToken,
      process.env.ACCESS_TOKEN_SECRET!
    ) as any;

    if (!decoded?.id) {
      return next(new Error('Authentication error: Invalid token'));
    }

    if (process.env.NODE_ENV !== 'production') {
      console.log('[socketAuth] decoded JWT:', JSON.stringify(decoded, null, 2));
    }

    const role = (decoded.role ?? decoded.userType ?? 'USER').toUpperCase();

    // ── FIX: Resolve the ROLE-SPECIFIC ID from the JWT ──────────────────
    // For vendors, the primary identifier is vendorId, not the user table id.
    // Same pattern for employees and delivery persons.
    let effectiveId: string;
    let name  = decoded.name ?? decoded.username ?? decoded.fullName ?? '';
    let email = decoded.email ?? '';

    switch (role) {
      case 'VENDOR':
      case 'VENDOR_ADMIN':
        effectiveId = decoded.vendorId
          ? String(decoded.vendorId)
          : String(decoded.id);
        break;
      case 'EMPLOYEE':
        effectiveId = decoded.employeeId
          ? String(decoded.employeeId)
          : String(decoded.id);
        break;
      case 'DELIVERY':
      case 'DELIVERY_PERSON':
        effectiveId = decoded.deliveryPersonId
          ? String(decoded.deliveryPersonId)
          : String(decoded.id);
        break;
      default:
        effectiveId = String(decoded.id);
    }

    // ── DB lookup for name/email if missing from token ──────────────────
    if (!name) {
      try {
        if (role === 'VENDOR' || role === 'VENDOR_ADMIN') {
          const vendor = await prisma.vendor.findUnique({
            where: { id: effectiveId },  // ← Now uses correct vendor ID
            select: { storeName: true, email: true },
          });
          name  = vendor?.storeName ?? 'Vendor';
          email = vendor?.email ?? email;
        } else if (role === 'EMPLOYEE' || role === 'ADMIN') {
          const employee = await prisma.employee.findUnique({
            where: { id: effectiveId },
            select: { name: true, email: true },
          });
          name  = employee?.name ?? 'Employee';
          email = employee?.email ?? email;
        } else if (role === 'DELIVERY' || role === 'DELIVERY_PERSON') {
          const dp = await prisma.deliveryPerson.findUnique({
            where: { id: effectiveId },
            select: { name: true },
          });
          name = dp?.name ?? 'Delivery';
        } else {
          const user = await prisma.user.findUnique({
            where: { id: effectiveId },
            select: { name: true, email: true },
          });
          name  = user?.name ?? 'User';
          email = user?.email ?? email;
        }
      } catch (dbErr) {
        console.error('[socketAuth] DB lookup failed:', dbErr);
        name = decoded.name ?? 'Unknown';
      }
    }

    // ── FIX: effectiveId is now the role-specific ID ────────────────────
    socket.data.user = {
      id:     effectiveId,   // vendorId for vendors, employeeId for employees, etc.
      rawId:  String(decoded.id),  // Original user table ID kept for reference
      role,
      name,
      email,
    };

    console.log(
      `[socketAuth] ✅ authenticated: id=${effectiveId}` +
      ` (rawId=${decoded.id}) name="${name}" role=${role}`
    );

    next();

  } catch (err: any) {
    console.error('[socketAuth] error:', err.message);
    if (err.name === 'TokenExpiredError') {
      return next(new Error('Authentication error: Token expired'));
    }
    if (err.name === 'JsonWebTokenError') {
      return next(new Error('Authentication error: Invalid token'));
    }
    return next(new Error('Authentication error: Verification failed'));
  }
};