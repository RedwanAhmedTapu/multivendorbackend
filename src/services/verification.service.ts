import redisClient from "../config/redis.ts";
import crypto from "crypto";
import axios from "axios";
import { sendEmail } from "../services/email.service.ts";

// ==================== Helper Functions ====================

/**
 * Generate cryptographically secure OTP code
 */
function generateCode(length = 6): string {
  const digits = '0123456789';
  const randomBytes = crypto.randomBytes(length);
  let code = '';
  
  for (let i = 0; i < length; i++) {
    code += digits[randomBytes[i] % 10];
  }
  
  return code;
}

/**
 * Validate Bangladesh phone number format
 */
function isValidPhone(phone: string): boolean {
  // Accepts only numbers starting with 1 and total 10 digits (e.g., 1XXXXXXXXX)
  return /^1[3-9]\d{8}$/.test(phone);
}


/**
 * Validate email format
 */
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Normalize phone number to consistent format
 */
function normalizePhone(phone: string): string {
  return phone.replace(/^\+88/, '');
}

// ==================== Rate Limiting ====================

/**
 * Check if rate limit is exceeded
 * @returns true if rate limited, false otherwise
 */
async function isRateLimited(
  key: string,
  maxAttempts: number,
  windowSeconds: number
): Promise<boolean> {
  const attempts = await redisClient.get(key);
  return attempts !== null && parseInt(attempts) >= maxAttempts;
}

/**
 * Increment rate limit counter
 */
async function incrementRateLimit(key: string, windowSeconds: number): Promise<void> {
  const current = await redisClient.get(key);
  
  if (current === null) {
    await redisClient.set(key, "1", { EX: windowSeconds });
  } else {
    await redisClient.incr(key);
  }
}

// ==================== Phone OTP Service ====================

interface OtpResponse {
  message: string;
  expiresIn: number;
}

/**
 * Send OTP to phone number
 */
export async function sendOtp(phone: string): Promise<OtpResponse> {
  // Validate phone format
  if (!isValidPhone(phone)) {
    throw new Error("Invalid phone number format");
  }

  const normalizedPhone = normalizePhone(phone);

  // Rate limiting: 3 OTP requests per 15 minutes per phone
  const rateLimitKey = `otp:ratelimit:${normalizedPhone}`;
  if (await isRateLimited(rateLimitKey, 5, 15 * 60)) {
    throw new Error("Too many OTP requests. Please try again in 15 minutes.");
  }

  // Generate and store OTP
  const otp = generateCode(6);
  const ttl = 5 * 60; // 5 minutes

  await redisClient.set(`otp:${normalizedPhone}`, otp, { EX: ttl });
  await incrementRateLimit(rateLimitKey, 15 * 60);

  // Send SMS
  try {
    const apiKey = process.env.BULKSMS_API_KEY!;
    const senderId = process.env.BULKSMS_SENDER_ID!;
    const message = `Your FinixMart OTP code is ${otp}. Valid for 5 minutes.`;
    
    // Use HTTPS for security
    const url = `https://bulksmsbd.net/api/smsapi?api_key=${apiKey}&type=text&number=${normalizedPhone}&senderid=${senderId}&message=${encodeURIComponent(message)}`;
    
    const response = await axios.get(url, { 
      timeout: 10000,
      validateStatus: (status) => status < 500
    });

    // Check if SMS provider returned success
    if (response.data && response.data.response_code !== 202) {
      console.error("SMS API error:", response.data);
      throw new Error("SMS delivery failed");
    }

    console.log(`✅ OTP sent to ${normalizedPhone}`);
    return { message: "OTP sent successfully", expiresIn: ttl };
    
  } catch (error) {
    console.error("❌ SMS sending failed:", error);
    // Clean up stored OTP on failure
    await redisClient.del(`otp:${normalizedPhone}`);
    throw new Error("Failed to send OTP. Please try again.");
  }
}

/**
 * Verify OTP code
 */
export async function verifyOtp(
  phone: string, 
  otp: string
): Promise<string | null> {
  if (!isValidPhone(phone)) {
    throw new Error("Invalid phone number format");
  }

  const normalizedPhone = normalizePhone(phone);

  // Rate limiting: 5 verification attempts per 5 minutes
  const attemptsKey = `otp:attempts:${normalizedPhone}`;
  if (await isRateLimited(attemptsKey, 5, 5 * 60)) {
    throw new Error("Too many failed attempts. Please request a new OTP.");
  }

  // Get stored OTP
  const storedOtp = await redisClient.get(`otp:${normalizedPhone}`);

  if (!storedOtp || storedOtp !== otp) {
    await incrementRateLimit(attemptsKey, 5 * 60);
    return null;
  }

  // Success - cleanup all keys
  await Promise.all([
    redisClient.del(`otp:${normalizedPhone}`),
    redisClient.del(attemptsKey),
    redisClient.del(`otp:ratelimit:${normalizedPhone}`)
  ]);

  console.log(`✅ OTP verified for ${normalizedPhone}`);
  return normalizedPhone;
}

// ==================== Email Verification Service ====================

interface EmailVerificationResponse {
  message: string;
  expiresIn: number;
}

interface RegistrationData {
  password: string;
  role: string;
  storeName?: string;
  designation?: string;
  department?: string;
}

/**
 * Send email verification link
 */
