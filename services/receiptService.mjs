// services/receiptService.mjs
// Sends a receipt after every session ends:
//   • Client receives their copy (email primary, SMS fallback if no email)
//   • Admin receives a full breakdown copy including interpreter earnings and margin
//
// Called from endCallHandler._endRoom() immediately after endSession().
// Fails silently — a notification failure never blocks the call-end flow.

import { supabaseAdmin } from '../config/supabase.mjs';
import { logger } from '../config/logger.mjs';
import { sendEmail, sendSMS } from './notificationService.mjs';

// ─── Data fetching ─────────────────────────────────────────────────────────────

async function fetchReceiptData(sessionId) {
  // Session + user names in one query
  const { data: session, error: sessionErr } = await supabaseAdmin
    .from('sessions')
    .select(`
      id,
      session_type,
      language,
      started_at,
      ended_at,
      client_id,
      interpreter_id,
      client:users!sessions_client_id_fkey(full_name, email, phone),
      interpreter:users!sessions_interpreter_id_fkey(full_name)
    `)
    .eq('id', sessionId)
    .single();

  if (sessionErr || !session) {
    throw new Error(`Receipt: session ${sessionId} not found — ${sessionErr?.message}`);
  }

  // Sum what the client was charged (active + hold ticks)
  const { data: charges } = await supabaseAdmin
    .from('transactions')
    .select('amount')
    .eq('session_id', sessionId)
    .in('type', ['charge_active', 'charge_hold']);

  const totalCharged = parseFloat(
    (charges ?? []).reduce((sum, t) => sum + (t.amount ?? 0), 0).toFixed(2)
  );

  // Sum what the interpreter earned (admin-only — never shown to client)
  const { data: earnings } = await supabaseAdmin
    .from('transactions')
    .select('amount')
    .eq('session_id', sessionId)
    .eq('type', 'earning');

  const interpreterEarnings = parseFloat(
    (earnings ?? []).reduce((sum, t) => sum + (t.amount ?? 0), 0).toFixed(2)
  );

  const startedAt       = new Date(session.started_at);
  const endedAt         = session.ended_at ? new Date(session.ended_at) : new Date();
  const durationSeconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  const durationMinutes = Math.floor(durationSeconds / 60);
  const durationSeconds2 = durationSeconds % 60;
  const durationLabel   = `${durationMinutes}m ${durationSeconds2}s`;

  return {
    sessionId:         session.id,
    sessionType:       session.session_type ?? 'audio',
    language:          session.language ?? 'Unknown',
    startedAt,
    endedAt,
    durationLabel,
    durationMinutes,
    clientName:        session.client?.full_name  ?? 'Client',
    clientEmail:       session.client?.email      ?? null,
    clientPhone:       session.client?.phone      ?? null,
    interpreterName:   session.interpreter?.full_name ?? 'Interpreter',
    totalCharged,
    interpreterEarnings,
    platformMargin:    parseFloat((totalCharged - interpreterEarnings).toFixed(2)),
  };
}

// ─── Email templates ───────────────────────────────────────────────────────────

