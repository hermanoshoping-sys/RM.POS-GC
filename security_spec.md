# RM.POS GC — Firestore Security Specification (Phase 0 TDD)

## 1. Data Invariants & Relationship Mapping
- **Master Source of Truth:** Every cloud user has a private profile at `/users/{userId}` where `userId == request.auth.uid`.
- **Store Ownership:** Every independent store account lives at `/users/{userId}/accounts/{accountId}`. A store account cannot be created unless the parent `/users/{userId}` profile exists, the caller is a verified email user (`request.auth.token.email_verified == true`), and `ownerUid == request.auth.uid`.
- **Master Gate for Synced Data:** Every synced table chunk at `/users/{userId}/accounts/{accountId}/tableChunks/{chunkId}` strictly verifies via `get()` on single-document operations that the parent account exists, belongs to `request.auth.uid`, and has `licenseStatus == 'active'`. On `list` queries, rules evaluate `resource.data.ownerUid == request.auth.uid && resource.data.accountId == accountId` directly without `get()`/`exists()`.
- **PII Isolation:** `/users/{userId}` and `/users/{userId}/accounts/{accountId}` contain email and phone PII; reads and writes are strictly restricted to the owner (`request.auth.uid == userId`) or a verified admin. Listing `/users` is forbidden.
- **Immutability & Terminal State Locking:** `uid`, `ownerUid`, `accountId`, `licenseNumber`, `activationCodeHash`, `activationCodeSalt`, `tableName`, and `createdAt` are immutable after creation. Once `licenseStatus == 'revoked'`, non-admins cannot update the account or write new table chunks.
- **Temporal Integrity:** All `createdAt`, `updatedAt`, and `lastSyncedAt` fields must equal `request.time`.

## 2. The "Dirty Dozen" Attack Payloads (All Must Fail with PERMISSION_DENIED)
1. **Unauthenticated Profile Read/Write:** Unauthenticated caller attempts `get` or `create` on `/users/uid_alice`.
2. **Unverified Email Write (Email Spoofing):** Authenticated user with `email_verified: false` (even matching admin email `hermanoshoping@gmail.com`) attempts to create `/users/uid_spoof` or write an account.
3. **Cross-Tenant PII Read:** Authenticated user `uid_bob` attempts `get` on `/users/uid_alice` or `/users/uid_alice/accounts/acc_alice1`.
4. **Blanket Users Collection Scrape:** Authenticated user `uid_bob` attempts `list` on `/users`.
5. **Identity Spoofing on Account Creation:** `uid_bob` attempts to create `/users/uid_bob/accounts/acc_spoof` with `ownerUid: "uid_alice"`.
6. **Shadow Field Injection (Ghost Field):** `uid_alice` attempts to update `/users/uid_alice` or `/users/uid_alice/accounts/acc_1` with an undeclared field `isAdmin: true` or `isVerified: true`.
7. **Self-Assigned Admin Privilege Escalation:** `uid_bob` attempts to create `/admins/uid_bob`.
8. **Client-Forged Timestamp:** `uid_alice` creates `/users/uid_alice/accounts/acc_1` with client timestamp `createdAt: "2020-01-01T00:00:00Z"` instead of `request.time`.
9. **Immutable License Tampering:** `uid_alice` attempts to update `licenseNumber` or `ownerUid` on an existing `/users/uid_alice/accounts/acc_1`.
10. **Terminal State Bypass (Revoked License):** `uid_alice` attempts to update an account whose `licenseStatus == 'revoked'` back to `'active'`, or write a `tableChunk` under a revoked account.
11. **Resource / ID Poisoning & Array Overflow:** `uid_alice` attempts to create a `tableChunk` with a 200-char invalid ID (`$$$...`) or `items.size() > 100` or an invalid `tableName: "evilTable"`.
12. **Orphaned Account / Cross-Account Chunk Injection:** `uid_alice` attempts to create a `tableChunk` under `/users/uid_alice/accounts/acc_nonexistent/tableChunks/products_c0` or with mismatched `accountId: "acc_other"`.
