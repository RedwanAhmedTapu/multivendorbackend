import redisClient from "../config/redis.ts";
import crypto from "crypto";
import nodemailer from "nodemailer";
import axios from "axios";

// -------------------- Helper --------------------
function generateCode(length = 6) {
  return Math.floor(Math.random() * 10 ** length)
    .toString()
    .padStart(length, "0");
}

// -------------------- Phone OTP --------------------
export async function sendOtp(phone: string) {
  const otp = generateCode(6);
  const ttl = 5 * 60; // 5 minutes

  await redisClient.set(`otp:${phone}`, otp, { EX: ttl });

  // Send OTP via BulkSMSBD
  const apiKey = "8tyZohczoNQBIKMzxE5D";
  const senderId = "8809617614064";
  const message = `Your OTP is ${otp}`;
  const url = `http://bulksmsbd.net/api/smsapi?api_key=${apiKey}&type=text&number=${phone}&senderid=${senderId}&message=${encodeURIComponent(message)}`;
  await axios.get(url);

  return { message: "OTP sent successfully", expiresIn: ttl };
}

export async function verifyOtp(phone: string, otp: string): Promise<string | null> {
  const storedOtp = await redisClient.get(`otp:${phone}`);
  if (!storedOtp || storedOtp !== otp) return null;

  // Delete OTP after verification
  await redisClient.del(`otp:${phone}`);

  // No need to update user here - user will be created as verified in the controller
  return phone;
}

// -------------------- Email Verification --------------------
export async function sendEmailVerification(email: string) {
  const token = crypto.randomBytes(32).toString("hex");
  const ttl = 60 * 60; // 1 hour

  await redisClient.set(`email:${token}`, email, { EX: ttl });
  console.log(process.env.EMAIL_USER, process.env.EMAIL_PASS);

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });

  const link = `${process.env.FRONTEND_URL}/verify-email?token=${token}`;
  await transporter.sendMail({
    from: `"No Reply" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: "Verify your email",
    text: `Click this link to verify your email: ${link}`,
  });

  return { message: "Verification email sent", expiresIn: ttl };
}

export async function verifyEmail(token: string): Promise<string | null> {
  const email = await redisClient.get(`email:${token}`);
  if (!email) return null;

  // Delete token after verification
  await redisClient.del(`email:${token}`);

  // No need to update user here - user will be created as verified in the controller
  return email;
}