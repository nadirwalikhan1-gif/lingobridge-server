// services/notificationService.mjs
// Wraps Resend (email) and Twilio (SMS).
// Both fail gracefully — if credentials are not set the call is a no-op
// that logs a warning rather than crashing the server.

import { logger } from '../config/logger.mjs';

// ─── Email via Resend ─────────────────────────────────────────────────────────

/**
 * Send a transactional email via Resend.
 * @param {string}   to      Recipient email address
 * @param {string}   subject Email subject line
 * @param {string}   html    HTML body
 * @returns {Promise<boolean>} true if sent, false if skipped/failed
 */
export async function sendEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  const from   = process.env.EMAIL_FROM || 'receipts@andiraw.com';

  if (!apiKey) {
    logger.warn({ to, subject }, 'RESEND_API_KEY not set — email skipped');
    return false;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ from, to, subject, html }),
    });

    if (!res.ok) {
      const err = await res.text();
      logger.error({ to, subject, status: res.status, err }, 'Resend email failed');
      return false;
    }

    logger.info({ to, subject }, 'Email sent via Resend');
    return true;
  } catch (err) {
    logger.error({ err, to, subject }, 'Resend email error');
    return false;
  }
}

// ─── SMS via Twilio ───────────────────────────────────────────────────────────

/**
 * Send an SMS via Twilio.
 * @param {string} to   Recipient phone number in E.164 format (+1234567890)
 * @param {string} body SMS body text (max 160 chars recommended)
 * @returns {Promise<boolean>} true if sent, false if skipped/failed
 */
export async function sendSMS(to, body) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !from) {
    logger.warn({ to }, 'Twilio credentials not set — SMS skipped');
    return false;
  }

  try {
    const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method:  'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type':  'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      logger.error({ to, status: res.status, err }, 'Twilio SMS failed');
      return false;
    }

    logger.info({ to }, 'SMS sent via Twilio');
    return true;
  } catch (err) {
    logger.error({ err, to }, 'Twilio SMS error');
    return false;
  }
}
