import pkg from 'agora-token';
const { RtcTokenBuilder, RtcRole } = pkg;
import { logger } from '../config/logger.mjs';

const APP_ID          = process.env.AGORA_APP_ID;
const APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;
const TOKEN_EXPIRY_SECONDS = 3600;

if (!APP_ID || !APP_CERTIFICATE) {
  logger.warn('AGORA_APP_ID or AGORA_APP_CERTIFICATE not set');
}

export function generateAgoraToken(channelName, uid = 0, role = 'publisher') {
  if (!APP_ID || !APP_CERTIFICATE) {
    throw new Error('Agora credentials not configured');
  }
  const rtcRole = role === 'subscriber' ? RtcRole.SUBSCRIBER : RtcRole.PUBLISHER;
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_EXPIRY_SECONDS;
  const token = RtcTokenBuilder.buildTokenWithUid(APP_ID, APP_CERTIFICATE, channelName, uid, rtcRole, expiresAt, expiresAt);
  logger.debug({ channelName, uid, role }, 'Agora RTC token generated');
  return { token, appId: APP_ID, channel: channelName, uid, expiresAt };
}

export { generateAgoraToken as generateRtcToken };

export function generateChannelName(roomId) {
  return 'lb_' + roomId.replace(/-/g, '_');
}