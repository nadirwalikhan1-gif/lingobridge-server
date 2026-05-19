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
  // FIX: add schema for new-request event
  'new-request': {
    roomId:    (v) => typeof v !== 'string' || !v.trim() ? 'must be a non-empty string' : null,
    language:  (v) => typeof v !== 'string' || !v.trim() ? 'must be a non-empty string' : null,
    type:      (v) => !['audio', 'video'].includes(v)    ? 'must be "audio" or "video"'  : null,
  },
};

export function validateEvent(eventName, data) {
  const schema = SCHEMAS[eventName];

  if (!schema) {
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

  for (const [key, value] of Object.entries(data)) {
    if (!(key in schema)) sanitized[key] = value;
  }

  return { valid: errors.length === 0, errors, sanitized };
}