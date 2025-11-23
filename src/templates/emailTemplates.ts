import { escapeHtml } from "../utils/escapeHtml.ts";

const APP_URL = process.env.APP_URL || "https://yourapp.com";
const APP_NAME = process.env.APP_NAME || "FinixMart";
const BRAND_COLOR = process.env.BRAND_COLOR || "#14b8a6"; // Teal
const BRAND_DARK = "#0d9488"; // Darker teal
const CURRENT_YEAR = new Date().getFullYear();

// Base email wrapper with enhanced styling
const emailWrapper = (content: string) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <!--[if mso]>
  <style type="text/css">
    body, table, td {font-family: Arial, sans-serif !important;}
  </style>
  <![endif]-->
</head>
<body style="margin:0;padding:0;background: linear-gradient(135deg, #f0fdfa 0%, #f4f4f7 100%);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" style="width:100%;border-collapse:collapse;border:0;border-spacing:0;background: linear-gradient(135deg, #f0fdfa 0%, #f4f4f7 100%);">
    <tr>
      <td align="center" style="padding:50px 20px;">
        <!-- Main Container -->
        <table role="presentation" style="width:600px;max-width:600px;border-collapse:collapse;border:0;border-spacing:0;background-color:#ffffff;border-radius:16px;box-shadow:0 10px 25px rgba(20, 184, 166, 0.1), 0 4px 6px rgba(0,0,0,0.05);overflow:hidden;">
          <!-- Decorative Header Bar -->
          <tr>
            <td style="padding:0;background:linear-gradient(135deg, ${BRAND_COLOR} 0%, ${BRAND_DARK} 100%);height:6px;"></td>
          </tr>
          <!-- Logo/Brand Header -->
          <tr>
            <td style="padding:40px 40px 30px 40px;text-align:center;">
              <div style="display:inline-block;padding:12px 24px;background:linear-gradient(135deg, ${BRAND_COLOR} 0%, ${BRAND_DARK} 100%);border-radius:50px;margin-bottom:10px;">
                <h1 style="margin:0;font-size:26px;font-weight:800;color:#ffffff;letter-spacing:0.5px;text-transform:uppercase;">${APP_NAME}</h1>
              </div>
              <div style="height:2px;width:60px;background:linear-gradient(90deg, transparent, ${BRAND_COLOR}, transparent);margin:20px auto;"></div>
            </td>
          </tr>
          <!-- Content Area -->
          <tr>
            <td style="padding:20px 45px 50px 45px;">
              ${content}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:35px 45px;text-align:center;border-top:2px solid #f0fdfa;background:linear-gradient(180deg, #ffffff 0%, #fafafa 100%);">
              <table role="presentation" style="width:100%;border-collapse:collapse;">
                <tr>
                  <td style="text-align:center;padding-bottom:20px;">
                    <div style="display:inline-block;margin:0 8px;">
                      <a href="${APP_URL}" style="display:inline-block;width:36px;height:36px;background-color:#f0fdfa;border-radius:50%;line-height:36px;text-align:center;text-decoration:none;transition:all 0.3s;">
                        <span style="color:${BRAND_COLOR};font-size:18px;">🏠</span>
                      </a>
                    </div>
                    <div style="display:inline-block;margin:0 8px;">
                      <a href="${APP_URL}/support" style="display:inline-block;width:36px;height:36px;background-color:#f0fdfa;border-radius:50%;line-height:36px;text-align:center;text-decoration:none;">
                        <span style="color:${BRAND_COLOR};font-size:18px;">💬</span>
                      </a>
                    </div>
                    <div style="display:inline-block;margin:0 8px;">
                      <a href="${APP_URL}/help" style="display:inline-block;width:36px;height:36px;background-color:#f0fdfa;border-radius:50%;line-height:36px;text-align:center;text-decoration:none;">
                        <span style="color:${BRAND_COLOR};font-size:18px;">❓</span>
                      </a>
                    </div>
                  </td>
                </tr>
                <tr>
                  <td style="padding:15px 0;text-align:center;">
                    <p style="margin:0 0 8px 0;font-size:15px;font-weight:600;color:#1f2937;">
                      ${APP_NAME}
                    </p>
                    <p style="margin:0 0 15px 0;font-size:13px;color:#6b7280;line-height:1.6;">
                      Your trusted e-commerce platform
                    </p>
                  </td>
                </tr>
                <tr>
                  <td style="text-align:center;padding:10px 0;">
                    <a href="${APP_URL}/unsubscribe" style="color:#6b7280;text-decoration:none;font-size:12px;margin:0 8px;transition:color 0.3s;">Unsubscribe</a>
                    <span style="color:#d1d5db;">•</span>
                    <a href="${APP_URL}/privacy" style="color:#6b7280;text-decoration:none;font-size:12px;margin:0 8px;">Privacy</a>
                    <span style="color:#d1d5db;">•</span>
                    <a href="${APP_URL}/terms" style="color:#6b7280;text-decoration:none;font-size:12px;margin:0 8px;">Terms</a>
                  </td>
                </tr>
                <tr>
                  <td style="padding:15px 0 0 0;text-align:center;">
                    <p style="margin:0;font-size:11px;color:#9ca3af;">
                      © ${CURRENT_YEAR} ${APP_NAME}. All rights reserved.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <!-- Bottom Spacing -->
        <table role="presentation" style="width:600px;max-width:600px;margin-top:20px;">
          <tr>
            <td style="text-align:center;padding:10px;">
              <p style="margin:0;font-size:11px;color:#9ca3af;">
                This email was sent to you as a registered user of ${APP_NAME}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

