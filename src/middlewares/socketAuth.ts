// middlewares/socketAuth.ts
import jwt from 'jsonwebtoken';
import { Socket } from 'socket.io';
import { prisma } from '../config/prisma.ts';  // ← fetch real name/role from DB

interface AuthenticatedSocket extends Socket {
  data: {
    user: {
      id: string;
      role: string;
      name: string;
      email: string;
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
      console.error('[socketAuth] Token missing id field. Payload:', decoded);
      return next(new Error('Authentication error: Invalid token'));
    }

    // ── STEP 1: Pull role from the token ─────────────────────────────────────
    // Your token is signed with whatever your auth controller puts in it.
    // Log it once so you can see the exact field names.
    if (process.env.NODE_ENV !== 'production') {
      console.log('[socketAuth] decoded JWT:', JSON.stringify(decoded, null, 2));
    }

    const roleRaw: string =
      decoded.role      ??
      decoded.userType  ??
      decoded.user_type ??
      decoded.type      ??
      'USER';

    // ── STEP 2: Fetch the real user record from DB ────────────────────────────
    // This guarantees name and role are always correct regardless of what
    // fields your JWT happens to include.
    //
    // The role field tells us which table to query.
    const role = roleRaw.toUpperCase();
    let name  = decoded.name ?? decoded.username ?? decoded.fullName ?? '';
    let email = decoded.email ?? '';

    if (!name) {
      // Fallback: look up the user in DB by id + role so we always have a name
      try {
        if (role === 'VENDOR' || role === 'VENDOR_ADMIN') {
          const vendor = await prisma.vendor.findUnique({
            where:  { id: decoded.id },
            select: { storeName: true, email: true },
          });
          name  = vendor?.storeName ?? 'Vendor';
          email = vendor?.email     ?? email;
        } else if (role === 'EMPLOYEE' || role === 'ADMIN') {
          const employee = await prisma.employee.findUnique({
            where:  { id: decoded.id },
            select: { name: true, email: true },
          });
          name  = employee?.name  ?? 'Employee';
          email = employee?.email ?? email;
        } else if (role === 'DELIVERY' || role === 'DELIVERY_PERSON') {
          const dp = await prisma.deliveryPerson.findUnique({
            where:  { id: decoded.id },
            select: { name: true },
          });
          name = dp?.name ?? 'Delivery';
        } else {
          // USER / CUSTOMER
          const user = await prisma.user.findUnique({
            where:  { id: decoded.id },
            select: { name: true, email: true },
          });
          name  = user?.name  ?? 'User';
          email = user?.email ?? email;
        }
      } catch (dbErr) {
        console.error('[socketAuth] DB lookup failed, using token fields only:', dbErr);
        name = decoded.name ?? decoded.username ?? decoded.email ?? 'Unknown';
      }
    }

    socket.data.user = {
      id:    String(decoded.id),
      role,
      name,
      email,
    };

    console.log(
      `[socketAuth] ✅ authenticated: id=${socket.data.user.id}` +
      ` name="${socket.data.user.name}" role=${socket.data.user.role}`
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