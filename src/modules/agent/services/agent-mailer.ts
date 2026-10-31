// src/modules/agent/services/agent-mailer.ts
//
// Agent emails go through the project's existing email service (generic
// template). The service is imported lazily so loading the agent module never
// opens an SMTP connection; tests replace agentMailer.send.

import { escapeHtml } from "../../../utils/escapeHtml.ts";
import { getAgentAuthConfig } from "../agent.config.ts";

export const agentMailer = {
  async send(to: string, data: { title: string; body: string; ctaText?: string; ctaLink?: string }, subject: string): Promise<void> {
    const { sendEmail } = await import("../../../services/email.service.ts");
    await sendEmail({ to, template: "generic", data, subject });
  },
};

export async function sendAgentPasswordResetEmail(to: string, name: string, token: string): Promise<void> {
  const { appUrl } = getAgentAuthConfig();
  await agentMailer.send(
    to,
    {
      title: "Reset your agent password",
      body: `<p>Hi ${escapeHtml(name)},</p><p>We received a request to reset the password of your FinixMart agent account. This link expires in 30 minutes. If you didn't ask for it, you can ignore this email.</p>`,
      ctaText: "Reset password",
      ctaLink: `${appUrl}/reset-password?token=${encodeURIComponent(token)}`,
    },
    "Reset your FinixMart agent password",
  );
}

export async function sendAgentInviteEmail(to: string, name: string, token: string): Promise<void> {
  const { appUrl } = getAgentAuthConfig();
  await agentMailer.send(
    to,
    {
      title: "Welcome to the FinixMart Agent Program",
      body: `<p>Hi ${escapeHtml(name)},</p><p>An agent account has been created for you. Set your password to sign in. This link expires in 72 hours.</p>`,
      ctaText: "Set your password",
      ctaLink: `${appUrl}/reset-password?token=${encodeURIComponent(token)}&invite=1`,
    },
    "Your FinixMart agent account",
  );
}

export async function sendAgentApprovedEmail(to: string, name: string): Promise<void> {
  const { appUrl } = getAgentAuthConfig();
  await agentMailer.send(
    to,
    {
      title: "Your agent account is approved",
      body: `<p>Hi ${escapeHtml(name)},</p><p>Your FinixMart agent account has been approved. You can sign in now.</p>`,
      ctaText: "Sign in",
      ctaLink: `${appUrl}/login`,
    },
    "Your FinixMart agent account is approved",
  );
}