// Enhanced button with modern styling
const createButton = (link: string, text: string, color: string = BRAND_COLOR, darkColor: string = BRAND_DARK) => `
  <table role="presentation" style="margin:35px auto;border-collapse:collapse;">
    <tr>
      <td style="border-radius:12px;background:linear-gradient(135deg, ${color} 0%, ${darkColor} 100%);box-shadow:0 4px 15px rgba(20, 184, 166, 0.3);" align="center">
        <a href="${link}" style="display:inline-block;padding:18px 50px;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:12px;min-width:220px;text-align:center;letter-spacing:0.5px;">
          ${text}
        </a>
      </td>
    </tr>
  </table>
`;

// Info box component
const createInfoBox = (content: string, bgColor: string = "#f0fdfa", borderColor: string = BRAND_COLOR) => `
  <div style="margin-top:35px;padding:24px;background-color:${bgColor};border-radius:12px;border-left:4px solid ${borderColor};box-shadow:0 2px 8px rgba(20, 184, 166, 0.08);">
    ${content}
  </div>
`;

// Icon circle component
const createIconCircle = (icon: string, bgColor: string = "#ccfbf1") => `
  <div style="text-align:center;margin-bottom:30px;">
    <div style="display:inline-block;padding:20px;background:linear-gradient(135deg, ${bgColor} 0%, #f0fdfa 100%);border-radius:50%;box-shadow:0 4px 12px rgba(20, 184, 166, 0.15);margin-bottom:20px;">
      ${icon}
    </div>
  </div>
`;

