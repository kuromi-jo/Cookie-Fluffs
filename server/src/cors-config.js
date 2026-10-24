/**
 * @file cors-config.js
 * @description Explicit browser-origin allowlist for the Cookie Fluffs API.
 */

const BUILT_IN_ORIGINS = [
  'http://localhost:4200',
  'https://localhost',
];

export function allowedCorsOrigins(env = process.env) {
  const configured = (env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return new Set([...BUILT_IN_ORIGINS, ...configured]);
}

export function corsOptions(env = process.env) {
  const allowed = allowedCorsOrigins(env);
  return {
    origin(origin, callback) {
      callback(null, !origin || allowed.has(origin));
    },
    credentials: false,
  };
}
