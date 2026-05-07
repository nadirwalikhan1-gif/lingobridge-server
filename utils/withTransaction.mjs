/**
 * Base application error — extends Error with an HTTP status code.
 */
export class AppError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name       = this.constructor.name;
    this.statusCode = statusCode;
    Error.captureStackTrace(this, this.constructor);
  }
}

/** 400 Bad Request */
export class ValidationError extends AppError {
  constructor(message = 'Validation failed') {
    super(message, 400);
  }
}

/** 401 Unauthorized */
export class AuthError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401);
  }
}

/** 403 Forbidden */
export class ForbiddenError extends AppError {
  constructor(message = 'Access denied') {
    super(message, 403);
  }
}

/** 404 Not Found */
export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404);
  }
}

/** 409 Conflict */
export class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super(message, 409);
  }
}

/** 402 Payment Required — insufficient wallet balance */
export class InsufficientFundsError extends AppError {
  constructor(message = 'Insufficient wallet balance') {
    super(message, 402);
  }
}

/** 503 Service Unavailable */
export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable') {
    super(message, 503);
  }
}
