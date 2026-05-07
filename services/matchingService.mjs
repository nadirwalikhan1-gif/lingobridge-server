import { getAvailableInterpretersByLanguage, getAvailableInterpreters } from '../db/interpreterRepo.mjs';
import { logger } from '../config/logger.mjs';

/**
 * Find best available interpreters for a request
 * Returns ordered list: language match + rating priority
 */
export async function findMatchingInterpreters(language, sessionType, currency) {
  try {
    // Try language-specific match first
    let interpreters = await getAvailableInterpretersByLanguage(language);

    // Fall back to all available if none match
    if (!interpreters.length) {
      logger.warn({ language }, 'No language-specific interpreters — broadcasting to all');
      interpreters = await getAvailableInterpreters();
    }

    // Sort by rating descending
    return interpreters.sort((a, b) => (b.rating || 0) - (a.rating || 0));

  } catch (err) {
    logger.error({ err, language }, 'Matching failed');
    return [];
  }
}

/**
 * Get socket IDs for matched interpreters
 * Cross-references DB available interpreters with connected sockets
 */
export function getMatchedSocketIds(interpreters, connectedInterpreters) {
  const userIds = new Set(interpreters.map(i => i.user_id));
  return [...connectedInterpreters.entries()]
    .filter(([userId]) => userIds.has(userId))
    .map(([, socketId]) => socketId);
}

/**
 * Check if there are any available interpreters
 */
export async function hasAvailableInterpreters(language) {
  const interpreters = await getAvailableInterpretersByLanguage(language);
  return interpreters.length > 0;
}
