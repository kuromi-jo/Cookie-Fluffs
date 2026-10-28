/**
 * @file runtime-config.js
 * @description Strict, secret-safe runtime validation for API and migration processes.
 */
import { fulfillmentConfig } from './fulfillment-config.js';

const APP_ENVS = new Set(['demo', 'production', 'test']);
const PLACEHOLDER_SECRET_RE = /(change[-_ ]?me|replace[-_ ]?me|example|password|secret[-_ ]?here)/i;

export class RuntimeConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuntimeConfigError';
  }
}

function requiredText(env, name) {
  const value = typeof env[name] === 'string' ? env[name].trim() : '';
  if (!value) throw new RuntimeConfigError(`${name} is required.`);
  return value;
}

function strictBoolean(env, name) {
  const value = requiredText(env, name).toLowerCase();
  if (value !== 'true' && value !== 'false') {
    throw new RuntimeConfigError(`${name} must be true or false.`);
  }
  return value === 'true';
}

function optionalStrictBoolean(env, name, fallback = false) {
  const value = typeof env[name] === 'string' ? env[name].trim() : '';
  if (!value) return fallback;
  if (!['true', 'false'].includes(value.toLowerCase())) {
    throw new RuntimeConfigError(`${name} must be true or false.`);
  }
  return value.toLowerCase() === 'true';
}

function databaseUrl(env) {
  const value = requiredText(env, 'DATABASE_URL');
  try {
    const parsed = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname.slice(1)) {
      throw new Error();
    }
  } catch {
    throw new RuntimeConfigError('DATABASE_URL must be a valid PostgreSQL URL.');
  }
  return value;
}

function jwtSecret(env) {
  const value = requiredText(env, 'JWT_SECRET');
  if (value.length < 32 || PLACEHOLDER_SECRET_RE.test(value) || new Set(value).size < 12) {
    throw new RuntimeConfigError('JWT_SECRET must be a non-placeholder secret of at least 32 characters.');
  }
  return value;
}

function corsOrigins(env, appEnv) {
  const configured = requiredText(env, 'CORS_ALLOWED_ORIGINS').split(',').map((value) => value.trim()).filter(Boolean);
  if (!configured.length) throw new RuntimeConfigError('CORS_ALLOWED_ORIGINS must contain at least one origin.');
  const origins = [];
  for (const value of configured) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new RuntimeConfigError('CORS_ALLOWED_ORIGINS contains an invalid origin.');
    }
    const loopbackHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.origin !== value || (parsed.protocol !== 'https:' && !(appEnv !== 'production' && loopbackHttp))) {
      throw new RuntimeConfigError('CORS_ALLOWED_ORIGINS must contain exact HTTPS origins or nonproduction loopback origins.');
    }
    origins.push(parsed.origin);
  }
  return Object.freeze([...new Set(origins)]);
}

/**
 * Validates password-recovery settings without making recovery available by default.
 * Recovery emails a 6-digit code (no link), so no public app origin is needed.
 */
export function passwordRecoveryConfig(env = process.env) {
  const enabled = optionalStrictBoolean(env, 'PASSWORD_RECOVERY_ENABLED');
  if (!enabled) return Object.freeze({ enabled: false });

  const tokenPepper = requiredText(env, 'PASSWORD_RESET_TOKEN_PEPPER');
  if (tokenPepper.length < 32 || PLACEHOLDER_SECRET_RE.test(tokenPepper) || new Set(tokenPepper).size < 12) {
    throw new RuntimeConfigError('PASSWORD_RESET_TOKEN_PEPPER must be a strong secret of at least 32 characters.');
  }
  const brevoApiKey = requiredText(env, 'BREVO_API_KEY');
  const senderEmail = requiredText(env, 'BREVO_SENDER_EMAIL').toLowerCase();
  const senderName = requiredText(env, 'BREVO_SENDER_NAME');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) {
    throw new RuntimeConfigError('BREVO_SENDER_EMAIL must be a valid verified sender.');
  }
  if (senderName.length > 80) throw new RuntimeConfigError('BREVO_SENDER_NAME is too long.');
  return Object.freeze({ enabled, tokenPepper, brevoApiKey, senderEmail, senderName });
}

/**
 * Validates identity-verification settings. The challenge engine (code generation, hashing,
 * expiry, rate limits) always works for automated tests via the pepper; real email DELIVERY
 * stays off unless VERIFICATION_DELIVERY_ENABLED is true with valid Brevo settings.
 */
