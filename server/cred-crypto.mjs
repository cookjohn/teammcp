/**
 * cred-crypto.mjs — AES-256-GCM at-rest encryption for credential profile tokens.
 *
 * Why a dedicated key (not MEMORY_LLM_KEY): the memory subsystem's encryption
 * (memory-llm.mjs) requires the operator to set MEMORY_LLM_KEY, which is often
 * unset. Credential profiles must work out of the box, so we self-bootstrap a
 * random 32-byte key persisted at {TEAMMCP_HOME}/data/.cred-key (0600,
 * gitignored). Threat model: protects tokens against casual DB inspection and
 * accidental git commit — NOT against an attacker who already has filesystem
 * read access (they could read the key too). That matches the secrets-file
 * threat model; it is strictly better than the previous plaintext-in-DB state.
 *
 * If the key file is lost, existing profile tokens become undecryptable and
 * must be re-entered — acceptable for this data class.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { TEAMMCP_HOME } from './lib/paths.mjs';

const KEY_PATH = join(TEAMMCP_HOME, 'data', '.cred-key');
let _key = null;

function loadOrCreateKey() {
  if (_key) return _key;
  try {
    if (existsSync(KEY_PATH)) {
      const hex = readFileSync(KEY_PATH, 'utf-8').trim();
      const buf = Buffer.from(hex, 'hex');
      if (buf.length === 32) { _key = buf; return _key; }
      console.warn('[cred-crypto] existing key malformed — regenerating (existing profile tokens will be undecryptable)');
    }
  } catch (e) {
    console.warn('[cred-crypto] failed reading key file:', e.message);
  }
  // Generate + persist a fresh key.
  _key = randomBytes(32);
  try {
    mkdirSync(join(TEAMMCP_HOME, 'data'), { recursive: true });
    writeFileSync(KEY_PATH, _key.toString('hex'), { mode: 0o600 });
    try { chmodSync(KEY_PATH, 0o600); } catch { /* best-effort on Windows */ }
  } catch (e) {
    console.error('[cred-crypto] failed persisting key — encryption will not survive restart:', e.message);
  }
  return _key;
}

/**
 * Encrypt a plaintext string.
 * @returns {{ enc: string, iv: string, tag: string }} all hex
 */
export function encryptToken(plaintext) {
  const key = loadOrCreateKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  let enc = cipher.update(String(plaintext ?? ''), 'utf8', 'hex');
  enc += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return { enc, iv: iv.toString('hex'), tag };
}

/**
 * Decrypt a { enc, iv, tag } triple back to plaintext.
 * Throws if the key is wrong or data is tampered (GCM auth failure).
 */
export function decryptToken(enc, iv, tag) {
  const key = loadOrCreateKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  let dec = decipher.update(enc, 'hex', 'utf8');
  dec += decipher.final('utf8');
  return dec;
}

/**
 * Prefix-preserving mask for display: "tp-cws3n…(51 chars)".
 * Never returns the full token.
 */
export function maskToken(plaintext) {
  const s = String(plaintext ?? '');
  if (!s) return '(empty)';
  const head = s.slice(0, 8);
  return `${head}…(${s.length} chars)`;
}
