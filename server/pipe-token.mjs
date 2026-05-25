/**
 * pipe-token.mjs — NB4 pure-Node mitigation for Named Pipe access control.
 *
 * ============================================================================
 * [NB4][INTERIM] pipe-token file-based, same-user attacker can bypass,
 * see §1.0.5 carry-over — DO NOT TREAT AS SECURITY BOUNDARY
 * ============================================================================
 *
 * This module is an INTERIM stopgap for Phase 4-T1. NB4 (pipe authentication)
 * is NOT resolved by this file and the resolution is carried over to
 * Phase 4-T2. The token below is:
 *   - written to disk in the user config dir (same-user-readable on Windows;
 *     mode 0o600 only on POSIX, and even there survives in backups /
 *     snapshots / crash dumps);
 *   - fully replayable until daemon restart — there is no per-session
 *     challenge in this file alone;
 *   - observable by any process already running as the daemon's user,
 *     including log scrapers, backup agents, and AV products that open
 *     everything under the profile.
 *
 * The ONLY property this file provides is rejecting cross-user and
 * unauthenticated connections at the handshake. Within the same SID, a
 * malicious or merely over-curious peer is not stopped by this file. Do
 * not cite "the token file" as a security boundary in design docs, threat
 * models, or code comments — §1.0.5 is the source of truth for NB4 status
 * and carry-over scope.
 *
 * Phase 4-T2 candidates that actually resolve NB4:
 *   - Token broker process architecture (pure JS, new detached component).
 *   - Native Windows addon: ImpersonateNamedPipeClient + GetTokenUser for
 *     per-connection SID check, and/or CreateNamedPipeW + SECURITY_ATTRIBUTES
 *     + SDDL to limit who can open the pipe at all.
 *   - DPAPI + entropy (to be independently re-evaluated in T2 — current
 *     expectation is no net security gain given same-user scope).
 *
 * Phase 4-T1 defense-in-depth additions that layer on top of this file but
 * are NOT the resolution:
 *   - Fix B (nonce + HMAC challenge in handshake) — reduces replay window.
 *   - Fix C (handshake rejection observability counters in pty-daemon-ipc.mjs).
 */

import { randomBytes } from 'node:crypto';
import {
  constants as fsConstants,
  existsSync, mkdirSync, statSync, chmodSync,
  openSync, writeSync, readSync, closeSync, fstatSync,
  lstatSync, unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { platform } from 'node:os';
import { getPipeTokenFilePath } from './ipc-protocol.mjs';

const TOKEN_BYTES = 32;
const isWindows = platform() === 'win32';

// ── #5: parent dir prerequisite ────────────────────────────────
//
// Before touching the token file path at all, verify the parent dir
// is (a) not a symlink, (b) owned by the current process uid on POSIX,
// and (c) restricted to owner access (0o700 on POSIX). If any check
// fails we throw with a clear `[NB4][INTERIM] parent dir prerequisite
// failed` message so ops knows to investigate — we do not silently
// proceed under relaxed permissions.
//
// Windows caveat: we still `lstat`-check that the parent is not a
// symlink, but owner-uid and POSIX mode checks do not apply. On
// Windows we rely on the NTFS default DACL of `%USERPROFILE%`, which
// grants only the user profile owner and SYSTEM. This is documented
// in §1.0.5 / §1.1 of the Phase 4-T1 IPC protocol spec draft as a
// carried-over gap under the NB4 interim framing.
function _verifyParentDir(dir) {
  // Create the parent if missing, with a tight mode on POSIX. `mode`
  // is advisory on Windows; NTFS DACL inheritance takes over.
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // Narrow parent dir mode on POSIX regardless of how it was created
  // (recursive mkdir may have been a no-op if the dir already
  // existed). Best-effort — if chmod fails we check the mode below
  // and throw.
  if (!isWindows) {
    try { chmodSync(dir, 0o700); } catch { /* check mode below */ }
  }

  let st;
  try {
    st = lstatSync(dir);
  } catch (e) {
    throw new Error(`[NB4][INTERIM] parent dir prerequisite failed: lstat(${dir}): ${e && e.code || e}`);
  }

  if (st.isSymbolicLink()) {
    throw new Error(`[NB4][INTERIM] parent dir prerequisite failed: ${dir} is a symbolic link`);
  }

  if (!st.isDirectory()) {
    throw new Error(`[NB4][INTERIM] parent dir prerequisite failed: ${dir} is not a directory`);
  }

  if (!isWindows) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid !== null && st.uid !== uid) {
      throw new Error(`[NB4][INTERIM] parent dir prerequisite failed: ${dir} owner uid=${st.uid} != process uid=${uid}`);
    }
    // Mode must not grant group/other any bits. Only owner bits allowed.
    const modeBits = st.mode & 0o777;
    if ((modeBits & 0o077) !== 0) {
      throw new Error(`[NB4][INTERIM] parent dir prerequisite failed: ${dir} mode=0o${modeBits.toString(8)} grants group/other access`);
    }
  }
}