function buildClientReceiptHtml(r) {
  const formattedDate = r.startedAt.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const formattedTime = r.startedAt.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
  const sessionTypeLabel = r.sessionType === 'video' ? 'Video Call' : 'Audio Call';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Session Receipt</title></head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7;padding:40px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr><td style="background:#1C1A2E;padding:32px 40px;text-align:center;">
          <p style="margin:0;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">Andiraw</p>
          <p style="margin:8px 0 0;font-size:13px;color:#A9A4E0;">Professional Interpretation Services</p>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:40px;">
          <p style="margin:0 0 4px;font-size:13px;color:#6B7280;">Session Receipt</p>
          <h1 style="margin:0 0 32px;font-size:28px;font-weight:700;color:#111827;">$${r.totalCharged.toFixed(2)} <span style="font-size:16px;font-weight:400;color:#6B7280;">USD</span></h1>

          <p style="margin:0 0 24px;font-size:15px;color:#374151;">Hi ${r.clientName}, here's your receipt for your ${sessionTypeLabel.toLowerCase()} with Andiraw.</p>

          <!-- Session Details -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#F9FAFB;border-radius:12px;overflow:hidden;margin-bottom:24px;">
            <tr><td style="padding:20px 24px;border-bottom:1px solid #E5E7EB;">
              <p style="margin:0;font-size:11px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.5px;">Session Details</p>
            </td></tr>
            <tr><td style="padding:16px 24px;border-bottom:1px solid #E5E7EB;">
              <table width="100%"><tr>
                <td style="font-size:13px;color:#6B7280;">Type</td>
                <td style="font-size:13px;font-weight:500;color:#111827;text-align:right;">${sessionTypeLabel}</td>
              </tr></table>
            </td></tr>
            <tr><td style="padding:16px 24px;border-bottom:1px solid #E5E7EB;">
              <table width="100%"><tr>
                <td style="font-size:13px;color:#6B7280;">Language</td>
                <td style="font-size:13px;font-weight:500;color:#111827;text-align:right;">${r.language}</td>
              </tr></table>
            </td></tr>
            <tr><td style="padding:16px 24px;border-bottom:1px solid #E5E7EB;">
              <table width="100%"><tr>
                <td style="font-size:13px;color:#6B7280;">Interpreter</td>
                <td style="font-size:13px;font-weight:500;color:#111827;text-align:right;">${r.interpreterName}</td>
              </tr></table>
            </td></tr>
            <tr><td style="padding:16px 24px;border-bottom:1px solid #E5E7EB;">
              <table width="100%"><tr>
                <td style="font-size:13px;color:#6B7280;">Date</td>
                <td style="font-size:13px;font-weight:500;color:#111827;text-align:right;">${formattedDate}</td>
              </tr></table>
            </td></tr>
            <tr><td style="padding:16px 24px;border-bottom:1px solid #E5E7EB;">
              <table width="100%"><tr>
                <td style="font-size:13px;color:#6B7280;">Time</td>
                <td style="font-size:13px;font-weight:500;color:#111827;text-align:right;">${formattedTime}</td>
              </tr></table>
            </td></tr>
            <tr><td style="padding:16px 24px;">
              <table width="100%"><tr>
                <td style="font-size:13px;color:#6B7280;">Duration</td>
                <td style="font-size:13px;font-weight:500;color:#111827;text-align:right;">${r.durationLabel}</td>
              </tr></table>
            </td></tr>
          </table>

          <!-- Amount -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#1C1A2E;border-radius:12px;margin-bottom:32px;">
            <tr><td style="padding:20px 24px;">
              <table width="100%"><tr>
                <td style="font-size:14px;font-weight:500;color:#A9A4E0;">Total charged</td>
                <td style="font-size:22px;font-weight:700;color:#ffffff;text-align:right;">$${r.totalCharged.toFixed(2)}</td>
              </tr></table>
              <p style="margin:8px 0 0;font-size:11px;color:#6B7280;">Deducted from your Andiraw wallet · Session ID: ${r.sessionId.slice(0, 8).toUpperCase()}</p>
            </td></tr>
          </table>

          <p style="margin:0 0 8px;font-size:13px;color:#6B7280;">Questions about this charge? Reply to this email or visit your session history at <a href="https://andiraw.vercel.app/client/sessions" style="color:#7C3AED;">andiraw.vercel.app</a>.</p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#F9FAFB;padding:24px 40px;text-align:center;border-top:1px solid #E5E7EB;">
          <p style="margin:0;font-size:12px;color:#9CA3AF;">Andiraw · Professional Interpretation Services</p>
          <p style="margin:4px 0 0;font-size:11px;color:#D1D5DB;">This is an automated receipt. Please keep it for your records.</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildAdminReceiptHtml(r) {
  const formattedDate = r.startedAt.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const formattedTime = r.startedAt.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
  const sessionTypeLabel = r.sessionType === 'video' ? 'Video Call' : 'Audio Call';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Admin Session Receipt</title></head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7;padding:40px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr><td style="background:#1C1A2E;padding:24px 40px;">
          <p style="margin:0;font-size:18px;font-weight:700;color:#ffffff;">Andiraw — Admin Receipt</p>
          <p style="margin:4px 0 0;font-size:12px;color:#A9A4E0;">Internal copy · Full financial breakdown</p>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:32px 40px;">

          <!-- Parties -->
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
            <tr>
              <td width="48%" style="background:#F0FDF4;border-radius:10px;padding:16px;">
                <p style="margin:0 0 4px;font-size:10px;font-weight:600;color:#16A34A;text-transform:uppercase;">Client</p>
                <p style="margin:0;font-size:14px;font-weight:600;color:#111827;">${r.clientName}</p>
                <p style="margin:2px 0 0;font-size:12px;color:#6B7280;">${r.clientEmail ?? 'No email'}</p>
              </td>
              <td width="4%"></td>
              <td width="48%" style="background:#EFF6FF;border-radius:10px;padding:16px;">
                <p style="margin:0 0 4px;font-size:10px;font-weight:600;color:#2563EB;text-transform:uppercase;">Interpreter</p>
                <p style="margin:0;font-size:14px;font-weight:600;color:#111827;">${r.interpreterName}</p>
                <p style="margin:2px 0 0;font-size:12px;color:#6B7280;">${sessionTypeLabel}</p>
              </td>
            </tr>
          </table>

          <!-- Session Info -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#F9FAFB;border-radius:12px;margin-bottom:24px;">
            <tr><td style="padding:14px 20px;border-bottom:1px solid #E5E7EB;">
              <p style="margin:0;font-size:11px;font-weight:600;color:#9CA3AF;text-transform:uppercase;">Session</p>
            </td></tr>
            <tr><td style="padding:12px 20px;border-bottom:1px solid #E5E7EB;">
              <table width="100%"><tr>
                <td style="font-size:12px;color:#6B7280;">Session ID</td>
                <td style="font-size:12px;font-weight:500;color:#111827;text-align:right;">${r.sessionId}</td>
              </tr></table>
            </td></tr>
            <tr><td style="padding:12px 20px;border-bottom:1px solid #E5E7EB;">
              <table width="100%"><tr>
                <td style="font-size:12px;color:#6B7280;">Language</td>
                <td style="font-size:12px;font-weight:500;color:#111827;text-align:right;">${r.language}</td>
              </tr></table>
            </td></tr>
            <tr><td style="padding:12px 20px;border-bottom:1px solid #E5E7EB;">
              <table width="100%"><tr>
                <td style="font-size:12px;color:#6B7280;">Date &amp; Time</td>
                <td style="font-size:12px;font-weight:500;color:#111827;text-align:right;">${formattedDate}, ${formattedTime}</td>
              </tr></table>
            </td></tr>
            <tr><td style="padding:12px 20px;">
              <table width="100%"><tr>
                <td style="font-size:12px;color:#6B7280;">Duration</td>
                <td style="font-size:12px;font-weight:500;color:#111827;text-align:right;">${r.durationLabel}</td>
              </tr></table>
            </td></tr>
          </table>

          <!-- Financial Breakdown -->
          <table width="100%" cellpadding="0" cellspacing="0" style="border:2px solid #E5E7EB;border-radius:12px;overflow:hidden;margin-bottom:24px;">
            <tr><td style="background:#F9FAFB;padding:14px 20px;border-bottom:1px solid #E5E7EB;">
              <p style="margin:0;font-size:11px;font-weight:600;color:#9CA3AF;text-transform:uppercase;">Financial Breakdown</p>
            </td></tr>
            <tr><td style="padding:14px 20px;border-bottom:1px solid #E5E7EB;">
              <table width="100%"><tr>
                <td style="font-size:13px;color:#374151;">Client charged</td>
                <td style="font-size:15px;font-weight:700;color:#111827;text-align:right;">$${r.totalCharged.toFixed(2)}</td>
              </tr></table>
            </td></tr>
            <tr><td style="padding:14px 20px;border-bottom:1px solid #E5E7EB;">
              <table width="100%"><tr>
                <td style="font-size:13px;color:#374151;">Interpreter earnings</td>
                <td style="font-size:15px;font-weight:700;color:#2563EB;text-align:right;">$${r.interpreterEarnings.toFixed(2)}</td>
              </tr></table>
            </td></tr>
            <tr><td style="padding:14px 20px;background:#F0FDF4;">
              <table width="100%"><tr>
                <td style="font-size:13px;font-weight:600;color:#16A34A;">Platform margin</td>
                <td style="font-size:17px;font-weight:700;color:#16A34A;text-align:right;">$${r.platformMargin.toFixed(2)}</td>
              </tr></table>
            </td></tr>
          </table>

          <p style="margin:0;font-size:11px;color:#9CA3AF;">This receipt is stored for dispute resolution. Session ID ${r.sessionId} can be matched against the client's copy.</p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#F9FAFB;padding:20px 40px;border-top:1px solid #E5E7EB;">
          <p style="margin:0;font-size:11px;color:#9CA3AF;text-align:center;">Andiraw Admin · Internal use only · Do not forward</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildClientSMS(r) {
  const sessionTypeLabel = r.sessionType === 'video' ? 'video' : 'audio';
  return `Andiraw receipt: ${sessionTypeLabel} call (${r.language}), ${r.durationLabel}, $${r.totalCharged.toFixed(2)} deducted from your wallet. Interpreter: ${r.interpreterName}. Session ID: ${r.sessionId.slice(0, 8).toUpperCase()}`;
}

// ─── Main export ───────────────────────────────────────────────────────────────

/**
 * Fetch session data and send receipts to client and admin.
 * Never throws — all errors are caught and logged so call-end flow is unaffected.
 *
 * @param {string} sessionId  UUID of the completed session
 */
export async function sendSessionReceipt(sessionId) {
  let receipt;
  try {
    receipt = await fetchReceiptData(sessionId);
  } catch (err) {
    logger.error({ err, sessionId }, 'sendSessionReceipt: data fetch failed');
    return;
  }

  // ── Client notification ──────────────────────────────────────────────────
  if (receipt.clientEmail) {
    await sendEmail(
      receipt.clientEmail,
      `Your Andiraw session receipt — $${receipt.totalCharged.toFixed(2)}`,
      buildClientReceiptHtml(receipt)
    ).catch((err) => logger.error({ err, sessionId }, 'Client receipt email failed'));
  } else if (receipt.clientPhone) {
    // SMS fallback — only when no email on record
    await sendSMS(
      receipt.clientPhone,
      buildClientSMS(receipt)
    ).catch((err) => logger.error({ err, sessionId }, 'Client receipt SMS failed'));
  } else {
    logger.warn({ sessionId, clientId: receipt.clientId }, 'No client email or phone — receipt not sent');
  }

  // ── Admin notification ───────────────────────────────────────────────────
  const adminEmail = process.env.ADMIN_EMAIL;
  if (adminEmail) {
    await sendEmail(
      adminEmail,
      `Session receipt — ${receipt.clientName} · $${receipt.totalCharged.toFixed(2)} charged · $${receipt.platformMargin.toFixed(2)} margin`,
      buildAdminReceiptHtml(receipt)
    ).catch((err) => logger.error({ err, sessionId }, 'Admin receipt email failed'));
  } else {
    logger.warn({ sessionId }, 'ADMIN_EMAIL not set — admin receipt skipped');
  }

  logger.info({
    sessionId,
    clientEmail:  receipt.clientEmail,
    clientPhone:  receipt.clientPhone,
    adminEmail,
    totalCharged: receipt.totalCharged,
    margin:       receipt.platformMargin,
  }, 'Session receipts dispatched');
}
