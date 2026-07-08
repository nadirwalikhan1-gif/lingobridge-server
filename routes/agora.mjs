import { Router } from 'express';
import { requireAuth } from '../middleware/authHttp.mjs';
import { generateAgoraToken } from '../services/agoraService.mjs';
import { getSessionByChannel } from '../db/sessionRepo.mjs';
import { logger } from '../config/logger.mjs';

const router = Router();

/**
 * POST /agora/token
 * Generate a fresh Agora RTC token (server-side only)
 * Body: { channelName, uid, role? }
 */
router.post('/token', requireAuth, async (req, res) => {
  const { channelName, uid, role = 'publisher' } = req.body;

  if (!channelName || !uid) {
    return res.status(400).json({ error: 'channelName and uid are required' });
  }

  if (!['publisher', 'subscriber'].includes(role)) {
    return res.status(400).json({ error: 'role must be publisher or subscriber' });
  }

  if (typeof uid !== 'number' || uid < 1) {
    return res.status(400).json({ error: 'uid must be a positive integer' });
  }

  try {
    // FIX: previously issued a valid token for any channelName an
    // authenticated user supplied, with no check they actually belonged to
    // that session — any client or interpreter could join or eavesdrop on
    // any live call by supplying its channel name. Now requires the caller
    // to be the session's own client_id or interpreter_id. Deliberately not
    // scoped to 'active' sessions only (see getSessionByChannel) since a
    // client needs a token before an interpreter has accepted.
    const session = await getSessionByChannel(channelName);
    if (!session) {
      return res.status(404).json({ error: 'Session not found for this channel' });
    }
    if (session.client_id !== req.userId && session.interpreter_id !== req.userId) {
      logger.warn({ userId: req.userId, channelName, sessionId: session.id }, 'Agora token denied — not a session participant');
      return res.status(403).json({ error: 'You are not a participant in this session' });
    }

    const result = await generateAgoraToken(channelName, uid, role);
    logger.info({ userId: req.userId, channelName, uid }, 'Agora token issued');
    return res.status(200).json(result);
  } catch (err) {
    logger.error({ err, channelName }, 'Token generation failed');
    return res.status(500).json({ error: 'Token generation failed' });
  }
});

export default router;
