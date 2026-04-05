/**
 * TeamMCP Platform Utilities
 *
 * Detects the current OS and exposes which optional features are available:
 * - Process management (start/stop agents): Windows only via PowerShell
 * - Screenshots: Windows only via .NET System.Drawing
 * - SendKeys: Windows only via PowerShell SendKeys
 */

import { platform, release, type } from 'node:os';

// ── Platform detection ──────────────────────────────────────

export const isWindows = platform() === 'win32';
export const isMac     = platform() === 'darwin';
export const isLinux  = platform() === 'linux';
export const osType   = type();       // 'Windows_NT' | 'Darwin' | 'Linux'
export const osRelease = release();   // e.g. '10.0.22631' on Windows 22H2

// ── Feature availability ────────────────────────────────────

/**
 * Whether the current OS supports launching and managing agent processes.
 * Currently Windows only (uses PowerShell + _start.cmd + taskkill).
 */
export const supportsProcessManager = isWindows;

/**
 * Whether the current OS supports screenshots.
 * Currently Windows only (uses .NET System.Drawing via PowerShell).
 */
export const supportsScreenshots = isWindows;

/**
 * Whether the current OS supports send-keys (injecting keystrokes).
 * Currently Windows only (uses PowerShell SendKeys).
 */
export const supportsSendKeys = isWindows;

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
