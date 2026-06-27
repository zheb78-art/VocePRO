export const AUTH_COOKIE_NAME = "voce_session";
export const AUTH_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function authConfiguration() {
  return {
    username: process.env.APP_USERNAME?.trim() || "",
    password: process.env.APP_PASSWORD || "",
    secret: process.env.APP_AUTH_SECRET || "",
  };
}

export function isAuthConfigured() {
  const config = authConfiguration();
  return Boolean(config.username && config.password && config.secret);
}

function toHex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sign(value: string, secret: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function expectedCredentialFingerprint() {
  const config = authConfiguration();
  if (!config.username || !config.password || !config.secret) return "";
  return sign(`${config.username}\n${config.password}`, config.secret);
}

export async function credentialsAreValid(username: string, password: string) {
  const config = authConfiguration();
  if (!config.username || !config.password || !config.secret) return false;
  const [submitted, expected] = await Promise.all([
    sign(`${username.trim()}\n${password}`, config.secret),
    expectedCredentialFingerprint(),
  ]);
  return constantTimeEqual(submitted, expected);
}

export async function createSessionToken() {
  const config = authConfiguration();
  if (!config.username || !config.password || !config.secret) return "";
  const issuedAt = Math.floor(Date.now() / 1000);
  const signature = await sign(`session\n${issuedAt}\n${config.username}\n${config.password}`, config.secret);
  return `${issuedAt}.${signature}`;
}

export async function sessionIsValid(value: string | undefined) {
  if (!value) return false;
  const config = authConfiguration();
  const match = value.match(/^(\d+)\.([a-f0-9]{64})$/);
  if (!match || !config.username || !config.password || !config.secret) return false;
  const issuedAt = Number(match[1]);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > now + 60 || now - issuedAt > AUTH_MAX_AGE_SECONDS) return false;
  const expected = await sign(`session\n${issuedAt}\n${config.username}\n${config.password}`, config.secret);
  return constantTimeEqual(match[2], expected);
}