/**
 * Daemon: generate and persist a fresh token at startup.
 * Returns the hex-encoded token string.
 *
 * [Round 3 / H3] Safe-create path. The previous implementation used
 * `writeFileSync(path, data)` followed by `chmodSync(path, 0o600)`, which
 * introduced two attack windows on same-user-writable parent dirs:
 *
 *   1. Symlink-clobber: a malicious same-user peer could pre-create a
 *      symlink at `tokenPath` pointing at `~/.ssh/authorized_keys` (or
 *      any other target). `writeFileSync` would follow the symlink and
 *      overwrite the target.
 *   2. Chmod race: there is a window between `writeFileSync` creating
 *      the file with the process umask (often 0o644) and `chmodSync`
 *      narrowing it to 0o600, during which a concurrent reader can
 *      slurp the token.
 *
 * Both holes are closed by creating the file atomically with
 * `openSync(path, O_CREAT|O_WRONLY|O_EXCL[|O_NOFOLLOW], 0o600)`:
 *   - `O_EXCL` makes the call fail if the path already exists, which
 *     blocks symlink-clobber because the symlink is itself a path that
 *     exists.
 *   - `O_NOFOLLOW` (POSIX, best-effort) makes open refuse to follow a
 *     symlink at the final path component — defense-in-depth on top of
 *     `O_EXCL` in case the attacker races the existence check with a
 *     symlink creation.
 *   - The mode `0o600` is set by `openSync` at file-creation time,
 *     atomically with creation. There is no window during which the
 *     new file has any broader permissions. No follow-up `chmodSync`
 *     is required — the Amendment 6 warning line is therefore
 *     superseded by this rewrite and intentionally not carried over.
 *
 * If the file already exists at startup (stale from a previous daemon
 * run that did not clean up), we `lstatSync` it first to refuse
 * symlinks, then `unlinkSync` and retry exactly once. A second EEXIST
 * is a hard error and propagates to the caller; we never loop and
 * never silently overwrite.
 *
 * Windows caveat: `O_NOFOLLOW` is not meaningfully supported on Windows
 * (`fs.constants.O_NOFOLLOW` is undefined); the structural safety on
 * Windows relies on the NTFS default DACL of the parent directory
 * (`%USERPROFILE%\.teammcp[-dev]`). A same-user attacker with write
 * access to that directory can still mount a race between the
 * `lstatSync` check and the `openSync` call. This is documented in
 * §1.0.5 / §1.1 of the Phase 4-T1 IPC protocol spec draft as a
 * carried-over gap under the NB4 interim framing; it is not fixed
 * here and must not be cited as a security boundary.
 */
export function writeDaemonToken(isDev = false) {
  const tokenPath = getPipeTokenFilePath(isDev);
  const dir = dirname(tokenPath);

  // #5: parent dir prerequisite — non-symlink, owner-owned, 0o700 on
  // POSIX. Throws on any violation; we do not silently proceed.
  _verifyParentDir(dir);

  const token = randomBytes(TOKEN_BYTES).toString('hex');

  // H3: if a stale token file exists, verify it's not a symlink, then
  // unlink it. `lstatSync` does not follow symlinks, so a symlink in
  // the path shows up as `isSymbolicLink() === true` here and we
  // refuse to proceed. Unlinking a symlink removes the symlink rather
  // than the target, but we still refuse so that a human is forced to
  // investigate why a symlink is sitting at the token path.
  if (existsSync(tokenPath)) {
    try {
      const st = lstatSync(tokenPath);
      if (st.isSymbolicLink()) {
        throw new Error(`[NB4][H3] refusing to proceed: ${tokenPath} is a symbolic link — possible symlink-clobber attack`);
      }
    } catch (e) {
      if (e && e.message && e.message.startsWith('[NB4][H3]')) throw e;
      // lstatSync failed for some other reason (permissions, race); fall
      // through and let openSync surface the real error.
    }
    try { unlinkSync(tokenPath); } catch { /* ignore; openSync will fail cleanly if still present */ }
  }

  // H3: atomic safe-create. `O_EXCL` blocks symlink-clobber; `O_NOFOLLOW`
  // (POSIX only) refuses to follow a symlink at the final component;
  // mode 0o600 is set at creation time — no chmod race.
  let flags = fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_EXCL;
  if (!isWindows && typeof fsConstants.O_NOFOLLOW === 'number') {
    flags |= fsConstants.O_NOFOLLOW;
  }

  let fd;
  try {
    fd = openSync(tokenPath, flags, 0o600);
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      // A concurrent process raced us to creating the file. Unlink once
      // and retry exactly once; if the second attempt also fails, let
      // the error propagate. We do not loop and we do not silently
      // overwrite.
      try { unlinkSync(tokenPath); } catch { /* ignore */ }
      fd = openSync(tokenPath, flags, 0o600);
    } else {
      throw e;
    }
  }

  try {
    writeSync(fd, token);
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }

  return token;
}

