/**
 * TeamMCP Platform Utilities
 *
 * Detects the current OS and exposes which optional features are available:
 * - Process management (start/stop agents): Windows + macOS
 * - Screenshots: Windows (.NET) + macOS (screencapture)
 * - SendKeys: Windows (PowerShell SendKeys) + macOS (osascript)
 */

import { platform, release, type } from 'node:os';

// ── Platform detection ──────────────────────────────────────

export const isWindows = platform() === 'win32';
export const isMac     = platform() === 'darwin';
export const isLinux  = platform() === 'linux';
export const osType   = type();       // 'Windows_NT' | 'Darwin' | 'Linux'
export const osRelease = release();   // e.g. '10.0.22631' on Windows 22H2, '24.0.0' on macOS

// ── Feature availability ───────────────────────────────────

/**
 * Whether the current OS supports launching and managing agent processes.
 * Windows: uses PowerShell + wt.exe + taskkill
 * macOS: uses osascript + Terminal.app + pkill
 */
export const supportsProcessManager = isWindows || isMac;

/**
 * Whether the current OS supports screenshots.
 * Windows: uses .NET System.Drawing via PowerShell
 * macOS: uses screencapture command
 */
export const supportsScreenshots = isWindows || isMac;

/**
 * Whether the current OS supports send-keys (injecting keystrokes).
 * Windows: uses PowerShell SendKeys
 * macOS: uses osascript Terminal.app scripting
 */
export const supportsSendKeys = isWindows || isMac;

/**
 * Human-readable platform description for use in UI/Dashboard.
 */
export const platformDescription = isWindows
  ? `Windows ${osRelease}`
  : isMac
  ? `macOS ${osRelease}`
  : `Linux ${osRelease}`;

/**
 * Returns a list of unavailable features for the current platform.
 * Used to show warnings in Dashboard or CLI.
 */
export function unavailableFeatures() {
  const missing = [];
  if (!supportsProcessManager) missing.push('Agent start/stop (process management)');
  if (!supportsScreenshots)     missing.push('Screenshots');
  if (!supportsSendKeys)        missing.push('Send keys');
  return missing;
}
