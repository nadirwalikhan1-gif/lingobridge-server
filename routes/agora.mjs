import { Router } from 'express';
import { requireAuth } from '../middleware/authHttp.mjs';
import { generateAgoraToken } from '../services/agoraService.mjs';
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
    const result = await generateAgoraToken(channelName, uid, role);
    logger.info({ userId: req.userId, channelName, uid }, 'Agora token issued');
    return res.status(200).json(result);
  } catch (err) {
    logger.error({ err, channelName }, 'Token generation failed');
    return res.status(500).json({ error: 'Token generation failed' });
  }
});

export default router;
