import type { Request, Response } from "express";
import * as authService from "../services/auth.service.ts";
import * as verificationService from "../services/verification.service.ts";
import * as emailService from "../services/email.service.ts";
import jwt from "jsonwebtoken";
import { prisma } from "../config/prisma.ts";
import axios from "axios";
import bcrypt from "bcryptjs";


const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || "refresh-secret";

// ------------------- Register -------------------
export const register = async (req: Request, res: Response) => {
  try {
    const { email, phone, name, password, role, storeName, designation, department } = req.body;
    
    if (!email && !phone)
      return res.status(400).json({ message: "Email or phone required" });

    if (email) {
      // For email: only send verification link with data, DON'T create user yet
      await verificationService.sendEmailVerification(
        email, 
        name,
        { password, role, storeName, designation, department }
      );
      return res.json({ message: "Check your email to verify account" });
    }
    
    if (phone) {
      // For phone: just send OTP, user will be created after OTP verification
      await verificationService.sendOtp(phone);
      return res.json({ message: "OTP sent to phone" });
    }
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
};

// ------------------- Verify Email -------------------
export const verifyEmail = async (req: Request, res: Response) => {
  let verificationData = null;
  
  try {
    const { token } = req.body;
    console.log(`🔍 Verifying email with token: ${token}`);

    // Get email and stored registration data from token
    verificationData = await verificationService.verifyEmail(token);
    if (!verificationData) {
      console.log('❌ Invalid or expired token');
      return res.status(400).json({ message: "Invalid or expired token" });
    }

    const { email, name, registrationData } = verificationData;
    console.log(`🔍 Verification data retrieved for email: ${email}`);

    // Double-check if user already exists
    const existingUser = await prisma.user.findFirst({
      where: { email }
    });
    
    if (existingUser) {
      console.log(`❌ User already exists with email: ${email}, user ID: ${existingUser.id}`);
      // Consume the token since user already exists
      await verificationService.consumeEmailToken(token);
      return res.status(400).json({ 
        message: "User already exists. Please login instead." 
      });
    }

    console.log(`✅ Creating user for email: ${email}`);
    
    // Now create the user with stored data
    const user = await authService.registerUser({
      name: name,
      email,
      password: registrationData.password,
      role: registrationData.role,
      storeName: registrationData.storeName,
      designation: registrationData.designation,
      department: registrationData.department,
      isVerified: true,
    });

    console.log(`✅ User created successfully with ID: ${user.id}`);
    
    // ✅ ONLY NOW consume the token after successful user creation
    await verificationService.consumeEmailToken(token);
    
    res.json({ message: "Email verified & account created", user });
    
  } catch (err: any) {
    console.error('💥 Error in verifyEmail:', err.message);
    
    // Handle specific error cases
    if (err.message.includes("Verification already in progress")) {
      return res.status(429).json({ 
        message: "Verification already in progress. Please wait a moment." 
      });
    }
    
    if (err.code === 'P2002' && err.meta?.target?.includes('email')) {
      // If user creation failed due to duplicate, consume the token
      if (verificationData) {
        await verificationService.consumeEmailToken(req.body.token);
      }
      return res.status(400).json({ 
        message: "User already exists. Please login instead." 
      });
    }
    
    res.status(400).json({ message: err.message });
  }
};

// ------------------- Verify OTP -------------------
export const verifyOtp = async (req: Request, res: Response) => {
  try {
    const { phone, otp, name, password, role, storeName, designation, department } = req.body;

    const verifiedPhone = await verificationService.verifyOtp(phone, otp);
    if (!verifiedPhone) return res.status(400).json({ message: "Invalid or expired OTP" });

    const user = await authService.registerUser({
      name,
      phone: verifiedPhone,
      password,
      role,
      storeName,
      designation,
      department,
      isVerified: true,
    });

    res.json({ message: "Phone verified & account created", user });
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
};

// ------------------- Login -------------------
export const login = async (req: Request, res: Response) => {
  try {
    const { email, phone, password } = req.body;
    const { user, accessToken, refreshToken } = await authService.loginUser(email, phone, password);

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 24 * 60 * 60 * 1000,
    });

    res.json({ message: "Login successful", accessToken, user });
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
};
// ------------------- Social Login -------------------
export const socialLogin = async (req: Request, res: Response) => {
  try {
    const { provider, token } = req.body;
    console.log("📥 Social login request:", { provider, tokenLength: token?.length });

    if (!provider || !token) {
      return res.status(400).json({ message: "Provider and token required" });
    }

    let email: string;
    let name: string;
    let picture: string | undefined;

    // 1️⃣ Verify token with Google (JWT ID Token)
    if (provider === "google") {
      try {
        console.log("🔍 Verifying Google JWT token...");
        
        // Google Sign-In sends a JWT ID token, not an access token
        // Use tokeninfo endpoint to verify it
        const googleRes = await axios.get(
          `https://oauth2.googleapis.com/tokeninfo?id_token=${token}`
        );
        
        console.log("✅ Google API response:", googleRes.data);
        
        const profileData = googleRes.data;
        
        // Verify the token is for your app
        const expectedClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
        if (profileData.aud !== expectedClientId) {
          console.error("❌ Token audience mismatch:", {
            received: profileData.aud,
            expected: expectedClientId
          });
          return res.status(401).json({ message: "Invalid Google token - audience mismatch" });
        }
        
        email = profileData.email;
        name = profileData.name || profileData.given_name || "User";
        picture = profileData.picture;
        
        // Check if email is verified
        if (!profileData.email_verified) {
          console.error("❌ Email not verified by Google");
          return res.status(400).json({ message: "Google email not verified" });
        }
        
        console.log(`✅ Google token verified for: ${email}`);
        
      } catch (error: any) {
        console.error("💥 Google token verification failed:", {
          message: error.message,
          response: error.response?.data,
          status: error.response?.status
        });
        
        return res.status(401).json({ 
          message: "Invalid Google token",
          error: error.response?.data?.error_description || error.message 
        });
      }
    }

    // 2️⃣ Verify token with Facebook (Access Token)
    else if (provider === "facebook") {
      try {
        console.log("🔍 Verifying Facebook access token...");
        
        const fbRes = await axios.get(
          `https://graph.facebook.com/me?fields=id,name,email,picture&access_token=${token}`
        );
        
        console.log("✅ Facebook API response:", fbRes.data);
        
        const profileData = fbRes.data;
        
        email = profileData.email;
        name = profileData.name || "User";
        picture = profileData.picture?.data?.url;
        
        console.log(`✅ Facebook token verified for: ${email}`);
        
      } catch (error: any) {
        console.error("💥 Facebook token verification failed:", {
          message: error.message,
          response: error.response?.data,
          status: error.response?.status
        });
        
        return res.status(401).json({ 
          message: "Invalid Facebook token",
          error: error.response?.data?.error?.message || error.message 
        });
      }
    } 
    
    else {
      return res.status(400).json({ message: "Unsupported provider" });
    }

    // Validate email
    if (!email) {
      console.error("❌ No email returned by provider");
      return res.status(400).json({ message: "No email returned by provider" });
    }

    // Check if user exists
    let user = await prisma.user.findFirst({ 
      where: { email },
      include: { 
        vendor: true, 
        employee: true, 
        customerProfile: true 
      }
    });

    if (!user) {
      // Create new user for first-time social login
      console.log(`📝 Creating new user via ${provider}: ${email}`);
      
      user = await prisma.user.create({
        data: {
          name,
          email,
          password: "", // no password for social login users
          role: "CUSTOMER", // default role
          isVerified: true, // social login emails are pre-verified
          provider, // "google" or "facebook"
          customerProfile: {
            create: {} // Create customer profile for new social users
          }
        },
        include: { 
          vendor: true, 
          employee: true, 
          customerProfile: true 
        }
      });
      
      console.log(`✅ New user created via ${provider}: ${email} (ID: ${user.id})`);
    } else {
      // Update provider info if user exists but doesn't have it set
      if (!user.provider) {
        await prisma.user.update({
          where: { id: user.id },
          data: { provider }
        });
        console.log(`✅ Updated existing user with ${provider} provider: ${email}`);
      } else {
        console.log(`✅ Existing user logged in via ${provider}: ${email} (ID: ${user.id})`);
      }
    }

    // Generate access + refresh tokens
    const { accessToken, refreshToken } = authService.generateTokens(user);

    // Set refresh token in HTTP-only cookie
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    console.log(`✅ Social login successful for: ${email}`);

    return res.status(200).json({
      message: "Social login successful",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        isVerified: user.isVerified,
        provider: user.provider,
        vendorId: user.vendorId,
        employeeId: user.employeeId,
      },
      accessToken,
    });
    
  } catch (err: any) {
    console.error("💥 Unexpected error in socialLogin:", {
      message: err.message,
      stack: err.stack
    });
    
    return res.status(500).json({ 
      message: "Internal server error during social login",
      error: process.env.NODE_ENV === "development" ? err.message : undefined
    });
  }
};