export async function sendEmailVerification(
  email: string,
  name = "",
  registrationData?: RegistrationData
): Promise<EmailVerificationResponse> {
  // Validate email format
  if (!isValidEmail(email)) {
    throw new Error("Invalid email format");
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Rate limiting: 3 verification emails per 15 minutes
  const rateLimitKey = `email:ratelimit:${normalizedEmail}`;
  if (await isRateLimited(rateLimitKey, 3, 15 * 60)) {
    throw new Error("Too many verification requests. Please try again in 15 minutes.");
  }

  // Generate token
  const token = crypto.randomBytes(32).toString("hex");
  const ttl = 60 * 60; // 1 hour

  // Store token with email and registration data
  const dataToStore = {
    email: normalizedEmail,
    name: name || "User",
    ...(registrationData && { registrationData })
  };
  
  await redisClient.set(`email:${token}`, JSON.stringify(dataToStore), { EX: ttl });
  await incrementRateLimit(rateLimitKey, 15 * 60);

  // Send verification email
  try {
    await sendEmail({
      to: normalizedEmail,
      template: "verifyEmail",
      data: { name: name || "User", token },
    });

    console.log(`✅ Verification email sent to ${normalizedEmail}`);
    return { message: "Verification email sent", expiresIn: ttl };
    
  } catch (error) {
    console.error("❌ Email sending failed:", error);
    // Clean up token on failure
    await redisClient.del(`email:${token}`);
    throw new Error("Failed to send verification email. Please try again.");
  }
}

/**
 * Verify email token with atomic locking
 */
export async function verifyEmail(
  token: string
): Promise<{ email: string; name: string; registrationData: RegistrationData } | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) {
    throw new Error("Invalid token format");
  }

  const tokenKey = `email:${token}`;
  const lockKey = `lock:email:${token}`;

  // Try to acquire lock with 10 second expiration
  const lockAcquired = await redisClient.set(lockKey, "1", {
    EX: 10,
    NX: true // Only set if not exists
  });

  if (!lockAcquired) {
    console.log(`⏳ Token ${token} is already being processed`);
    throw new Error("Verification already in progress. Please wait.");
  }

  try {
    // Get stored data from token
    const storedData = await redisClient.get(tokenKey);
    
    if (!storedData) {
      console.log(`❌ No verification data found for token: ${token}`);
      return null;
    }

    const data = JSON.parse(storedData);
    console.log(`✅ Email verification data retrieved for: ${data.email}`);
    
    return {
      email: data.email,
      name: data.name,
      registrationData: data.registrationData || {}
    };
  } finally {
    // Release the lock when done
    await redisClient.del(lockKey);
  }
}

/**
 * Consume email verification token (call after successful user creation)
 */
export async function consumeEmailToken(token: string): Promise<void> {
  const tokenKey = `email:${token}`;
  const storedData = await redisClient.get(tokenKey);
  
  if (storedData) {
    const data = JSON.parse(storedData);
    await Promise.all([
      redisClient.del(tokenKey),
      redisClient.del(`email:ratelimit:${data.email}`),
      redisClient.del(`lock:email:${token}`) // Clean up lock too
    ]);
    console.log(`✅ Email verification token consumed for: ${data.email}`);
  }
}

// ==================== Password Reset Service ====================

/**
 * Send password reset email
 */
export async function sendPasswordReset(
  email: string,
  name = ""
): Promise<EmailVerificationResponse> {
  if (!isValidEmail(email)) {
    throw new Error("Invalid email format");
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Rate limiting: 3 reset requests per 15 minutes
  const rateLimitKey = `reset:ratelimit:${normalizedEmail}`;
  if (await isRateLimited(rateLimitKey, 3, 15 * 60)) {
    throw new Error("Too many reset requests. Please try again in 15 minutes.");
  }

  // Generate token
  const token = crypto.randomBytes(32).toString("hex");
  const ttl = 60 * 60; // 1 hour

  // Store token
  await redisClient.set(`reset:${token}`, normalizedEmail, { EX: ttl });
  await incrementRateLimit(rateLimitKey, 15 * 60);

  // Send reset email
  try {
    await sendEmail({
      to: normalizedEmail,
      template: "passwordReset",
      data: { name: name || "User", token },
    });

    console.log(`✅ Password reset email sent to ${normalizedEmail}`);
    return { message: "Password reset email sent", expiresIn: ttl };
    
  } catch (error) {
    console.error("❌ Password reset email failed:", error);
    await redisClient.del(`reset:${token}`);
    throw new Error("Failed to send password reset email. Please try again.");
  }
}

/**
 * Verify password reset token
 */
export async function verifyPasswordReset(token: string): Promise<string | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) {
    throw new Error("Invalid token format");
  }

  const email = await redisClient.get(`reset:${token}`);
  
  if (!email) {
    return null;
  }

  // Note: Don't delete token here - delete it after password is actually changed
  // to prevent replay attacks during the password change process
  console.log(`✅ Password reset token verified for ${email}`);
  return email;
}

/**
 * Consume password reset token (call after password is changed)
 */
export async function consumePasswordResetToken(token: string): Promise<void> {
  const email = await redisClient.get(`reset:${token}`);
  
  if (email) {
    await Promise.all([
      redisClient.del(`reset:${token}`),
      redisClient.del(`reset:ratelimit:${email}`)
    ]);
  }
}