/**
 * Client: read the token from disk. Returns null if the file does not
 * exist (e.g. daemon not started by the same user) — the caller MUST
 * treat null as "cannot connect" per NB4.
 *
 * [Round 3 / #4] Read-side TOCTOU hardening. The previous
 * implementation called `readFileSync(tokenPath, 'utf-8')`, which is
 * vulnerable to a same-user attacker replacing the token file with a
 * symlink between the daemon's write and the client's read. The
 * hardened path:
 *
 *   1. Verifies the parent dir via `_verifyParentDir` (#5) — non-
 *      symlink, owner-owned, 0o700 on POSIX.
 *   2. Opens the token file with `O_NOFOLLOW` on POSIX so a symlink
 *      at the final path component fails the open. Windows uses an
 *      `lstat` pre-check instead because `O_NOFOLLOW` is not
 *      supported there.
 *   3. Reads by file descriptor (`readSync(fd, ...)`), not by name —
 *      so a concurrent rename/replace after open cannot redirect the
 *      read.
 *   4. On POSIX, calls `fstatSync(fd)` and verifies
 *      `stat.uid === process.getuid()`; rejects if the file owner
 *      changed since creation.
 *   5. Closes the descriptor unconditionally in `finally`.
 *
 * Any failure path returns null (the existing failure contract —
 * caller treats null as "cannot connect") and logs a single
 * `[NB4][INTERIM]` line for ops visibility.
 */
export function readClientToken(isDev = false) {
  const tokenPath = getPipeTokenFilePath(isDev);
  const dir = dirname(tokenPath);

  // #5: parent dir prerequisite applies to the read side too.
  try {
    _verifyParentDir(dir);
  } catch (e) {
    console.warn('[NB4][INTERIM] readClientToken: parent dir prerequisite failed:',
      e && (e.message || e.code));
    return null;
  }

  if (!existsSync(tokenPath)) return null;

  // #4: Windows pre-check — refuse to read through a symlink. On
  // POSIX this is a belt-and-braces check; `O_NOFOLLOW` below also
  // handles it.
  try {
    const st = lstatSync(tokenPath);
    if (st.isSymbolicLink()) {
      console.warn('[NB4][INTERIM] readClientToken: symlink or ownership check failed (pre-open lstat)');
      return null;
    }
  } catch {
    return null;
  }

  let flags = fsConstants.O_RDONLY;
  if (!isWindows && typeof fsConstants.O_NOFOLLOW === 'number') {
    flags |= fsConstants.O_NOFOLLOW;
  }

  let fd = -1;
  try {
    fd = openSync(tokenPath, flags);

    // #4: fstat by descriptor — after this point a concurrent
    // rename/replace cannot redirect the read.
    const st = fstatSync(fd);

    if (!isWindows) {
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      if (uid !== null && st.uid !== uid) {
        console.warn('[NB4][INTERIM] readClientToken: symlink or ownership check failed (fstat uid mismatch)');
        return null;
      }
    }

    // Size sanity — must be big enough to hold a hex 32-byte token
    // (64 chars) plus possible trailing whitespace / newline. Cap
    // well below 4 KB to avoid reading arbitrary attacker payloads.
    const MAX_TOKEN_FILE_BYTES = 1024;
    if (st.size <= 0 || st.size > MAX_TOKEN_FILE_BYTES) {
      console.warn('[NB4][INTERIM] readClientToken: token file size out of range:', st.size);
      return null;
    }

    const buf = Buffer.allocUnsafe(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, null);
      if (n <= 0) break;
      off += n;
    }
    const raw = buf.slice(0, off).toString('utf-8').trim();
    if (!raw || raw.length < TOKEN_BYTES) return null;
    return raw;
  } catch (e) {
    console.warn('[NB4][INTERIM] readClientToken: symlink or ownership check failed:',
      e && (e.code || e.message));
    return null;
  } finally {
    if (fd !== -1) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Constant-time comparison between two tokens. Returns true iff they match.
 * Guards against timing-oracle side-channels in the handshake path.
 */
export function tokensEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Diagnostic: file exists and looks like a real token (for log clarity).
 */
export function tokenFileStatus(isDev = false) {
  const tokenPath = getPipeTokenFilePath(isDev);
  if (!existsSync(tokenPath)) return { present: false, path: tokenPath };
  try {
    const st = statSync(tokenPath);
    return { present: true, path: tokenPath, size: st.size };
  } catch {
    return { present: false, path: tokenPath };
  }
}