export const emailTemplates = {
  verifyEmail: ({ name, token }: { name: string; token: string }) => {
    const link = `${APP_URL}/verify-email?token=${encodeURIComponent(token)}`;
    
    const mailIcon = `
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M3 8L10.89 13.26C11.5 13.67 12.5 13.67 13.11 13.26L21 8M5 19H19C20.1046 19 21 18.1046 21 17V7C21 5.89543 20.1046 5 19 5H5C3.89543 5 3 5.89543 3 7V17C3 18.1046 3.89543 19 5 19Z" stroke="${BRAND_COLOR}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
    
    const content = `
      ${createIconCircle(mailIcon)}
      
      <h2 style="margin:0 0 12px 0;font-size:28px;font-weight:800;color:#0f172a;text-align:center;line-height:1.3;">
        Welcome Aboard${name ? ", " + escapeHtml(name) : ""}! 🎉
      </h2>
      
      <p style="margin:0 0 10px 0;font-size:17px;line-height:1.7;color:#475569;text-align:center;font-weight:500;">
        Thanks for joining ${APP_NAME}!
      </p>
      
      <p style="margin:0 0 30px 0;font-size:15px;line-height:1.7;color:#64748b;text-align:center;">
        We're thrilled to have you here. Let's verify your email address to unlock all the amazing features waiting for you.
      </p>
      
      ${createButton(link, "✓ Verify Email Address")}
      
      ${createInfoBox(`
        <p style="margin:0 0 12px 0;font-size:14px;color:#0f766e;line-height:1.6;">
          <strong style="color:#0f766e;font-weight:700;">👋 Button not working?</strong>
        </p>
        <p style="margin:0 0 8px 0;font-size:13px;color:#115e59;line-height:1.5;">
          No worries! Copy and paste this verification link into your browser:
        </p>
        <p style="margin:0;font-size:12px;color:#0d9488;word-break:break-all;font-family:monospace;background-color:#ffffff;padding:10px;border-radius:6px;border:1px solid #99f6e4;">
          <a href="${link}" style="color:#0d9488;text-decoration:none;">${link}</a>
        </p>
      `)}
      
      <div style="margin-top:40px;padding-top:30px;border-top:1px dashed #e2e8f0;text-align:center;">
        <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6;">
          🔒 <strong style="color:#64748b;">Security tip:</strong> This verification link expires in 24 hours.
        </p>
        <p style="margin:10px 0 0 0;font-size:13px;color:#cbd5e1;line-height:1.6;">
          Didn't sign up for ${APP_NAME}? You can safely ignore this email.
        </p>
      </div>
    `;
    
    return {
      subject: `🎉 Welcome to ${APP_NAME} - Verify Your Email`,
      html: emailWrapper(content)
    };
  },

  passwordReset: ({ name, token }: { name: string; token: string }) => {
    const link = `${APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
    
    const lockIcon = `
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 15V17M6 21H18C19.1046 21 20 20.1046 20 19V13C20 11.8954 19.1046 11 18 11H6C4.89543 11 4 11.8954 4 13V19C4 20.1046 4.89543 21 6 21ZM16 11V7C16 4.79086 14.2091 3 12 3C9.79086 3 8 4.79086 8 7V11H16Z" stroke="#f59e0b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
    
    const content = `
      ${createIconCircle(lockIcon, "#fef3c7")}
      
      <h2 style="margin:0 0 12px 0;font-size:28px;font-weight:800;color:#0f172a;text-align:center;line-height:1.3;">
        Password Reset Request 🔐
      </h2>
      
      <p style="margin:0 0 10px 0;font-size:17px;line-height:1.7;color:#475569;text-align:center;font-weight:500;">
        Hello${name ? " " + escapeHtml(name) : ""}!
      </p>
      
      <p style="margin:0 0 30px 0;font-size:15px;line-height:1.7;color:#64748b;text-align:center;">
        We received a request to reset your password. Click the button below to create a new secure password for your account.
      </p>
      
      ${createButton(link, "🔑 Reset My Password", "#f59e0b", "#d97706")}
      
      ${createInfoBox(`
        <p style="margin:0;font-size:14px;color:#92400e;line-height:1.7;">
          <strong style="display:block;margin-bottom:8px;font-weight:700;color:#78350f;">⚠️ Important Security Information</strong>
          This password reset link will expire in <strong>1 hour</strong> for your protection. If you didn't request this reset, please ignore this email or contact our support team immediately if you have security concerns.
        </p>
      `, "#fef3c7", "#f59e0b")}
      
      <div style="margin-top:40px;text-align:center;">
        <div style="display:inline-block;padding:15px 25px;background-color:#fff7ed;border-radius:10px;border:2px dashed #fdba74;">
          <p style="margin:0;font-size:13px;color:#9a3412;font-weight:600;">
            ⏰ Link expires in 60 minutes
          </p>
        </div>
      </div>
      
      <div style="margin-top:35px;padding-top:25px;border-top:1px dashed #e2e8f0;text-align:center;">
        <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6;">
          Need help? Our support team is here 24/7
        </p>
        <p style="margin:8px 0 0 0;">
          <a href="${APP_URL}/support" style="color:${BRAND_COLOR};text-decoration:none;font-size:13px;font-weight:600;">Contact Support →</a>
        </p>
      </div>
    `;
    
    return {
      subject: `🔐 Reset Your ${APP_NAME} Password`,
      html: emailWrapper(content)
    };
  },

  welcomeEmail: ({ name, loginUrl }: { name: string; loginUrl?: string }) => {
    const link = loginUrl || `${APP_URL}/login`;
    
    const checkIcon = `
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M9 12L11 14L15 10M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
    
    const content = `
      ${createIconCircle(checkIcon, "#d1fae5")}
      
      <h2 style="margin:0 0 12px 0;font-size:28px;font-weight:800;color:#0f172a;text-align:center;line-height:1.3;">
        You're All Set! 🎊
      </h2>
      
      <p style="margin:0 0 30px 0;font-size:16px;line-height:1.7;color:#64748b;text-align:center;">
        Congratulations, <strong style="color:${BRAND_COLOR};">${escapeHtml(name)}</strong>! Your email has been verified and your ${APP_NAME} account is ready to rock. Let's get you started on your journey!
      </p>
      
      ${createButton(link, "🚀 Go to Dashboard", "#10b981", "#059669")}
      
      <div style="margin-top:45px;">
        <div style="text-align:center;margin-bottom:25px;">
          <h3 style="margin:0;font-size:20px;font-weight:700;color:#1f2937;display:inline-block;position:relative;">
            Your Next Steps
            <span style="position:absolute;bottom:-8px;left:0;right:0;height:3px;background:linear-gradient(90deg, transparent, ${BRAND_COLOR}, transparent);"></span>
          </h3>
        </div>
        
        <table role="presentation" style="width:100%;border-collapse:collapse;margin-top:30px;">
          <tr>
            <td style="padding:18px;background:linear-gradient(135deg, #f0fdfa 0%, #ffffff 100%);border-radius:12px;margin-bottom:15px;border-left:4px solid ${BRAND_COLOR};box-shadow:0 2px 8px rgba(20, 184, 166, 0.08);">
              <table role="presentation" style="width:100%;">
                <tr>
                  <td style="width:50px;vertical-align:top;">
                    <div style="width:42px;height:42px;background:linear-gradient(135deg, ${BRAND_COLOR} 0%, ${BRAND_DARK} 100%);color:#ffffff;border-radius:50%;text-align:center;line-height:42px;font-weight:700;font-size:18px;box-shadow:0 4px 10px rgba(20, 184, 166, 0.25);">1</div>
                  </td>
                  <td style="vertical-align:top;padding-left:15px;">
                    <p style="margin:0 0 5px 0;font-size:16px;font-weight:700;color:#0f172a;">Complete Your Profile</p>
                    <p style="margin:0;font-size:14px;color:#64748b;line-height:1.5;">Add your details to personalize your experience</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr><td style="height:12px;"></td></tr>
          <tr>
            <td style="padding:18px;background:linear-gradient(135deg, #f0fdfa 0%, #ffffff 100%);border-radius:12px;margin-bottom:15px;border-left:4px solid ${BRAND_COLOR};box-shadow:0 2px 8px rgba(20, 184, 166, 0.08);">
              <table role="presentation" style="width:100%;">
                <tr>
                  <td style="width:50px;vertical-align:top;">
                    <div style="width:42px;height:42px;background:linear-gradient(135deg, ${BRAND_COLOR} 0%, ${BRAND_DARK} 100%);color:#ffffff;border-radius:50%;text-align:center;line-height:42px;font-weight:700;font-size:18px;box-shadow:0 4px 10px rgba(20, 184, 166, 0.25);">2</div>
                  </td>
                  <td style="vertical-align:top;padding-left:15px;">
                    <p style="margin:0 0 5px 0;font-size:16px;font-weight:700;color:#0f172a;">Explore Features</p>
                    <p style="margin:0;font-size:14px;color:#64748b;line-height:1.5;">Discover all the powerful tools at your fingertips</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr><td style="height:12px;"></td></tr>
          <tr>
            <td style="padding:18px;background:linear-gradient(135deg, #f0fdfa 0%, #ffffff 100%);border-radius:12px;border-left:4px solid ${BRAND_COLOR};box-shadow:0 2px 8px rgba(20, 184, 166, 0.08);">
              <table role="presentation" style="width:100%;">
                <tr>
                  <td style="width:50px;vertical-align:top;">
                    <div style="width:42px;height:42px;background:linear-gradient(135deg, ${BRAND_COLOR} 0%, ${BRAND_DARK} 100%);color:#ffffff;border-radius:50%;text-align:center;line-height:42px;font-weight:700;font-size:18px;box-shadow:0 4px 10px rgba(20, 184, 166, 0.25);">3</div>
                  </td>
                  <td style="vertical-align:top;padding-left:15px;">
                    <p style="margin:0 0 5px 0;font-size:16px;font-weight:700;color:#0f172a;">Start Shopping</p>
                    <p style="margin:0;font-size:14px;color:#64748b;line-height:1.5;">Browse thousands of products and find your favorites</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </div>
      
      <div style="margin-top:40px;padding:25px;background:linear-gradient(135deg, #ecfeff 0%, #f0fdfa 100%);border-radius:12px;text-align:center;border:2px solid #99f6e4;">
        <p style="margin:0 0 10px 0;font-size:15px;font-weight:700;color:#0f766e;">
          💡 Need Help Getting Started?
        </p>
        <p style="margin:0 0 15px 0;font-size:13px;color:#115e59;line-height:1.6;">
          Check out our comprehensive guide or reach out to our friendly support team anytime!
        </p>
        <a href="${APP_URL}/guide" style="color:${BRAND_COLOR};text-decoration:none;font-size:14px;font-weight:600;">View Getting Started Guide →</a>
      </div>
    `;
    
    return {
      subject: `🎊 Welcome to ${APP_NAME} - Let's Get Started!`,
      html: emailWrapper(content)
    };
  },

  generic: ({ title, body, ctaText, ctaLink }: { 
    title: string; 
    body: string; 
    ctaText?: string; 
    ctaLink?: string;
  }) => {
    const content = `
      <h2 style="margin:0 0 25px 0;font-size:26px;font-weight:800;color:#0f172a;line-height:1.3;">
        ${escapeHtml(title)}
      </h2>
      <div style="font-size:15px;line-height:1.8;color:#475569;">
        ${body}
      </div>
      ${ctaText && ctaLink ? createButton(ctaLink, ctaText) : ''}
      
      <div style="margin-top:35px;padding-top:25px;border-top:1px dashed #e2e8f0;text-align:center;">
        <p style="margin:0;font-size:13px;color:#94a3b8;">
          Questions? We're here to help!
        </p>
        <p style="margin:8px 0 0 0;">
          <a href="${APP_URL}/support" style="color:${BRAND_COLOR};text-decoration:none;font-size:13px;font-weight:600;">Contact Support</a>
        </p>
      </div>
    `;
    
    return {
      subject: title || "Notification from " + APP_NAME,
      html: emailWrapper(content)
    };
  }
};