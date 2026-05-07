/**
 * Socket event schemas — define required fields per event name.
 * Values are validator functions: (value) => errorString | null
 */
const SCHEMAS = {
  'register-interpreter': {
    languages:    (v) => !Array.isArray(v) || v.length === 0 ? 'must be a non-empty array' : null,
    sessionTypes: (v) => !Array.isArray(v) || v.length === 0 ? 'must be a non-empty array' : null,
  },
  'request-call': {
    language:    (v) => typeof v !== 'string' || !v.trim() ? 'must be a non-empty string' : null,
    sessionType: (v) => !['audio', 'video'].includes(v)    ? 'must be "audio" or "video"'  : null,
  },
  'accept-call': {
    roomId: (v) => typeof v !== 'string' || !v.trim() ? 'must be a non-empty string' : null,
  },
  'end-call': {
    roomId: (v) => typeof v !== 'string' || !v.trim() ? 'must be a non-empty string' : null,
  },
};

/**
 * Validate a socket event payload against a named schema.
 *
 * FIX: acceptHandler called validateEvent('accept-call', data) expecting
 * { valid, errors, sanitized } but the old implementation was a factory
 * (validateEvent(schema, handler) => wrappedFn). Calling convention mismatch
 * caused "valid is not defined" crashes on every accept/end-call event.
 *
 * This version is a direct validator — call it inline, check the result.
 *
 * Usage:
 *   const { valid, errors, sanitized } = validateEvent('accept-call', data);
 *   if (!valid) { socket.emit('error', { errors }); return; }
 *
 * @param {string} eventName
 * @param {*}      data        — raw socket payload
 * @returns {{ valid: boolean, errors: string[], sanitized: object }}
 */
export function validateEvent(eventName, data) {
  const schema = SCHEMAS[eventName];

  if (!schema) {
    // No schema registered — pass through
    return { valid: true, errors: [], sanitized: data ?? {} };
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {
      valid:     false,
      errors:    ['Payload must be a non-null object'],
      sanitized: {},
    };
  }

  const errors    = [];
  const sanitized = {};

  for (const [field, validate] of Object.entries(schema)) {
    const err = validate(data[field]);
    if (err) {
      errors.push(`${field}: ${err}`);
    } else {
      sanitized[field] = data[field];
    }
  }

  // Pass through any extra fields that aren't in the schema
  for (const [key, value] of Object.entries(data)) {
    if (!(key in schema)) sanitized[key] = value;
  }

  return { valid: errors.length === 0, errors, sanitized };
}
