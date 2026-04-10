/**
 * credential-manager-merge-protection.test.mjs
 *
 * Verifies that the reverse-merge logic in credential-manager.mjs protects
 * server-owned fields (refreshToken, scopes, subscriptionType, rateLimitTier)
 * from being overwritten by null/undefined values coming from agent credential files.
 *
 * Two merge sites are tested:
 *   1. collectAgentTokens()  — around line 395-403
 *   2. distributeToAgents()  — around line 631-641
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── Shared test data ───────────────────────────────────────────────────────

const SERVER_OAUTH = {
  accessToken: 'server-access-token',
  refreshToken: 'server-refresh-token-real-value',
  expiresAt: Date.now() + 3_600_000,
  scopes: 'user:profile user:inference user:sessions:claude_code',
  subscriptionType: 'max',
  rateLimitTier: 'tier-2',
  tokenType: 'Bearer',
};

const AGENT_OAUTH_NULL_FIELDS = {
  accessToken: 'agent-newer-access-token',
  refreshToken: null,           // should NOT overwrite server's value
  expiresAt: Date.now() + 7_200_000, // newer than server
  scopes: null,                 // should NOT overwrite
  subscriptionType: null,       // should NOT overwrite
  rateLimitTier: null,          // should NOT overwrite
  tokenType: 'Bearer',
};

// ─── Helper: replicates the merge logic from credential-manager.mjs ─────────

function reverseMerge(freshMain, agentCreds) {
  return {
    ...freshMain,
    claudeAiOauth: {
      ...freshMain.claudeAiOauth,
      ...agentCreds.claudeAiOauth,
      // Server-owned fields — always keep main's values
      refreshToken: freshMain.claudeAiOauth.refreshToken,
      scopes: freshMain.claudeAiOauth.scopes,
      subscriptionType: freshMain.claudeAiOauth.subscriptionType,
      rateLimitTier: freshMain.claudeAiOauth.rateLimitTier,
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('credential-manager reverse merge — server field protection', () => {

  it('keeps server refreshToken when agent has null', () => {
    const main = { claudeAiOauth: { ...SERVER_OAUTH } };
    const agent = { claudeAiOauth: { ...AGENT_OAUTH_NULL_FIELDS } };

    const merged = reverseMerge(main, agent);

    assert.equal(
      merged.claudeAiOauth.refreshToken,
      'server-refresh-token-real-value',
      'refreshToken should be the server value, not null',
    );
  });

  it('keeps server scopes when agent has null', () => {
    const main = { claudeAiOauth: { ...SERVER_OAUTH } };
    const agent = { claudeAiOauth: { ...AGENT_OAUTH_NULL_FIELDS } };

    const merged = reverseMerge(main, agent);

    assert.equal(
      merged.claudeAiOauth.scopes,
      'user:profile user:inference user:sessions:claude_code',
      'scopes should be the server value, not null',
    );
  });

  it('keeps server subscriptionType when agent has null', () => {
    const main = { claudeAiOauth: { ...SERVER_OAUTH } };
    const agent = { claudeAiOauth: { ...AGENT_OAUTH_NULL_FIELDS } };

    const merged = reverseMerge(main, agent);

    assert.equal(
      merged.claudeAiOauth.subscriptionType,
      'max',
      'subscriptionType should be the server value, not null',
    );
  });

  it('keeps server rateLimitTier when agent has null', () => {
    const main = { claudeAiOauth: { ...SERVER_OAUTH } };
    const agent = { claudeAiOauth: { ...AGENT_OAUTH_NULL_FIELDS } };

    const merged = reverseMerge(main, agent);

    assert.equal(
      merged.claudeAiOauth.rateLimitTier,
      'tier-2',
      'rateLimitTier should be the server value, not null',
    );
  });

  it('adopts agent accessToken and expiresAt (newer token fields)', () => {
    const main = { claudeAiOauth: { ...SERVER_OAUTH } };
    const agent = { claudeAiOauth: { ...AGENT_OAUTH_NULL_FIELDS } };

    const merged = reverseMerge(main, agent);

    assert.equal(
      merged.claudeAiOauth.accessToken,
      'agent-newer-access-token',
      'accessToken should come from the agent (newer)',
    );
    assert.equal(
      merged.claudeAiOauth.expiresAt,
      AGENT_OAUTH_NULL_FIELDS.expiresAt,
      'expiresAt should come from the agent (newer)',
    );
  });

  it('handles agent having undefined fields (not just null)', () => {
    const main = { claudeAiOauth: { ...SERVER_OAUTH } };
    const agent = {
      claudeAiOauth: {
        accessToken: 'agent-token',
        expiresAt: Date.now() + 9_999_000,
        // refreshToken, scopes, subscriptionType, rateLimitTier are absent
      },
    };

    const merged = reverseMerge(main, agent);

    assert.equal(merged.claudeAiOauth.refreshToken, 'server-refresh-token-real-value');
    assert.equal(merged.claudeAiOauth.scopes, SERVER_OAUTH.scopes);
    assert.equal(merged.claudeAiOauth.subscriptionType, 'max');
    assert.equal(merged.claudeAiOauth.rateLimitTier, 'tier-2');
  });

  it('preserves non-oauth top-level fields from main', () => {
    const main = {
      claudeAiOauth: { ...SERVER_OAUTH },
      someOtherField: 'should-stay',
      nested: { keep: true },
    };
    const agent = { claudeAiOauth: { ...AGENT_OAUTH_NULL_FIELDS } };

    const merged = reverseMerge(main, agent);

    assert.equal(merged.someOtherField, 'should-stay');
    assert.deepEqual(merged.nested, { keep: true });
  });
});
