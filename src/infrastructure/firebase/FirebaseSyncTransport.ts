/**
 * ChoreScore V5 — Firebase Spark collaboration authority.
 *
 * This transport implements the exact HTTP paths used by `RemoteSyncAdapter`
 * directly on Firestore. There is no Cloud Function, server, service account
 * or Blaze dependency: the signed-in user's ID token is the credential and
 * `firebase/firestore.rules` is the tenant/member authority.
 *
 * Atomicity: mutation batches, invitations, invitation acceptance and todo
 * completion each run in ONE Firestore read-write transaction. Group creation
 * uses two transactions because Firestore rules resolve `exists()` against the
 * state at the start of a transaction: the group document is created at
 * revision 0, then its baseline records are appended once membership exists.
 * A crash in between is repaired on the next `ensureRemoteGroup`, because a
 * revision-0 group is never treated as fully synced. Optimistic versions and
 * the idempotent mutation log match the frugal SQLite authority, so a retry
 * after an ambiguous network result cannot duplicate a write.
 */
import {
  ContributionEntry,
  ContributionMoneyRate,
  CrossLedgerSettlement,
  ExpenseEntry,
  Household,
  Member,
  Membership,
  TodoItem,
} from '../../domain/entities';
import {
  calculateContributionBalances,
} from '../../domain/calculations/contributionLedger';
import { allocateExpense } from '../../domain/calculations/expenseLedger';
import { quoteCrossLedgerMoneyAmount } from '../../domain/calculations/crossLedgerSettlement';
import { validateSettlementPreconditions } from '../../domain/calculations/settlementPreconditions';
import {
  CompletionInput,
  ExpenseCompletionInput,
  planTodoCompletion,
} from '../../domain/services/todoCompletionService';
import { todoCompletionEntryId } from '../../domain/services/todoCompletionId';
import {
  FirestoreConflictError,
  FirestoreDocument,
  FirestoreFilter,
  FirestorePort,
  FirestoreTransaction,
  FirestoreValue,
} from './FirestorePort';
import { FirestoreRestClient } from './FirestoreRestClient';

type ChangeCollection =
  | 'memberships'
  | 'contribution_entries'
  | 'expense_entries'
  | 'todo_items'
  | 'persistent_tasks'
  | 'categories'
  | 'members'
  | 'households'
  | 'settlements';

interface ClientChange {
  collection: ChangeCollection;
  id: string;
  baseVersion: number;
  value: Record<string, unknown> | null;
}

interface AppliedChange extends Omit<ClientChange, 'baseVersion'> {
  version: number;
}

interface AccessEntry {
  memberId: string;
  role: 'OWNER' | 'MEMBER';
  inviteHash?: string;
}

interface GroupDoc {
  id: string;
  ownerId: string;
  revision: number;
  household: Household;
  memberUids: string[];
  access: Record<string, AccessEntry>;
  createdAt: string;
  deleted?: boolean;
}

interface RecordDoc {
  id: string;
  collection: string;
  version: number;
  value: Record<string, unknown> | null;
  updatedAt: string;
}

interface MutationDoc {
  uid: string;
  hash: string;
  response: { revision: number; changes: AppliedChange[] };
}

const WRITABLE = new Set<ChangeCollection>([
  'contribution_entries',
  'expense_entries',
  'todo_items',
  'persistent_tasks',
  'categories',
  'members',
  'households',
  'settlements',
]);
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_RECORD_BYTES = 64 * 1024;
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

export class FirebaseTransportError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'FirebaseTransportError';
  }
}

export interface FirebaseSyncConfig {
  /** Used to build a real REST client. Ignored when `client` is supplied. */
  projectId?: string;
  /** Test seam / custom Firestore implementation. */
  client?: FirestorePort;
  getAccessToken: () => Promise<string | null>;
  /** Avoids decoding the token in the normal app; tests may omit it. */
  getUid?: () => string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  createToken?: () => Promise<string>;
  createId?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new FirebaseTransportError(400, message);
}

function requireId(value: unknown): asserts value is string {
  requireCondition(typeof value === 'string' && ID.test(value), 'Invalid identifier');
}

function requireText(value: unknown, max = 200): asserts value is string {
  requireCondition(typeof value === 'string' && value.trim().length > 0 && value.length <= max, 'Invalid text');
}

function sanitize(value: unknown): FirestoreValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new FirebaseTransportError(400, 'Invalid number');
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (isRecord(value)) {
    const result: Record<string, FirestoreValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) result[key] = sanitize(item);
    }
    return result;
  }
  throw new FirebaseTransportError(400, 'Invalid record value');
}

function recordPath(groupId: string, collection: string, entityId: string): string {
  return `groups/${groupId}/records/${collection}:${entityId}`;
}

function groupPath(groupId: string): string {
  return `groups/${groupId}`;
}

function fieldString(document: FirestoreDocument | null, key: string): string | null {
  const value = document?.fields[key];
  return typeof value === 'string' ? value : null;
}

function base64UrlDecode(input: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = input.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const value = alphabet.indexOf(char);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  let encoded = '';
  for (const byte of bytes) encoded += `%${byte.toString(16).padStart(2, '0')}`;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return '';
  }
}

function uidFromToken(token: string): string {
  const parts = token.split('.');
  if (parts.length < 2) return '';
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1])) as {
      user_id?: string;
      sub?: string;
      user?: { user_id?: string };
    };
    return payload.user_id || payload.sub || payload.user?.user_id || '';
  } catch {
    return '';
  }
}

