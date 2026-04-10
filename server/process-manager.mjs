// process-manager.mjs — sole canonical entry point after dedupe
// Pattern A: dispatcher re-exports platform-specific implementation.
// Do NOT use export * — always use named re-exports (spec §3, §7 risk 3).
import { platform } from 'node:os';

const PLATFORM = platform();

const impl = await (
  PLATFORM === 'win32'
    ? import('./process-manager-impl-win.mjs')
  : PLATFORM === 'darwin'
    ? import('./process-manager-impl-mac.mjs')
  : (() => { throw new Error(`[process-manager] unsupported platform: ${PLATFORM}`); })()
);

// Named re-exports. 10 public functions — frozen surface, any change requires spec bump.
export const markStopped            = impl.markStopped;
export const clearStopped           = impl.clearStopped;
export const isStopped              = impl.isStopped;
export const startAgent             = impl.startAgent;
export const stopAgent              = impl.stopAgent;
export const screenshotAgent        = impl.screenshotAgent;
export const sendKeysToAgent        = impl.sendKeysToAgent;
export const cleanupStaleProcEntry  = impl.cleanupStaleProcEntry;
export const getAgentProcessStatus  = impl.getAgentProcessStatus;
export const checkProcessPermission = impl.checkProcessPermission;
// Path A shared constants — re-export for credential-lease.mjs et al.
export const SAFE_NAME_RE          = impl.SAFE_NAME_RE;
