import pkg from 'agora-token';
const { RtcTokenBuilder, RtcRole } = pkg;
import { logger } from '../config/logger.mjs';

const APP_ID          = process.env.AGORA_APP_ID;
const APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;
const TOKEN_EXPIRY_SECONDS = 3600;

if (!APP_ID || !APP_CERTIFICATE) {
  logger.warn('AGORA_APP_ID or AGORA_APP_CERTIFICATE not set — token generation will fail');
}

export function generateAgoraToken(channelName, uid = 0, role = 'publisher') {
  if (!APP_ID || !APP_CERTIFICATE) {
    throw new Error('Agora credentials not configured');
  }
  if (!channelName) {
    throw new Error('channelName is required to generate an Agora token');
  }
  const rtcRole = role === 'subscriber' ? RtcRole.SUBSCRIBER : RtcRole.PUBLISHER;
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + TOKEN_EXPIRY_SECONDS;
  // Always use uid=0 — token is channel-scoped, any uid can join
  const token = RtcTokenBuilder.buildTokenWithUid(
    APP_ID, APP_CERTIFICATE, channelName, 0, rtcRole, expiresAt, expiresAt
  );
  return { token, appId: APP_ID, channel: channelName, uid: 0, expiresAt };
}

export { generateAgoraToken as generateRtcToken };

export function generateChannelName(roomId) {
  return 'lb_' + roomId.replace(/-/g, '_');
}