// ------------------- Forgot Password -------------------
export const forgotPassword = async (req: Request, res: Response) => {
  try {
    const { email, phone } = req.body;

    if (!email && !phone) {
      return res.status(400).json({ message: "Email or phone required" });
    }

    if (email) {
      // Find user by email
      const user = await prisma.user.findFirst({
        where: { email }
      });

      if (!user) {
        // Don't reveal if user exists for security
        return res.json({ 
          message: "If an account with that email exists, a password reset link has been sent" 
        });
      }

      // Send password reset email
      await verificationService.sendPasswordReset(email, user.name || "");
      return res.json({ 
        message: "If an account with that email exists, a password reset link has been sent" 
      });
    }

    if (phone) {
      // Find user by phone
      const user = await prisma.user.findFirst({
        where: { phone }
      });

      if (!user) {
        // Don't reveal if user exists for security
        return res.json({ 
          message: "If an account with that phone exists, an OTP has been sent" 
        });
      }

      // Send OTP for phone reset
      await verificationService.sendOtp(phone);
      return res.json({ 
        message: "If an account with that phone exists, an OTP has been sent" 
      });
    }
  } catch (err: any) {
    console.error('💥 Error in forgotPassword:', err.message);
    res.status(400).json({ message: err.message });
  }
};

// ------------------- Verify Reset Token -------------------
export const verifyResetToken = async (req: Request, res: Response) => {
  try {
    const { token, phone, otp } = req.body;

    if (token) {
      // Email reset token verification
      const email = await verificationService.verifyPasswordReset(token);
      if (!email) {
        return res.status(400).json({ message: "Invalid or expired reset token" });
      }

      return res.json({ 
        message: "Reset token verified", 
        email,
        type: "email" 
      });
    }

    if (phone && otp) {
      // Phone OTP verification
      const verifiedPhone = await verificationService.verifyOtp(phone, otp);
      if (!verifiedPhone) {
        return res.status(400).json({ message: "Invalid or expired OTP" });
      }

      return res.json({ 
        message: "OTP verified", 
        phone: verifiedPhone,
        type: "phone" 
      });
    }

    return res.status(400).json({ message: "Token or OTP required" });
  } catch (err: any) {
    console.error('💥 Error in verifyResetToken:', err.message);
    res.status(400).json({ message: err.message });
  }
};

