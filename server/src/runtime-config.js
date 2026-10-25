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
    corsOrigins: corsOrigins(env, appEnv),
    agreement: Object.freeze({ required: agreementRequired, version: agreementVersion }),
    fulfillment,
    demos: Object.freeze({ card: cardDemoEnabled, wallet: walletDemoEnabled }),
  });
}

/** Validates only JWT material for lazy auth helpers without generating a fallback. */
export function requireJwtSecret(env = process.env) {
  return jwtSecret(env);
}
