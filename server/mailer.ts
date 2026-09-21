/**
 * SMTP mailer for Schichtplan Manager.
 *
 * Sends mail via the local Postfix relay (DKIM-signed by OpenDKIM), the same
 * pattern used by the other apps on this host. No SMTP auth is required for
 * the local relay. All values are configured via environment variables set
 * in the systemd unit — there are no credential fallbacks in source.
 *
 * Env vars (set via systemd Environment=):
 *   SMTP_HOST     — default: 127.0.0.1
 *   SMTP_PORT     — default: 25
 *   SMTP_USER     — default: (empty, no auth against local relay)
 *   SMTP_PASS     — default: (empty, no auth against local relay)
 *   SMTP_FROM     — default: Schichtplan Manager <noreply@schichtapp.de>
 *   APP_BASE_URL  — default: https://schichtapp.de
 *                   Base URL of the employee portal (its own domain/root,
 *                   NOT the admin app, which now lives on a separate
 *                   admin.schichtapp.de subdomain).
 */

import nodemailer from 'nodemailer';

const SMTP_HOST = process.env.SMTP_HOST || '127.0.0.1';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '25', 10);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || 'Schichtplan Manager <noreply@schichtapp.de>';
export const APP_BASE_URL = process.env.APP_BASE_URL || 'https://schichtapp.de';

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465, // true for 465 (SSL), false for 587 (STARTTLS)
  // The local Postfix relay does not require/offer auth; only send
  // credentials if a user was explicitly configured (e.g. external SMTP).
  auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  // The local relay offers opportunistic STARTTLS with a self-signed
  // certificate (OpenDKIM/Postfix setup), which Node rejects by default.
  tls: { rejectUnauthorized: false },
});

export interface MailAttachment {
  filename: string;
  content: string | Buffer;
  contentType?: string;
}

export interface MailOptions {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: MailAttachment[];
}

