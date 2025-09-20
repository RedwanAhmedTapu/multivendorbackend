// middleware/socketAuth.ts
import jwt from 'jsonwebtoken';
import { Socket } from 'socket.io';

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

export const authenticateSocket = async (socket: AuthenticatedSocket, next: Function) => {
  try {
    const token = socket.handshake.auth.token;
    
    if (!token) {
      console.log('No token provided in socket connection');
      return next(new Error('Authentication error: No token provided'));
    }

    // Remove 'Bearer ' prefix if present
    const cleanToken = token.replace('Bearer ', '');

    // Verify the JWT token
    const decoded = jwt.verify(cleanToken, process.env.ACCESS_TOKEN_SECRET!) as any;
    
    if (!decoded || !decoded.id) {
      console.log('Invalid token in socket connection');
      return next(new Error('Authentication error: Invalid token'));
    }

    // Optional: Check if user exists in database
    // const user = await User.findById(decoded.id);
    // if (!user) {
    //   return next(new Error('Authentication error: User not found'));
    // }

    // Attach user data to socket
    socket.data.user = {
      id: decoded.id,
      role: decoded.role || decoded.userType, // Handle different token structures
      name: decoded.name || decoded.username,
      email: decoded.email,
    };

    console.log(`Socket authentication successful for user: ${decoded.id} (${decoded.name || decoded.username})`);
    next();
    
  } catch (error) {
    console.error('Socket authentication error:', error);
    
    if (error.name === 'JsonWebTokenError') {
      return next(new Error('Authentication error: Invalid token format'));
    } else if (error.name === 'TokenExpiredError') {
      return next(new Error('Authentication error: Token expired'));
    } else {
      return next(new Error('Authentication error: Token verification failed'));
    }
  }
};