// ------------------- Reset Password -------------------
export const resetPassword = async (req: Request, res: Response) => {
  try {
    const { token, phone, otp, newPassword, confirmPassword } = req.body;

    // Validate passwords
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ message: "Passwords do not match" });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }

    let user = null;

    if (token) {
      // Email-based password reset
      const email = await verificationService.verifyPasswordReset(token);
      if (!email) {
        return res.status(400).json({ message: "Invalid or expired reset token" });
      }

      user = await prisma.user.findFirst({
        where: { email }
      });

      if (!user) {
        return res.status(400).json({ message: "User not found" });
      }

      // Update password
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      await prisma.user.update({
        where: { id: user.id },
        data: { password: hashedPassword }
      });

      // Consume the token after successful password reset
      await verificationService.consumePasswordResetToken(token);

      return res.json({ message: "Password reset successfully" });
    }

    if (phone && otp) {
      // Phone-based password reset
      const verifiedPhone = await verificationService.verifyOtp(phone, otp);
      if (!verifiedPhone) {
        return res.status(400).json({ message: "Invalid or expired OTP" });
      }

      user = await prisma.user.findFirst({
        where: { phone: verifiedPhone }
      });

      if (!user) {
        return res.status(400).json({ message: "User not found" });
      }

      // Update password
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      await prisma.user.update({
        where: { id: user.id },
        data: { password: hashedPassword }
      });

      return res.json({ message: "Password reset successfully" });
    }

    return res.status(400).json({ message: "Token or OTP required" });
  } catch (err: any) {
    console.error('💥 Error in resetPassword:', err.message);
    res.status(400).json({ message: err.message });
  }
};
// ------------------- Refresh Token -------------------
export const refresh = (req: Request, res: Response) => {
  const token = req.cookies.refreshToken;
  if (!token) return res.status(401).json({ message: "Refresh token not found" });

  jwt.verify(token, REFRESH_TOKEN_SECRET, (err: any, payload: any) => {
    if (err) return res.status(403).json({ message: "Invalid refresh token" });

    const accessToken = jwt.sign(
      {
        id: payload.id,
        role: payload.role,
        vendorId: payload.vendorId ?? null,
        emailorphone: payload.emailorphone ?? null,
      },
      process.env.ACCESS_TOKEN_SECRET || "access-secret",
      { expiresIn: "3h" }
    );
    res.json({ accessToken });
  });
};

// ------------------- Logout -------------------
export const logout = (req: Request, res: Response) => {
  res.clearCookie("refreshToken", { httpOnly: true, sameSite: "strict" });
  res.json({ message: "Logged out successfully" });
};