export function verificationConfig(env = process.env) {
  const pepper = typeof env.VERIFICATION_CODE_PEPPER === 'string' ? env.VERIFICATION_CODE_PEPPER.trim() : '';
  const hasPepper = pepper.length >= 32 && !PLACEHOLDER_SECRET_RE.test(pepper) && new Set(pepper).size >= 12;
  const deliveryEnabled = optionalStrictBoolean(env, 'VERIFICATION_DELIVERY_ENABLED');
  if (!deliveryEnabled) {
    // Engine available when a strong pepper exists; delivery remains disabled.
    return Object.freeze({ deliveryEnabled: false, pepper: hasPepper ? pepper : null });
  }
  if (!hasPepper) {
    throw new RuntimeConfigError('VERIFICATION_CODE_PEPPER must be a strong secret of at least 32 characters.');
  }
  const brevoApiKey = requiredText(env, 'BREVO_API_KEY');
  const senderEmail = requiredText(env, 'BREVO_SENDER_EMAIL').toLowerCase();
  const senderName = requiredText(env, 'BREVO_SENDER_NAME');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) {
    throw new RuntimeConfigError('BREVO_SENDER_EMAIL must be a valid verified sender.');
  }
  return Object.freeze({ deliveryEnabled: true, pepper, brevoApiKey, senderEmail, senderName });
}

/** Validates optional Google identity settings while keeping the feature off by default. */
export function googleAuthConfig(env = process.env) {
  const enabled = optionalStrictBoolean(env, 'GOOGLE_AUTH_ENABLED');
  if (!enabled) return Object.freeze({ enabled: false });

  const webClientId = requiredText(env, 'GOOGLE_WEB_CLIENT_ID');
  if (!/^[0-9]+-[a-z0-9-]+\.apps\.googleusercontent\.com$/i.test(webClientId)) {
    throw new RuntimeConfigError('GOOGLE_WEB_CLIENT_ID must be a valid Google web OAuth client ID.');
  }
  const noncePepper = requiredText(env, 'GOOGLE_AUTH_NONCE_PEPPER');
  if (noncePepper.length < 32 || PLACEHOLDER_SECRET_RE.test(noncePepper) || new Set(noncePepper).size < 12) {
    throw new RuntimeConfigError('GOOGLE_AUTH_NONCE_PEPPER must be a strong secret of at least 32 characters.');
  }
  return Object.freeze({ enabled, webClientId, noncePepper });
}

/** Validates all security- and business-sensitive runtime settings before startup. */
export function validateRuntimeConfig(env = process.env) {
  const appEnv = requiredText(env, 'APP_ENV').toLowerCase();
  if (!APP_ENVS.has(appEnv)) throw new RuntimeConfigError('APP_ENV must be demo, production, or test.');
  const nodeEnv = requiredText(env, 'NODE_ENV').toLowerCase();
  if (!['development', 'production', 'test'].includes(nodeEnv)) {
    throw new RuntimeConfigError('NODE_ENV must be development, production, or test.');
  }
  if (appEnv === 'production' && nodeEnv !== 'production') {
    throw new RuntimeConfigError('Production APP_ENV requires NODE_ENV=production.');
  }

  const port = Number(requiredText(env, 'PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new RuntimeConfigError('PORT must be a valid TCP port.');

  const agreementRequired = strictBoolean(env, 'ORDER_AGREEMENT_REQUIRED');
  const agreementVersion = agreementRequired ? requiredText(env, 'ORDER_AGREEMENT_VERSION') : null;
  if (agreementVersion && !/^[a-z0-9][a-z0-9._-]{2,79}$/i.test(agreementVersion)) {
    throw new RuntimeConfigError('ORDER_AGREEMENT_VERSION has an invalid format.');
  }
  if (appEnv === 'production' && agreementVersion?.toLowerCase().includes('draft')) {
    throw new RuntimeConfigError('Production cannot use a draft order agreement version.');
  }

  const deliveryRequested = strictBoolean(env, 'FULFILLMENT_DELIVERY_ENABLED');
  const pickupRequested = strictBoolean(env, 'FULFILLMENT_PICKUP_ENABLED');
  const cardDemoEnabled = strictBoolean(env, 'CARD_DEMO_ENABLED');
  const walletDemoEnabled = strictBoolean(env, 'WALLET_DEMO_ENABLED');
  if (appEnv === 'production' && (cardDemoEnabled || walletDemoEnabled)) {
    throw new RuntimeConfigError('Payment demonstrations must be disabled in production.');
  }
  const fulfillment = fulfillmentConfig(env);
  const passwordRecovery = passwordRecoveryConfig(env);
  const googleAuth = googleAuthConfig(env);
  const allowedCorsOrigins = corsOrigins(env, appEnv);
  if (deliveryRequested && !fulfillment.delivery.enabled) {
    throw new RuntimeConfigError('Enabled delivery requires valid approved PSGC city codes.');
  }
  if (pickupRequested && !fulfillment.pickup.enabled) {
    throw new RuntimeConfigError('Enabled pickup requires a public location and operating hours.');
  }

  return Object.freeze({
    appEnv,
    nodeEnv,
    port,
    databaseUrl: databaseUrl(env),
    jwtSecret: jwtSecret(env),
    corsOrigins: allowedCorsOrigins,
    agreement: Object.freeze({ required: agreementRequired, version: agreementVersion }),
    fulfillment,
    demos: Object.freeze({ card: cardDemoEnabled, wallet: walletDemoEnabled }),
    passwordRecovery,
    googleAuth,
  });
}

/** Validates only JWT material for lazy auth helpers without generating a fallback. */
export function requireJwtSecret(env = process.env) {
  return jwtSecret(env);
}