export async function sendMail(opts: MailOptions): Promise<void> {
  await transporter.sendMail({
    from: SMTP_FROM,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
    attachments: opts.attachments,
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
  const portalUrl = APP_BASE_URL;
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
 * Send an invitation email to a newly created admin-panel user (Leitung or Manager).
 */
export async function sendAdminInviteEmail(
  to: string,
  name: string,
  organizationName: string,
  role: 'admin' | 'leitung' | 'betrachter',
  oneTimePassword: string,
): Promise<void> {
  const adminUrl = process.env.ADMIN_BASE_URL || 'https://admin.schichtapp.de';
  const roleLabel = role === 'admin' ? 'Admin' : role === 'leitung' ? 'Leitung' : 'Betrachter';
  await sendMail({
    to,
    subject: `Schichtplan Manager – Zugang für ${organizationName}`,
    text: `Hallo ${name},\n\nSie wurden als ${roleLabel} für "${organizationName}" im Schichtplan Manager eingerichtet.\n\nE-Mail: ${to}\nEinmalpasswort: ${oneTimePassword}\n\nAdmin-Bereich: ${adminUrl}\n\nBitte melden Sie sich an und vergeben Sie ein neues Passwort.\n\nMit freundlichen Grüßen\nSchichtplan Manager`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #4f46e5; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
          <h2 style="margin:0;">Schichtplan Manager</h2>
        </div>
        <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
          <p>Hallo <strong>${name}</strong>,</p>
          <p>Sie wurden als <strong>${roleLabel}</strong> für <strong>${organizationName}</strong> im Schichtplan Manager eingerichtet.</p>
          <table style="margin: 16px 0; border-collapse: collapse;">
            <tr><td style="padding: 8px; font-weight: bold; color: #374151;">E-Mail:</td><td style="padding: 8px; font-family: monospace; background: #f3f4f6; border-radius: 4px;">${to}</td></tr>
            <tr><td style="padding: 8px; font-weight: bold; color: #374151;">Einmalpasswort:</td><td style="padding: 8px; font-family: monospace; background: #f3f4f6; border-radius: 4px;">${oneTimePassword}</td></tr>
          </table>
          <a href="${adminUrl}" style="display: inline-block; background: #4f46e5; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">Zum Admin-Bereich</a>
          <p style="margin-top: 24px; color: #6b7280; font-size: 14px;">Bitte melden Sie sich an und vergeben Sie ein neues Passwort.</p>
        </div>
      </div>
    `,
  });
}

/**
 * Send a one-time password for the admin-panel "Passwort vergessen" flow.
 */
export async function sendAdminPasswordResetEmail(
  to: string,
  name: string,
  oneTimePassword: string,
): Promise<void> {
  const adminUrl = process.env.ADMIN_BASE_URL || 'https://admin.schichtapp.de';
  await sendMail({
    to,
    subject: 'Schichtplan Manager – Passwort zurücksetzen',
    text: `Hallo ${name},\n\nfür Ihren Zugang wurde ein Zurücksetzen des Passworts angefordert.\n\nEinmalpasswort: ${oneTimePassword}\n(gültig für 1 Stunde)\n\nAdmin-Bereich: ${adminUrl}\n\nMelden Sie sich mit Ihrer E-Mail-Adresse und diesem Einmalpasswort an und vergeben Sie danach ein neues Passwort.\n\nWenn Sie das nicht angefordert haben, können Sie diese E-Mail ignorieren – Ihr bisheriges Passwort bleibt gültig.\n\nMit freundlichen Grüßen\nSchichtplan Manager`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #4f46e5; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
          <h2 style="margin:0;">Schichtplan Manager</h2>
        </div>
        <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
          <p>Hallo <strong>${name}</strong>,</p>
          <p>für Ihren Zugang wurde ein Zurücksetzen des Passworts angefordert.</p>
          <table style="margin: 16px 0; border-collapse: collapse;">
            <tr><td style="padding: 8px; font-weight: bold; color: #374151;">Einmalpasswort:</td><td style="padding: 8px; font-family: monospace; background: #f3f4f6; border-radius: 4px;">${oneTimePassword}</td></tr>
          </table>
          <p style="color: #6b7280; font-size: 14px;">Gültig für 1 Stunde. Melden Sie sich mit Ihrer E-Mail-Adresse und diesem Einmalpasswort an und vergeben Sie danach ein neues Passwort.</p>
          <a href="${adminUrl}" style="display: inline-block; background: #4f46e5; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">Zum Admin-Bereich</a>
          <p style="margin-top: 24px; color: #6b7280; font-size: 14px;">Wenn Sie das nicht angefordert haben, ignorieren Sie diese E-Mail – Ihr bisheriges Passwort bleibt gültig.</p>
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
  const portalUrl = APP_BASE_URL;
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

/**
 * Send a ring swap match notification email.
 * Shows: old shift, new shift, and all participants in the ring.
 */
export async function sendRingSwapMatchEmail(
  to: string,
  employeeName: string,
  myOffer: any,
  newOffer: any,
  allParticipants: string[],
): Promise<void> {
  const portalUrl = APP_BASE_URL;
  const SHIFT_NAMES: Record<string, string> = {
    fruehschicht: 'Frühschicht (WE)',
    verschieben: 'Verschobene Schicht',
    nachtbereitschaft: 'Nachtbereitschaft',
  };
  const formatDate = (d: string) => {
    const date = new Date(d);
    return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  };

  const myShift = `${SHIFT_NAMES[myOffer.shiftType] || myOffer.shiftType} (${formatDate(myOffer.startDate)} – ${formatDate(myOffer.endDate)})`;
  const newShift = `${SHIFT_NAMES[newOffer.shiftType] || newOffer.shiftType} (${formatDate(newOffer.startDate)} – ${formatDate(newOffer.endDate)})`;
  const participantList = allParticipants.join(', ');

  const participantRows = allParticipants.map(name =>
    `<span style="display: inline-block; background: #ede9fe; color: #6d28d9; padding: 4px 10px; border-radius: 12px; font-size: 13px; margin: 2px 4px;">${name}</span>`
  ).join(' → ');

  await sendMail({
    to,
    subject: 'Schichtplan Manager – Ringtausch genehmigt! 🔄',
    text: `Hallo ${employeeName},\n\nIhr Ringtausch wurde genehmigt!\n\nIhre alte Schicht: ${myShift}\nIhre neue Schicht: ${newShift}\nTeilnehmer: ${participantList}\n\nDie Änderungen wurden automatisch in Ihrem Schichtplan übernommen.\n\nSie können Ihren aktualisierten Schichtplan unter ${portalUrl} einsehen.\n\nMit freundlichen Grüßen\nSchichtplan Manager`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #7c3aed, #a855f7); color: white; padding: 24px; border-radius: 8px 8px 0 0; text-align: center;">
          <h1 style="margin: 0; font-size: 28px;">Ringtausch genehmigt! 🔄</h1>
          <p style="margin: 8px 0 0; opacity: 0.9;">Schichtplan Manager</p>
        </div>
        <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
          <p>Hallo <strong>${employeeName}</strong>,</p>
          <p>Ihr Ringtausch wurde vom Administrator genehmigt!</p>
          <div style="margin: 16px 0; padding: 16px; background: #f9fafb; border-radius: 8px;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px; font-weight: bold; color: #dc2626; width: 120px;">Alte Schicht:</td>
                <td style="padding: 8px;">${myShift}</td>
              </tr>
              <tr>
                <td style="padding: 8px; font-weight: bold; color: #059669;">Neue Schicht:</td>
                <td style="padding: 8px;">${newShift}</td>
              </tr>
            </table>
          </div>
          <div style="margin: 16px 0; padding: 12px; background: #faf5ff; border: 1px solid #e9d5ff; border-radius: 8px;">
            <p style="margin: 0 0 8px; font-weight: bold; color: #6d28d9; font-size: 14px;">Tauschring:</p>
            <div>${participantRows}</div>
          </div>
          <p style="color: #6b7280; font-size: 14px;">Die Änderungen wurden automatisch in Ihrem Schichtplan übernommen.</p>
          <a href="${portalUrl}" style="display: inline-block; margin-top: 16px; background: #7c3aed; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">Schichtplan ansehen</a>
        </div>
      </div>
    `,
  });
}

/**
 * Send a swap match notification email ("It's a Match!").
 */
export async function sendSwapMatchEmail(
  to: string,
  employeeName: string,
  partnerName: string,
  myOffer: any,
  partnerOffer: any,
): Promise<void> {
  const portalUrl = APP_BASE_URL;
  const SHIFT_NAMES: Record<string, string> = {
    fruehschicht: 'Frühschicht (WE)',
    verschieben: 'Verschobene Schicht',
    nachtbereitschaft: 'Nachtbereitschaft',
  };
  const formatDate = (d: string) => {
    const date = new Date(d);
    return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  };

  const myShift = `${SHIFT_NAMES[myOffer.shiftType] || myOffer.shiftType} (${formatDate(myOffer.startDate)} – ${formatDate(myOffer.endDate)})`;
  const partnerShift = `${SHIFT_NAMES[partnerOffer.shiftType] || partnerOffer.shiftType} (${formatDate(partnerOffer.startDate)} – ${formatDate(partnerOffer.endDate)})`;

  await sendMail({
    to,
    subject: "Schichtplan Manager – It's a Match! 🎉",
    text: `Hallo ${employeeName},\n\nIt's a Match! Ihr Schichttausch wurde genehmigt.\n\nIhre alte Schicht: ${myShift}\nIhre neue Schicht: ${partnerShift}\nTauschpartner: ${partnerName}\n\nDie Änderungen wurden automatisch in Ihrem Schichtplan übernommen.\n\nSie können Ihren aktualisierten Schichtplan unter ${portalUrl} einsehen.\n\nMit freundlichen Grüßen\nSchichtplan Manager`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #4f46e5, #7c3aed); color: white; padding: 24px; border-radius: 8px 8px 0 0; text-align: center;">
          <h1 style="margin: 0; font-size: 28px;">It's a Match! 🎉</h1>
          <p style="margin: 8px 0 0; opacity: 0.9;">Schichtplan Manager</p>
        </div>
        <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
          <p>Hallo <strong>${employeeName}</strong>,</p>
          <p>Ihr Schichttausch wurde vom Administrator genehmigt!</p>
          <div style="margin: 16px 0; padding: 16px; background: #f9fafb; border-radius: 8px;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px; font-weight: bold; color: #dc2626; width: 120px;">Alte Schicht:</td>
                <td style="padding: 8px;">${myShift}</td>
              </tr>
              <tr>
                <td style="padding: 8px; font-weight: bold; color: #059669;">Neue Schicht:</td>
                <td style="padding: 8px;">${partnerShift}</td>
              </tr>
              <tr>
                <td style="padding: 8px; font-weight: bold; color: #374151;">Tauschpartner:</td>
                <td style="padding: 8px;">${partnerName}</td>
              </tr>
            </table>
          </div>
          <p style="color: #6b7280; font-size: 14px;">Die Änderungen wurden automatisch in Ihrem Schichtplan übernommen.</p>
          <a href="${portalUrl}" style="display: inline-block; margin-top: 16px; background: #4f46e5; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">Schichtplan ansehen</a>
        </div>
      </div>
    `,
  });
}

/**
 * Send a direct-takeover notification email (no counter-offer involved).
 * `role` distinguishes whether the recipient gave away the shift ('giver')
 * or took it over ('taker').
 */
export async function sendTakeoverMatchEmail(
  to: string,
  employeeName: string,
  counterpartName: string,
  offer: any,
  role: 'giver' | 'taker',
): Promise<void> {
  const portalUrl = APP_BASE_URL;
  const SHIFT_NAMES: Record<string, string> = {
    fruehschicht: 'Frühschicht (WE)',
    verschieben: 'Verschobene Schicht',
    nachtbereitschaft: 'Nachtbereitschaft',
  };
  const formatDate = (d: string) => {
    const date = new Date(d);
    return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  };

  const shift = `${SHIFT_NAMES[offer.shiftType] || offer.shiftType} (${formatDate(offer.startDate)} – ${formatDate(offer.endDate)})`;
  const isGiver = role === 'giver';
  const subject = isGiver
    ? 'Schichtplan Manager – Ihre Schicht wurde übernommen'
    : 'Schichtplan Manager – Sie haben eine Schicht übernommen';
  const introText = isGiver
    ? `${counterpartName} hat Ihre angebotene Schicht übernommen.`
    : `Sie haben die von ${counterpartName} angebotene Schicht übernommen.`;

  await sendMail({
    to,
    subject,
    text: `Hallo ${employeeName},\n\n${introText}\n\nSchicht: ${shift}\n\nDie Änderungen wurden automatisch in Ihrem Schichtplan übernommen.\n\nSie können Ihren aktualisierten Schichtplan unter ${portalUrl} einsehen.\n\nMit freundlichen Grüßen\nSchichtplan Manager`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #0ea5e9, #059669); color: white; padding: 24px; border-radius: 8px 8px 0 0; text-align: center;">
          <h1 style="margin: 0; font-size: 24px;">Direktübernahme genehmigt</h1>
          <p style="margin: 8px 0 0; opacity: 0.9;">Schichtplan Manager</p>
        </div>
        <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
          <p>Hallo <strong>${employeeName}</strong>,</p>
          <p>${introText}</p>
          <div style="margin: 16px 0; padding: 16px; background: #f9fafb; border-radius: 8px;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px; font-weight: bold; color: #374151; width: 120px;">Schicht:</td>
                <td style="padding: 8px;">${shift}</td>
              </tr>
              <tr>
                <td style="padding: 8px; font-weight: bold; color: #374151;">${isGiver ? 'Übernommen von:' : 'Vorheriger Inhaber:'}</td>
                <td style="padding: 8px;">${counterpartName}</td>
              </tr>
            </table>
          </div>
          <p style="color: #6b7280; font-size: 14px;">Die Änderungen wurden automatisch in Ihrem Schichtplan übernommen.</p>
          <a href="${portalUrl}" style="display: inline-block; margin-top: 16px; background: #059669; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">Schichtplan ansehen</a>
        </div>
      </div>
    `,
  });
}