function base64Url(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += alphabet[first >> 2];
    output += alphabet[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    if (second === undefined) break;
    output += alphabet[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
    if (third === undefined) break;
    output += alphabet[third & 0x3f];
  }
  return output;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }
  const Crypto = await import('expo-crypto');
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function defaultToken(): Promise<string> {
  const Crypto = await import('expo-crypto');
  return base64Url(await Crypto.getRandomBytesAsync(32));
}

export class FirebaseSyncTransport {
  private readonly client: FirestorePort;
  private readonly getAccessToken: () => Promise<string | null>;
  private readonly getUid: () => string | null;
  private readonly now: () => number;
  private readonly createToken: () => Promise<string>;
  private readonly createId: () => string;

  constructor(config: FirebaseSyncConfig) {
    this.client =
      config.client ??
      new FirestoreRestClient({
        projectId: config.projectId ?? '',
        getAccessToken: config.getAccessToken,
        fetchImpl: config.fetchImpl,
      });
    this.getAccessToken = config.getAccessToken;
    this.getUid = config.getUid ?? (() => null);
    this.now = config.now ?? Date.now;
    this.createToken = config.createToken ?? defaultToken;
    this.createId =
      config.createId ??
      (() => {
        const crypto = globalThis.crypto as { randomUUID?: () => string } | undefined;
        return crypto?.randomUUID?.() ?? `${this.now()}-${Math.random().toString(36).slice(2)}`;
      });
  }

  private async auth(): Promise<{ token: string; uid: string }> {
    const token = await this.getAccessToken();
    if (!token) throw new FirebaseTransportError(401, 'Connexion Firebase requise');
    const uid = this.getUid() || uidFromToken(token);
    if (!uid) throw new FirebaseTransportError(401, 'Jeton Firebase invalide');
    return { token, uid };
  }

  async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const url = new URL(path, 'https://chorescore.local');
    const parts = url.pathname.split('/').filter(Boolean);
    const { uid } = await this.auth();
    if (method === 'GET' && url.pathname === '/groups') {
      return this.listGroups(uid);
    }
    if (method === 'POST' && url.pathname === '/groups') {
      return this.createGroup(uid, (body ?? {}) as Record<string, unknown>);
    }
    if (method === 'GET' && parts.length === 3 && parts[0] === 'groups' && parts[2] === 'deltas') {
      return this.deltas(uid, decodeURIComponent(parts[1]), Number(url.searchParams.get('since') ?? '0'));
    }
    if (method === 'POST' && parts.length === 3 && parts[0] === 'groups' && parts[2] === 'mutations') {
      return this.mutate(uid, decodeURIComponent(parts[1]), (body ?? {}) as Record<string, unknown>);
    }
    if (method === 'POST' && parts.length === 3 && parts[0] === 'groups' && parts[2] === 'delete') {
      return this.deleteGroup(uid, decodeURIComponent(parts[1]));
    }
    if (method === 'POST' && parts.length === 3 && parts[0] === 'groups' && parts[2] === 'invites') {
      return this.createInvite(uid, decodeURIComponent(parts[1]), String((body as { memberId?: unknown })?.memberId ?? ''));
    }
    if (
      method === 'POST' &&
      parts.length === 5 &&
      parts[0] === 'groups' &&
      parts[2] === 'invites' &&
      parts[4] === 'revoke'
    ) {
      return this.revokeInvite(uid, decodeURIComponent(parts[1]), decodeURIComponent(parts[3]));
    }
    if (method === 'POST' && parts.length === 3 && parts[0] === 'invites' && parts[2] === 'accept') {
      return this.acceptInvite(uid, decodeURIComponent(parts[1]));
    }
    if (
      method === 'POST' &&
      parts.length === 5 &&
      parts[0] === 'groups' &&
      parts[2] === 'todos' &&
      parts[4] === 'complete'
    ) {
      return this.completeTodo(uid, decodeURIComponent(parts[1]), decodeURIComponent(parts[3]), (body ?? {}) as Record<string, unknown>);
    }
    throw new FirebaseTransportError(404, 'Route Firebase inconnue');
  }

  private async group(transaction: FirestoreTransaction, groupId: string): Promise<GroupDoc | null> {
    const document = await transaction.get(groupPath(groupId));
    if (!document) return null;
    const fields = document.fields;
    const household = fields.household;
    const access = fields.access;
    const memberUids = fields.memberUids;
    if (!isRecord(household) || !isRecord(access) || !Array.isArray(memberUids)) return null;
    return {
      id: groupId,
      ownerId: String(fields.ownerId ?? ''),
      revision: Number(fields.revision ?? 0),
      household: household as unknown as Household,
      memberUids: memberUids.map(String),
      access: access as unknown as Record<string, AccessEntry>,
      createdAt: String(fields.createdAt ?? ''),
      ...(fields.deleted === true ? { deleted: true } : {}),
    };
  }

  private requireAccess(group: GroupDoc | null, uid: string, allowDeleted = false): GroupDoc {
    if (!group) throw new FirebaseTransportError(404, 'Groupe introuvable');
    if (!group.access[uid]) throw new FirebaseTransportError(403, 'Group access denied');
    if (group.deleted === true && !allowDeleted) {
      throw new FirebaseTransportError(410, 'Ce groupe a été supprimé');
    }
    return group;
  }

  private async readRecord(
    transaction: FirestoreTransaction,
    groupId: string,
    collection: string,
    entityId: string,
  ): Promise<RecordDoc | null> {
    const document = await transaction.get(recordPath(groupId, collection, entityId));
    if (!document) return null;
    if (String(document.fields.collection ?? '') !== collection) {
      throw new FirebaseTransportError(409, 'Identifier already used');
    }
    return {
      id: String(document.fields.id ?? entityId),
      collection,
      version: Number(document.fields.version ?? 0),
      value: (document.fields.value ?? null) as Record<string, unknown> | null,
      updatedAt: String(document.fields.updatedAt ?? ''),
    };
  }

  private async readCollection(
    transaction: FirestoreTransaction,
    groupId: string,
    collection: string,
  ): Promise<RecordDoc[]> {
    const filter: FirestoreFilter[] = [{ field: 'collection', op: '==', value: collection }];
    const documents = await transaction.query(`groups/${groupId}/records`, filter);
    return documents.map((document) => ({
      id: String(document.fields.id ?? ''),
      collection,
      version: Number(document.fields.version ?? 0),
      value: (document.fields.value ?? null) as Record<string, unknown> | null,
      updatedAt: String(document.fields.updatedAt ?? ''),
    }));
  }

  private async writeRecord(
    transaction: FirestoreTransaction,
    groupId: string,
    revision: number,
    change: AppliedChange,
    now: string,
  ): Promise<void> {
    transaction.set(recordPath(groupId, change.collection, change.id), {
      id: change.id,
      collection: change.collection,
      version: change.version,
      value: sanitize(change.value),
      updatedAt: now,
      revision,
    });
  }

  private async append(
    transaction: FirestoreTransaction,
    group: GroupDoc,
    changes: ClientChange[],
    now: number,
  ): Promise<{ revision: number; changes: AppliedChange[] }> {
    const revision = group.revision + 1;
    const applied: AppliedChange[] = [];
    for (const change of changes) {
      const previous = await this.readRecord(transaction, group.id, change.collection, change.id);
      const version = (previous?.version ?? 0) + 1;
      const value = change.value;
      applied.push({ collection: change.collection, id: change.id, value, version });
      await this.writeRecord(
        transaction,
        group.id,
        revision,
        { collection: change.collection, id: change.id, value, version },
        new Date(now).toISOString(),
      );
      if (change.collection === 'households' && value) {
        group.household = value as unknown as Household;
      }
    }
    transaction.set(groupPath(group.id), {
      ...group,
      revision,
      household: sanitize(group.household),
      memberUids: group.memberUids,
      access: sanitize(group.access),
      createdAt: group.createdAt,
    } as unknown as Record<string, FirestoreValue>);
    transaction.set(`groups/${group.id}/events/${revision}`, {
      revision,
      groupId: group.id,
      count: applied.length,
      createdAt: new Date(now).toISOString(),
    });
    applied.forEach((change, index) => {
      transaction.set(`groups/${group.id}/events/${revision}/changes/${index}`, {
        revision,
        index,
        collection: change.collection,
        id: change.id,
        version: change.version,
        value: sanitize(change.value),
      });
    });
    return { revision, changes: applied };
  }

  private async listGroups(uid: string): Promise<unknown[]> {
    const documents = await this.client.query('groups', [
      { field: 'memberUids', op: 'array-contains', value: uid },
    ]);
    return documents.map((document) => {
      const access = (document.fields.access ?? {}) as unknown as Record<string, AccessEntry>;
      const household = document.fields.household as unknown as Household;
      return {
        household,
        revision: Number(document.fields.revision ?? 0),
        memberId: access[uid]?.memberId ?? '',
        role: access[uid]?.role ?? 'MEMBER',
        ...(document.fields.deleted === true ? { deleted: true } : {}),
      };
    });
  }

  private async createGroup(uid: string, input: Record<string, unknown>): Promise<unknown> {
    requireId(input.id);
    const groupId = input.id;
    const ownerMemberId = input.ownerMemberId;
    const ownerName = input.ownerName;
    requireId(ownerMemberId);
    const name = input.name;
    const unit = input.unit;
    requireText(name);
    requireText(ownerName, 60);
    requireCondition(unit === 'minutes' || unit === 'points', 'Invalid task unit');
    requireCondition(Array.isArray(input.members) && input.members.length <= 200, 'Invalid members');
    if (input.membershipId !== undefined) requireId(input.membershipId);
    const memberIds = new Set<string>([ownerMemberId]);
    for (const member of input.members as Array<Record<string, unknown>>) {
      const memberId = member.id;
      requireId(memberId);
      requireText(member.name, 60);
      requireCondition(!memberIds.has(memberId), 'Duplicate member');
      memberIds.add(memberId);
    }
    const now = this.now();
    const createdAt = new Date(now).toISOString();
    const household: Household = {
      id: groupId,
      name: name.trim(),
      ownerId: uid,
      contributionUnit: unit,
      crossLedgerCompensationEnabled: false,
      contributionToMoneyRate: null,
      createdAt,
    };
    const members: Member[] = [
      { id: ownerMemberId, householdId: groupId, name: ownerName, userId: uid, joinedAt: createdAt },
      ...(input.members as Array<Record<string, unknown>>).map((member) => ({
        id: String(member.id),
        householdId: groupId,
        name: String(member.name),
        userId: null,
        joinedAt: createdAt,
      })),
    ];
    const membership: Membership = {
      id: typeof input.membershipId === 'string' ? input.membershipId : this.createId(),
      householdId: groupId,
      userId: uid,
      role: 'OWNER',
      joinedAt: createdAt,
    };
    const group: GroupDoc = {
      id: groupId,
      ownerId: uid,
      revision: 0,
      household,
      memberUids: [uid],
      access: { [uid]: { memberId: ownerMemberId, role: 'OWNER' } },
      createdAt,
    };

    // Firestore rules resolve exists()/get() against the state at the start of
    // a transaction. Creating the group and its baseline records in one atomic
    // commit would therefore deny the records. The group document is committed
    // first (revision 0), then the baseline append runs in a second transaction
    // now that membership exists. A crash between them leaves revision 0, which
    // the next ensureRemoteGroup call repairs instead of declaring the group
    // synced with missing members.
    // Reading a missing group before it exists is denied by the group read
    // rule, so creation cannot start with a get(). Write with an explicit
    // exists:false precondition instead; a conflict means the group already
    // exists and can then be read under normal membership rules.
    const created = await this.client
      .runTransaction(async (transaction) => {
        transaction.set(
          groupPath(groupId),
          {
            ...group,
            household: sanitize(household),
            memberUids: sanitize(group.memberUids),
            access: sanitize(group.access),
          } as unknown as Record<string, FirestoreValue>,
          { exists: false },
        );
        return true;
      })
      .catch(async (error: unknown) => {
        if (!(error instanceof FirestoreConflictError)) throw error;
        const existing = await this.client.runTransaction((transaction) =>
          this.group(transaction, groupId),
        );
        if (!existing) throw new FirebaseTransportError(409, 'Group creation conflicted');
        if (existing.ownerId !== uid) throw new FirebaseTransportError(403, 'Group access denied');
        return existing.revision === 0;
      });
    if (!created) return { id: groupId };

    return this.client.runTransaction(async (transaction) => {
      const existing = await this.group(transaction, groupId);
      if (!existing) throw new FirebaseTransportError(404, 'Group disappeared during creation');
      if (existing.ownerId !== uid) throw new FirebaseTransportError(403, 'Group access denied');
      if (existing.revision > 0) return { id: groupId };
      return {
        id: groupId,
        ...(await this.append(
          transaction,
          existing,
          [
            { collection: 'households', id: groupId, baseVersion: 0, value: household as unknown as Record<string, unknown> },
            { collection: 'memberships', id: membership.id, baseVersion: 0, value: membership as unknown as Record<string, unknown> },
            ...members.map((member) => ({
              collection: 'members' as const,
              id: member.id,
              baseVersion: 0,
              value: member as unknown as Record<string, unknown>,
            })),
          ],
          now,
        )),
      };
    });
  }

  private async deltas(uid: string, groupId: string, since: number): Promise<unknown> {
    requireId(groupId);
    requireCondition(Number.isSafeInteger(since) && since >= 0, 'Invalid cursor');
    return this.client.runTransaction(async (transaction) => {
      this.requireAccess(await this.group(transaction, groupId), uid, true);
      const headers = await transaction.query(
        `groups/${groupId}/events`,
        [{ field: 'revision', op: '>', value: since }],
        { orderBy: 'revision', limit: 101 },
      );
      const events = [];
      for (const header of headers.slice(0, 100)) {
        const revision = Number(header.fields.revision ?? 0);
        requireCondition(Number.isSafeInteger(revision) && revision > since, 'Invalid event revision');
        const count = Number(header.fields.count ?? 0);
        requireCondition(Number.isInteger(count) && count > 0 && count <= 100, 'Invalid event count');
        const changes = await transaction.query(
          `groups/${groupId}/events/${revision}/changes`,
          [],
          { orderBy: 'index', limit: 100 },
        );
        requireCondition(changes.length === count, 'Incomplete event');
        events.push({
          revision,
          changes: changes.map((document) => ({
            collection: String(document.fields.collection ?? ''),
            id: String(document.fields.id ?? ''),
            version: Number(document.fields.version ?? 0),
            value: document.fields.value ?? null,
          })),
        });
      }
      return { events, hasMore: headers.length > 100 };
    });
  }

  private async mutate(uid: string, groupId: string, input: Record<string, unknown>): Promise<unknown> {
    requireId(groupId);
    const operationId = input.operationId;
    requireId(operationId);
    const rawChanges = input.changes;
    requireCondition(Array.isArray(rawChanges) && rawChanges.length > 0 && rawChanges.length <= 100, 'Invalid change batch');
    const changes = JSON.parse(JSON.stringify(rawChanges)) as ClientChange[];
    requireCondition(
      new Set(changes.map((change) => `${change.collection}:${change.id}`)).size === changes.length,
      'Duplicate record in batch',
    );
    return this.client.runTransaction(async (transaction) => {
      const group = this.requireAccess(await this.group(transaction, groupId), uid);
      const hash = await sha256(JSON.stringify(changes));
      const mutationPath = `groups/${groupId}/mutations/${operationId}`;
      const previous = await transaction.get(mutationPath);
      if (previous) {
        if (String(previous.fields.hash ?? '') !== hash) {
          throw new FirebaseTransportError(409, 'Operation ID reused with different data');
        }
        return previous.fields.response as unknown as MutationDoc['response'];
      }
      for (const change of changes) {
        await this.validateChange(transaction, group, uid, change, changes);
      }
      const result = await this.append(transaction, group, changes, this.now());
      transaction.set(mutationPath, {
        uid,
        hash,
        response: sanitize(result) as FirestoreValue,
        createdAt: new Date(this.now()).toISOString(),
      });
      return result;
    });
  }

  private async validateChange(
    transaction: FirestoreTransaction,
    group: GroupDoc,
    uid: string,
    change: ClientChange,
    pending: ClientChange[] = [],
  ): Promise<void> {
    requireId(change.id);
    requireCondition(WRITABLE.has(change.collection), 'Collection is not client-writable');
    requireCondition(Number.isSafeInteger(change.baseVersion) && change.baseVersion >= 0, 'Invalid base version');
    const groupId = group.id;
    const previous = await this.readRecord(transaction, groupId, change.collection, change.id);
    if ((previous?.version ?? 0) !== change.baseVersion || (previous && previous.value === null)) {
      throw new FirebaseTransportError(409, 'Revision conflict; local changes must be retained');
    }
    if (change.value === null) {
      if (
        change.collection === 'members' ||
        change.collection === 'households' ||
        change.collection === 'settlements'
      ) {
        throw new FirebaseTransportError(400, 'This record cannot be deleted through mutations');
      }
      return;
    }
    requireCondition(isRecord(change.value), 'Invalid record');
    const value = change.value;
    const householdRecord = change.collection === 'households';
    requireCondition(
      value.id === change.id && (householdRecord ? value.id === groupId : value.householdId === groupId),
      'Cross-group payload denied',
    );
    requireCondition(JSON.stringify(value).length <= MAX_RECORD_BYTES, 'Record too large');
    const membership = group.access[uid];
    // Validate references against the final atomic batch. Every staged record
    // still passes its own validation and optimistic-version check before any
    // write is appended; reading old versions above must remain authoritative.
    const related = async (collection: string, id: string): Promise<Record<string, unknown> | null> => {
      const staged = pending.find(item => item.collection === collection && item.id === id);
      return staged ? staged.value : (await this.readRecord(transaction, groupId, collection, id))?.value ?? null;
    };
    const member = async (memberId: unknown) => {
      requireId(memberId);
      requireCondition(Boolean(await related('members', memberId)), 'Unknown group member');
    };
    const participants = async (values: unknown) => {
      requireCondition(
        Array.isArray(values) && values.length > 0 && new Set(values).size === values.length,
        'Invalid participants',
      );
      for (const participant of values) await member(participant);
    };
    if (value.categoryId) {
      requireCondition(Boolean(await related('categories', String(value.categoryId))), 'Unknown category');
    }
    if (value.note !== undefined) {
      requireCondition(typeof value.note === 'string' && value.note.length <= 10_000, 'Invalid note');
    }
    if (value.attachments !== undefined) {
      requireCondition(Array.isArray(value.attachments) && value.attachments.length <= 10, 'Invalid attachments');
      const sanitizedAttachments: Array<Record<string, unknown>> = [];
      for (const attachment of value.attachments) {
        requireCondition(isRecord(attachment), 'Invalid attachment');
        requireCondition(attachment.kind === 'photo', 'Unsupported attachment kind');
        requireId(attachment.id);
        requireId(attachment.remoteRef);
        const stored = await transaction.get(`groups/${groupId}/media/${attachment.remoteRef}`);
        requireCondition(Boolean(stored), 'Private media must be uploaded before attachment sync');
        const mimeType = String(stored?.fields.mimeType ?? '');
        const byteSize = Number(stored?.fields.byteSize ?? 0);
        if (attachment.mimeType !== undefined) {
          requireCondition(attachment.mimeType === mimeType, 'Media type mismatch');
        }
        if (attachment.byteSize !== undefined) {
          requireCondition(attachment.byteSize === byteSize, 'Media size mismatch');
        }
        sanitizedAttachments.push({
          id: attachment.id,
          kind: 'photo',
          ref: `media:${attachment.remoteRef}`,
          remoteRef: attachment.remoteRef,
          mimeType,
          byteSize,
          createdAt: typeof attachment.createdAt === 'string' ? attachment.createdAt : String(stored?.fields.createdAt ?? ''),
        });
        if (Number.isInteger(attachment.width) && Number(attachment.width) >= 0) {
          sanitizedAttachments[sanitizedAttachments.length - 1].width = Number(attachment.width);
        }
        if (Number.isInteger(attachment.height) && Number(attachment.height) >= 0) {
          sanitizedAttachments[sanitizedAttachments.length - 1].height = Number(attachment.height);
        }
      }
      value.attachments = sanitizedAttachments;
    }
    if (change.collection === 'households') {
      requireCondition(membership.role === 'OWNER', 'Only the group owner can change group settings');
      requireCondition(Boolean(previous?.value), 'Group must be created through the group endpoint');
      const before = previous!.value as unknown as Household;
      requireText(value.name, 100);
      requireCondition(value.contributionUnit === 'minutes' || value.contributionUnit === 'points', 'Invalid task unit');
      requireCondition(typeof value.crossLedgerCompensationEnabled === 'boolean', 'Invalid compensation setting');
      if (value.contributionToMoneyRate !== null) {
        const rate = value.contributionToMoneyRate;
        requireCondition(isRecord(rate), 'Invalid compensation rate');
        requireCondition(Number.isFinite(rate.contributionValue) && Number(rate.contributionValue) > 0, 'Invalid rate contribution value');
        requireCondition(rate.contributionUnit === 'minutes' || rate.contributionUnit === 'points', 'Invalid rate unit');
        requireCondition(Number.isSafeInteger(rate.moneyAmountMinor) && Number(rate.moneyAmountMinor) > 0, 'Invalid rate money amount');
        requireCondition(typeof rate.currency === 'string' && /^[A-Z]{3}$/.test(rate.currency), 'Invalid rate currency');
      } else {
        requireCondition(!value.crossLedgerCompensationEnabled, 'A compensation rate is required');
      }
      value.ownerId = before.ownerId;
      value.createdAt = before.createdAt;
      return;
    }
    if (change.collection === 'members') {
      requireText(value.name, 60);
      if (previous?.value) {
        const before = previous.value as unknown as Member;
        value.userId = before.userId ?? null;
        value.joinedAt = before.joinedAt;
      } else {
        requireCondition(value.userId === null || value.userId === undefined, 'Accounts are linked only through invitations');
        value.userId = null;
        value.joinedAt = new Date(this.now()).toISOString();
      }
      return;
    }
    if (change.collection === 'settlements') {
      requireCondition(!previous?.value, 'Settlements are immutable');
      const household = group.household;
      requireCondition(household.crossLedgerCompensationEnabled === true, 'Compensation is not enabled');
      const rate = household.contributionToMoneyRate;
      if (!rate) throw new FirebaseTransportError(400, 'A compensation rate is required');
      requireCondition(value.contributionUnit === household.contributionUnit, 'Settlement unit does not match the group unit');
      await member(value.contributionCreditorMemberId);
      await member(value.counterpartyMemberId);
      requireCondition(value.contributionCreditorMemberId !== value.counterpartyMemberId, 'Settlement members must differ');
      requireCondition(Number.isFinite(value.contributionValue) && Number(value.contributionValue) > 0, 'Invalid settlement contribution value');
      requireCondition(Number.isSafeInteger(value.moneyAmountMinor) && Number(value.moneyAmountMinor) > 0, 'Invalid settlement money amount');
      requireCondition(typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency), 'Invalid settlement currency');
      requireCondition(Number.isFinite(Date.parse(String(value.occurredAt))), 'Invalid settlement date');
      const snapshot = value.rateSnapshot;
      requireCondition(isRecord(snapshot), 'Invalid rate snapshot');
      requireCondition(
        snapshot.contributionValue === rate.contributionValue &&
          snapshot.contributionUnit === rate.contributionUnit &&
          snapshot.moneyAmountMinor === rate.moneyAmountMinor &&
          snapshot.currency === rate.currency,
        'Settlement rate changed; a new preview is required',
      );
      requireCondition(
        quoteCrossLedgerMoneyAmount(
          Number(value.contributionValue),
          value.contributionUnit as 'minutes' | 'points',
          snapshot as unknown as ContributionMoneyRate,
        ) === value.moneyAmountMinor,
        'Settlement amount does not match its rate snapshot',
      );
      const contributionRecords = await this.readCollection(transaction, groupId, 'contribution_entries');
      const expenseRecords = await this.readCollection(transaction, groupId, 'expense_entries');
      const settlementRecords = await this.readCollection(transaction, groupId, 'settlements');
      const members = (await this.readCollection(transaction, groupId, 'members')).map((record) => String(record.value?.id ?? record.id));
      const proposal = { ...value, id: change.id, householdId: groupId } as unknown as CrossLedgerSettlement;
      const preconditions = validateSettlementPreconditions(
        proposal,
        contributionRecords.map((record) => record.value) as unknown as ContributionEntry[],
        expenseRecords.map((record) => record.value) as unknown as ExpenseEntry[],
        members,
        settlementRecords.map((record) => record.value) as unknown as CrossLedgerSettlement[],
        true,
      );
      requireCondition(preconditions.valid, preconditions.errors[0] ?? 'Settlement rejected');
      value.createdBy = uid;
      delete value.modifiedBy;
      return;
    }
    if (change.collection === 'contribution_entries') {
      if (value.splitMode !== undefined) requireCondition(value.splitMode === 'equal' || value.splitMode === 'custom', 'Invalid task split');
      if (value.splitWeights) {
        requireCondition(Array.isArray(value.splitWeights), 'Invalid task weights');
        for (const weight of value.splitWeights as Array<Record<string, unknown>>) await member(weight.memberId);
      }
      requireText(value.label);
      await member(value.performedByMemberId);
      await participants(value.beneficiaryMemberIds);
      requireCondition(Number.isFinite(Date.parse(String(value.occurredAt))), 'Invalid date');
      requireCondition(value.unit === 'minutes' || value.unit === 'points', 'Invalid contribution unit');
      calculateContributionBalances([value as unknown as ContributionEntry], value.unit);
    } else if (change.collection === 'expense_entries') {
      requireCondition(value.splitMode === 'equal' || value.splitMode === 'custom', 'Invalid expense split');
      requireText(value.title);
      await member(value.paidByMemberId);
      await participants(value.participantMemberIds);
      requireCondition(Number.isFinite(Date.parse(String(value.occurredAt))), 'Invalid date');
      allocateExpense(value as unknown as ExpenseEntry);
    } else if (change.collection === 'todo_items') {
      if (previous?.value && (previous.value as unknown as TodoItem).status === 'completed') {
        throw new FirebaseTransportError(409, 'Completed todo cannot be reopened');
      }
      requireText(value.title);
      await participants(value.beneficiaryMemberIds);
      if (value.assigneeMemberId) await member(value.assigneeMemberId);
      requireCondition(value.status === 'todo' || value.status === 'completed', 'Invalid todo status');
      requireCondition(value.kind === 'task' || value.kind === 'expense', 'Invalid todo kind');
      if (value.status === 'completed') {
        const expected = `todo-${await sha256(change.id)}`;
        const contribution = await related('contribution_entries', expected);
        const expense = await related('expense_entries', expected);
        requireCondition(Boolean(contribution || expense), 'Use atomic completion endpoint');
        requireCondition(
          (value.kind === 'task' && Boolean(contribution)) ||
            (value.kind === 'expense' && Boolean(expense)),
          'Completion ledger mismatch',
        );
        requireCondition(Number.isFinite(Date.parse(String(value.completedAt))), 'Invalid completion date');
      }
    } else if (change.collection === 'categories') {
      requireText(value.name, 100);
      if (value.defaultTaskRatio) {
        requireCondition(Array.isArray(value.defaultTaskRatio), 'Invalid category ratio');
        const seen = new Set<string>();
        for (const weight of value.defaultTaskRatio as Array<Record<string, unknown>>) {
          await member(weight.memberId);
          const id = String(weight.memberId);
          requireCondition(
            !seen.has(id) && Number.isFinite(weight.weight) && Number(weight.weight) > 0,
            'Invalid category ratio',
          );
          seen.add(id);
        }
      }
    } else {
      requireText(value.name);
      requireCondition(Array.isArray(value.defaultBeneficiaryMemberIds), 'Invalid default beneficiaries');
      await participants(value.defaultBeneficiaryMemberIds);
      requireCondition(Number.isFinite(value.defaultValue) && Number(value.defaultValue) > 0, 'Invalid default value');
    }
    value.createdBy = previous?.value
      ? (previous.value as { createdBy?: string }).createdBy
      : uid;
    if (previous?.value) value.modifiedBy = uid;
  }

  private async createInvite(uid: string, groupId: string, memberId: string): Promise<unknown> {
    requireId(groupId);
    requireId(memberId);
    const token = await this.createToken();
    requireCondition(/^[A-Za-z0-9_-]{43}$/.test(token), 'Invalid invitation token');
    const hash = await sha256(token);
    const expiresAt = this.now() + SESSION_MS;
    return this.client.runTransaction(async (transaction) => {
      const group = this.requireAccess(await this.group(transaction, groupId), uid);
      if (group.access[uid].role !== 'OWNER') {
        throw new FirebaseTransportError(403, 'Group access denied');
      }
      const member = await this.readRecord(transaction, groupId, 'members', memberId);
      requireCondition(Boolean(member?.value) && !(member!.value as unknown as Member).userId, 'Only an unlinked named member can be invited');
      transaction.set(`groups/${groupId}/invites/${hash}`, {
        groupId,
        memberId,
        expiresAt,
        acceptedBy: null,
        revoked: false,
        createdAt: new Date(this.now()).toISOString(),
      });
      transaction.set(`inviteLinks/${hash}`, { groupId });
      return { token, expiresAt: new Date(expiresAt).toISOString(), memberId };
    });
  }

  private async revokeInvite(uid: string, groupId: string, token: string): Promise<unknown> {
    requireId(groupId);
    requireCondition(/^[A-Za-z0-9_-]{43}$/.test(token), 'Invalid invitation');
    const hash = await sha256(token);
    return this.client.runTransaction(async (transaction) => {
      const group = this.requireAccess(await this.group(transaction, groupId), uid);
      if (group.access[uid].role !== 'OWNER') {
        throw new FirebaseTransportError(403, 'Group access denied');
      }
      const invitation = await transaction.get(`groups/${groupId}/invites/${hash}`);
      if (!invitation) throw new FirebaseTransportError(404, 'Invitation unavailable');
      transaction.set(
        `groups/${groupId}/invites/${hash}`,
        { ...invitation.fields, revoked: true },
        { exists: true },
      );
      return { revoked: true };
    });
  }

  private async acceptInvite(uid: string, token: string): Promise<unknown> {
    requireCondition(/^[A-Za-z0-9_-]{43}$/.test(token), 'Invalid invitation');
    const hash = await sha256(token);
    const link = await this.client.getDocument(`inviteLinks/${hash}`);
    const groupId = fieldString(link, 'groupId');
    if (!groupId) throw new FirebaseTransportError(404, 'Invitation unavailable');
    requireId(groupId);
    const joinRequestPath = `joinRequests/${groupId}_${uid}`;

    // Step 1: prove possession of the secret invitation token and publish a
    // short-lived join request. Security rules only need to validate this one
    // document; they never expose a group to unauthenticated guessing.
    await this.client.runTransaction(async (transaction) => {
      const invitation = await transaction.get(`groups/${groupId}/invites/${hash}`);
      if (!invitation) throw new FirebaseTransportError(404, 'Invitation unavailable');
      if (invitation.fields.revoked === true) throw new FirebaseTransportError(404, 'Invitation unavailable');
      if (Number(invitation.fields.expiresAt ?? 0) <= this.now()) throw new FirebaseTransportError(404, 'Invitation unavailable');
      const acceptedBy = fieldString(invitation, 'acceptedBy');
      if (acceptedBy && acceptedBy !== uid) throw new FirebaseTransportError(409, 'Invitation already used');
      transaction.set(joinRequestPath, {
        uid,
        groupId,
        inviteHash: hash,
        createdAt: new Date(this.now()).toISOString(),
      });
    });

    try {
      return await this.client.runTransaction(async (transaction) => {
        const invitation = await transaction.get(`groups/${groupId}/invites/${hash}`);
        if (!invitation) throw new FirebaseTransportError(404, 'Invitation unavailable');
        const acceptedBy = fieldString(invitation, 'acceptedBy');
        const host = await this.group(transaction, groupId);
        if (!host) throw new FirebaseTransportError(404, 'Groupe introuvable');
        const memberId = String(invitation.fields.memberId ?? '');
        requireId(memberId);
        if (acceptedBy === uid) {
          return { groupId, memberId: host.access[uid]?.memberId ?? memberId };
        }
        if (invitation.fields.revoked === true) throw new FirebaseTransportError(404, 'Invitation unavailable');
        if (Number(invitation.fields.expiresAt ?? 0) <= this.now()) throw new FirebaseTransportError(404, 'Invitation unavailable');
        if (acceptedBy) throw new FirebaseTransportError(409, 'Invitation already used');
        // The link grants admission to that group, so the accepting account
        // does not need prior membership. It must not have another identity.
        if (host.access[uid] && host.access[uid].memberId !== memberId) {
          throw new FirebaseTransportError(409, 'Account already has a distinct member in this group');
        }
        const member = await this.readRecord(transaction, groupId, 'members', memberId);
        if (!member?.value || (member.value as unknown as Member).userId) {
          throw new FirebaseTransportError(409, 'Member already linked');
        }
        const membership: Membership = {
          id: this.createId(),
          householdId: groupId,
          userId: uid,
          role: 'MEMBER',
          joinedAt: new Date(this.now()).toISOString(),
        };
        host.memberUids = Array.from(new Set([...host.memberUids, uid]));
        host.access[uid] = { memberId, role: 'MEMBER', inviteHash: hash } as AccessEntry;
        transaction.set(
          `groups/${groupId}/invites/${hash}`,
          { ...invitation.fields, acceptedBy: uid },
          { exists: true },
        );
        transaction.delete(joinRequestPath);
        const updatedMember = { ...(member.value as unknown as Member), userId: uid };
        return this.append(
          transaction,
          host,
          [
            { collection: 'members', id: memberId, baseVersion: member.version, value: updatedMember as unknown as Record<string, unknown> },
            { collection: 'memberships', id: membership.id, baseVersion: 0, value: membership as unknown as Record<string, unknown> },
          ],
          this.now(),
        ).then((result) => ({ groupId, memberId, ...result }));
      });
    } catch (error) {
      await this.client.runTransaction(async (transaction) => {
        const request = await transaction.get(joinRequestPath);
        if (request) transaction.delete(joinRequestPath);
      }).catch(() => undefined);
      throw error;
    }
  }

  private async deleteGroup(uid: string, groupId: string): Promise<unknown> {
    requireId(groupId);
    return this.client.runTransaction(async (transaction) => {
      const group = await this.group(transaction, groupId);
      if (!group) throw new FirebaseTransportError(404, 'Groupe introuvable');
      if (group.ownerId !== uid) throw new FirebaseTransportError(403, 'Group access denied');
      if (group.deleted === true) return { id: groupId, deleted: true };
      group.deleted = true;
      const result = await this.append(
        transaction,
        group,
        [{ collection: 'households', id: groupId, baseVersion: 0, value: null }],
        this.now(),
      );
      return { id: groupId, deleted: true, ...result };
    });
  }

  private async completeTodo(uid: string, groupId: string, todoId: string, input: Record<string, unknown>): Promise<unknown> {
    requireId(groupId);
    requireId(todoId);
    return this.client.runTransaction(async (transaction) => {
      const group = this.requireAccess(await this.group(transaction, groupId), uid);
      const todoRecord = await this.readRecord(transaction, groupId, 'todo_items', todoId);
      if (!todoRecord?.value) throw new FirebaseTransportError(404, 'Todo not found');
      const todo = todoRecord.value as unknown as TodoItem;
      if (todo.status === 'completed') throw new FirebaseTransportError(409, 'Todo already completed');
      const category = todo.categoryId
        ? (await this.readRecord(transaction, groupId, 'categories', todo.categoryId))?.value
        : null;
      const result = planTodoCompletion({
        ...input,
        todo,
        household: group.household,
        completedByUserId: uid,
        category,
      } as CompletionInput | ExpenseCompletionInput);
      const entry =
        result.kind === 'expense' ? result.expenseEntry : result.contributionEntry;
      const record: ClientChange & { value: Record<string, unknown> } = {
        collection: result.kind === 'expense' ? 'expense_entries' : 'contribution_entries',
        id: await todoCompletionEntryId(todoId),
        baseVersion: 0,
        value: { ...entry, id: await todoCompletionEntryId(todoId) } as unknown as Record<string, unknown>,
      };
      await this.validateChange(transaction, group, uid, record);
      return this.append(
        transaction,
        group,
        [
          record,
          {
            collection: 'todo_items',
            id: todoId,
            baseVersion: todoRecord.version,
            value: { ...todo, ...result.updatedTodo } as unknown as Record<string, unknown>,
          },
        ],
        this.now(),
      );
    });
  }
}
