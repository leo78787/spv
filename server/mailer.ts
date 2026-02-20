/**
 * SMTP mailer for Schichtplan Manager.
 *
 * Uses Strato SMTP to send emails from mail@stullecrew.de.
 * Configuration is read from environment variables or fallback defaults.
 *
 * Required env vars (or set in .env):
 *   SMTP_HOST     — default: smtp.strato.de
 *   SMTP_PORT     — default: 465
 *   SMTP_USER     — default: mail@stullecrew.de
 *   SMTP_PASS     — MUST be set (Strato mailbox password)
 *   SMTP_FROM     — default: Schichtplan Manager <mail@stullecrew.de>
 *   APP_BASE_URL  — default: https://spm.stullecrew.de
 */

import nodemailer from 'nodemailer';

const SMTP_HOST = process.env.SMTP_HOST || 'smtp.strato.de';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465', 10);
const SMTP_USER = process.env.SMTP_USER || 'mail@stullecrew.de';
const SMTP_PASS = process.env.SMTP_PASS || 'Silberhammer108.';
const SMTP_FROM = process.env.SMTP_FROM || 'Schichtplan Manager <mail@stullecrew.de>';
export const APP_BASE_URL = process.env.APP_BASE_URL || 'https://spm.stullecrew.de';

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465, // true for 465 (SSL), false for 587 (STARTTLS)
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
});

export interface MailOptions {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export async function sendMail(opts: MailOptions): Promise<void> {
  if (!SMTP_PASS) {
    console.warn('[mailer] SMTP_PASS not set — email NOT sent to', opts.to);
    console.log('[mailer] Would have sent:', opts.subject);
    return;
  }
  await transporter.sendMail({
    from: SMTP_FROM,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
  });
}

/**
 * Send an invitation email to an employee with their credentials.
 */
export async function sendInvitationEmail(
  to: string,
  employeeName: string,
  username: string,
  oneTimePassword: string,
): Promise<void> {
  const portalUrl = `${APP_BASE_URL}/portal`;
  await sendMail({
    to,
    subject: 'Schichtplan Manager – Ihre Zugangsdaten',
    text: `Hallo ${employeeName},\n\nSie haben Zugangsdaten für den Schichtplan Manager erhalten.\n\nBenutzername: ${username}\nEinmalpasswort: ${oneTimePassword}\n\nLink: ${portalUrl}\n\nBitte melden Sie sich an und vergeben Sie ein neues Passwort.\n\nMit freundlichen Grüßen\nSchichtplan Manager`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #4f46e5; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
          <h2 style="margin:0;">Schichtplan Manager</h2>
        </div>
        <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
          <p>Hallo <strong>${employeeName}</strong>,</p>
          <p>Sie haben Zugangsdaten für den Schichtplan Manager erhalten.</p>
          <table style="margin: 16px 0; border-collapse: collapse;">
            <tr><td style="padding: 8px; font-weight: bold; color: #374151;">Benutzername:</td><td style="padding: 8px; font-family: monospace; background: #f3f4f6; border-radius: 4px;">${username}</td></tr>
            <tr><td style="padding: 8px; font-weight: bold; color: #374151;">Einmalpasswort:</td><td style="padding: 8px; font-family: monospace; background: #f3f4f6; border-radius: 4px;">${oneTimePassword}</td></tr>
          </table>
          <a href="${portalUrl}" style="display: inline-block; background: #4f46e5; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">Zum Portal</a>
          <p style="margin-top: 24px; color: #6b7280; font-size: 14px;">Bitte melden Sie sich an und vergeben Sie ein neues Passwort.</p>
        </div>
      </div>
    `,
  });
}

/**
 * Send a notification to an employee when their shift plan has been released or updated.
 */
export async function sendPlanNotificationEmail(
  to: string,
  employeeName: string,
  message: string,
): Promise<void> {
  const portalUrl = `${APP_BASE_URL}/portal`;
  await sendMail({
    to,
    subject: 'Schichtplan Manager – Aktualisierung',
    text: `Hallo ${employeeName},\n\n${message}\n\nSie können Ihren Schichtplan unter ${portalUrl} einsehen.\n\nMit freundlichen Grüßen\nSchichtplan Manager`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #4f46e5; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
          <h2 style="margin:0;">Schichtplan Manager</h2>
        </div>
        <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
          <p>Hallo <strong>${employeeName}</strong>,</p>
          <p>${message}</p>
          <a href="${portalUrl}" style="display: inline-block; margin-top: 16px; background: #4f46e5; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">Schichtplan ansehen</a>
        </div>
      </div>
    `,
  });
}
