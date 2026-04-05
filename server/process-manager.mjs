/**
 * Process Manager — Platform-agnostic entry point
 * Routes to the appropriate platform-specific implementation.
 */

import { platform } from 'node:os';

const isWindows = platform() === 'win32';
const isMac = platform() === 'darwin';

// Re-export all functions from the platform-specific implementation
if (isWindows) {
  // Windows implementation
  export {
    startAgent,
    stopAgent,
    screenshotAgent,
    sendKeysToAgent,
    cleanupStaleProcEntry,
    getAgentProcessStatus,
    checkProcessPermission,
    markStopped,
    clearStopped,
    isStopped,
  } from './process-manager-win.mjs';
} else if (isMac) {
  // macOS implementation
  export {
    startAgent,
    stopAgent,
    screenshotAgent,
    sendKeysToAgent,
    cleanupStaleProcEntry,
    getAgentProcessStatus,
    checkProcessPermission,
    markStopped,
    clearStopped,
    isStopped,
  } from './process-manager-mac.mjs';
} else {
  // Linux - use macOS implementation as base (may need adjustments)
  export {
    startAgent,
    stopAgent,
    screenshotAgent,
    sendKeysToAgent,
    cleanupStaleProcEntry,
    getAgentProcessStatus,
    checkProcessPermission,
    markStopped,
    clearStopped,
    isStopped,
  } from './process-manager-mac.mjs';
}
