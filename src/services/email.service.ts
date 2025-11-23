import nodemailer from 'nodemailer';
import { emailTemplates } from "../templates/emailTemplates.ts";

// SMTP configuration for Amazon SES
const smtpConfig = {
  host: process.env.SMTP_HOST || 'email-smtp.us-east-1.amazonaws.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false, // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USERNAME,
    pass: process.env.SMTP_PASSWORD,
  },
  // Increased timeouts for SES
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 10000,
};

// Create transporter
const transporter = nodemailer.createTransport(smtpConfig);

// Verify SMTP connection on startup
transporter.verify(function (error, success) {
  if (error) {
    console.error('❌ SMTP connection failed:', error);
  } else {
    console.log('✅ SMTP server is ready to take messages');
    console.log(`   Host: ${smtpConfig.host}`);
    console.log(`   Port: ${smtpConfig.port}`);
  }
});

interface SendEmailOptions {
  to: string;
  template: keyof typeof emailTemplates;
  data: any;
  subject?: string;
  text?: string;
}

/**
 * Send email using Nodemailer with SMTP
 */
export const sendEmail = async ({ 
  to, 
  template, 
  data,
  subject,
  text
}: SendEmailOptions): Promise<void> => {
  // Validate email
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    throw new Error("Invalid recipient email address");
  }

  // Get email content from template
  const templateContent = emailTemplates[template](data);
  const emailSubject = subject || templateContent.subject;
  const emailHtml = templateContent.html;
  const emailText = text || templateContent.text || 
    templateContent.html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

  const fromEmail = process.env.SMTP_FROM_EMAIL;
  
  if (!fromEmail) {
    throw new Error("SMTP_FROM_EMAIL environment variable not set");
  }

  const mailOptions = {
    from: {
      name: process.env.SMTP_FROM_NAME || 'FinixMart',
      address: fromEmail
    },
    to: to,
    subject: emailSubject,
    text: emailText,
    html: emailHtml,
    // Additional headers for better deliverability
    headers: {
      'X-Priority': '1',
      'X-MSMail-Priority': 'High',
      'Importance': 'high'
    }
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    
    console.log("✅ Email sent successfully");
    console.log(`   To: ${to}`);
    console.log(`   Template: ${template}`);
    console.log(`   MessageId: ${info.messageId}`);
    console.log(`   Response: ${info.response}`);
    
  } catch (error: any) {
    console.error("❌ Error sending email:", {
      to,
      template,
      error: error.message,
      code: error.code,
      command: error.command
    });

    // Handle specific SMTP errors
    if (error.code === 'EAUTH') {
      throw new Error(
        "SMTP authentication failed. Check your SMTP credentials."
      );
    }
    
    if (error.code === 'ECONNECTION') {
      throw new Error(
        "Cannot connect to SMTP server. Check host and port configuration."
      );
    }

    if (error.code === 'ETIMEDOUT') {
      throw new Error(
        "SMTP connection timed out. Please try again."
      );
    }

    // Generic error
    throw new Error(`Email delivery failed: ${error.message}`);
  }
};

/**
 * Validate SMTP configuration on startup
 */
export const validateSMTPConfig = (): boolean => {
  const required = [
    'SMTP_HOST',
    'SMTP_USERNAME', 
    'SMTP_PASSWORD',
    'SMTP_FROM_EMAIL'
  ];

  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    console.error("❌ Missing required environment variables:", missing.join(", "));
    return false;
  }

  console.log("✅ SMTP configuration validated");
  console.log(`   Host: ${process.env.SMTP_HOST}`);
  console.log(`   Port: ${process.env.SMTP_PORT || '587'}`);
  console.log(`   From: ${process.env.SMTP_FROM_EMAIL}`);
  
  return true;
};

/**
 * Close SMTP connection (for graceful shutdown)
 */
export const closeSMTPConnection = async (): Promise<void> => {
  try {
    await transporter.close();
    console.log('✅ SMTP connection closed');
  } catch (error) {
    console.error('❌ Error closing SMTP connection:', error);
  }
};

export default transporter;