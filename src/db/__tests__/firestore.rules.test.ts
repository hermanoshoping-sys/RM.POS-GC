import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
const blueprintPath = path.resolve(process.cwd(), 'firebase-blueprint.json');
const rulesText = fs.readFileSync(rulesPath, 'utf8');
const blueprint = JSON.parse(fs.readFileSync(blueprintPath, 'utf8'));

describe('Firestore Security Rules — Eight Pillars & Dirty Dozen Structural Audit', () => {
  it('enforces rules_version 2 and a global default-deny safety net', () => {
    expect(rulesText).toContain("rules_version = '2';");
    expect(rulesText).toMatch(/match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;\s*\}/);
  });

  it('matches every collection defined in firebase-blueprint.json', () => {
    const paths = Object.keys(blueprint.firestore);
    expect(paths).toContain('/users/{userId}');
    expect(paths).toContain('/users/{userId}/accounts/{accountId}');
    expect(paths).toContain('/users/{userId}/accounts/{accountId}/tableChunks/{chunkId}');
    expect(paths).toContain('/admins/{adminUid}');

    expect(rulesText).toContain('match /admins/{adminUid}');
    expect(rulesText).toContain('match /users/{userId}');
    expect(rulesText).toContain('match /accounts/{accountId}');
    expect(rulesText).toContain('match /tableChunks/{chunkId}');
  });

  it('blocks email spoofing, unverified writes, and blanket PII list scraping', () => {
    expect(rulesText).toContain('request.auth.token.email_verified == true');
    expect(rulesText).toContain('allow list: if false;'); // on /admins and /users
    expect(rulesText).not.toMatch(/allow\s+(read|get|list)\s*:\s*if\s+isSignedIn\(\)\s*;/);
    expect(rulesText).toContain("request.auth.token.email == 'hermanoshoping@gmail.com' && request.auth.token.email_verified == true");
  });

  it('enforces validation blueprints, immutability, server timestamps, and terminal state locking', () => {
    expect(rulesText).toContain('function isValidUserProfile(');
    expect(rulesText).toContain('function isValidCloudAccount(');
    expect(rulesText).toContain('function isValidTableChunk(');
    expect(rulesText).toContain('incoming().createdAt == request.time');
    expect(rulesText).toContain('incoming().updatedAt == request.time');
    expect(rulesText).toContain("existing().licenseStatus != 'revoked' || isAdmin()");
    expect(rulesText).toContain('incoming().licenseNumber == existing().licenseNumber');
    expect(rulesText).toContain('data.items.size() <= 100');
  });

  it('enforces Master Gate on tableChunks and avoids get()/exists() inside allow list', () => {
    expect(rulesText).toContain('function isActiveAccountOwner(userId, accountId)');
    expect(rulesText).toContain('get(/databases/$(database)/documents/users/$(userId)/accounts/$(accountId)).data.licenseStatus == \'active\'');
    const listBlocks = rulesText.match(/allow list:[^;]+;/g) ?? [];
    expect(listBlocks.length).toBeGreaterThanOrEqual(4);
    for (const block of listBlocks) {
      expect(block).not.toContain('get(');
      expect(block).not.toContain('exists(');
    }
  });
});
