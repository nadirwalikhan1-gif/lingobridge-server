import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { logger } from './logger.mjs';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabaseAdmin = null;

if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: {
      autoRefreshToken:   false,
      persistSession:     false,
      detectSessionInUrl: false,
    },
    realtime: {
      transport: ws,
    },
  });
} else {
  logger.warn('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY — admin client not initialized');
}

export { supabaseAdmin };

export async function verifySupabaseToken(token) {
  if (!supabaseAdmin) {
    logger.warn('Supabase admin not initialized — cannot verify tokens');
    return null;
  }
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) {
      logger.debug({ error }, 'Token verification failed');
      return null;
    }
    return data.user;
  } catch (err) {
    logger.error({ err }, 'Unexpected error during token verification');
    return null;
  }
}