import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HttpError } from './auth';
import { calculateContributionBalances } from '../src/domain/calculations/contributionLedger';
import { allocateExpense } from '../src/domain/calculations/expenseLedger';
import { CompletionInput, ExpenseCompletionInput, planTodoCompletion } from '../src/domain/services/todoCompletionService';
import { ContributionEntry, CrossLedgerSettlement, ExpenseEntry, Household, TodoItem } from '../src/domain/entities';
import { quoteCrossLedgerMoneyAmount } from '../src/domain/calculations/crossLedgerSettlement';
import { validateSettlementPreconditions } from '../src/domain/calculations/settlementPreconditions';

type Row = Record<string, any>;
export interface Change { collection: string; id: string; baseVersion: number; value: Row | null; }
const editable = new Set(['contribution_entries','expense_entries','todo_items','persistent_tasks','categories','members','households','settlements']);
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new HttpError(400, message);
}
function id(value: unknown): asserts value is string { requireValue(typeof value === 'string' && idPattern.test(value), 'Invalid identifier'); }
function text(value: unknown, max = 200) { requireValue(typeof value === 'string' && value.trim() && value.length <= max, 'Invalid text'); }
function digest(value: string) { return createHash('sha256').update(value).digest('hex'); }

/** Single authoritative writer on a persistent SQLite volume. Accounting uses
 * the same pure domain rules as the app; no balances are accepted from clients. */
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MEDIA_GRACE_MS = 24 * 60 * 60 * 1000;

export class CollaborationStore {
  readonly database: DatabaseSync;
  readonly mediaDirectory: string;
  private readonly now: () => number;
  constructor(
    path: string,
    mediaDirectory = join(dirname(path), 'media'),
    now: () => number = Date.now,
  ) {
    this.mediaDirectory = mediaDirectory;
    this.now = now;
    this.database = new DatabaseSync(path);
    this.database.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY, owner TEXT NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS access(groupId TEXT NOT NULL, uid TEXT NOT NULL, memberId TEXT NOT NULL UNIQUE, role TEXT NOT NULL, PRIMARY KEY(groupId,uid));
      CREATE TABLE IF NOT EXISTS records(groupId TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, value TEXT, PRIMARY KEY(collection,id));
      CREATE INDEX IF NOT EXISTS records_group ON records(groupId,collection);
      CREATE TABLE IF NOT EXISTS events(groupId TEXT NOT NULL, revision INTEGER NOT NULL, changes TEXT NOT NULL, PRIMARY KEY(groupId,revision));
      CREATE TABLE IF NOT EXISTS mutations(groupId TEXT NOT NULL, uid TEXT NOT NULL, id TEXT NOT NULL, hash TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(groupId,uid,id));
      CREATE TABLE IF NOT EXISTS invites(hash TEXT PRIMARY KEY, groupId TEXT NOT NULL, memberId TEXT NOT NULL, expires INTEGER NOT NULL, acceptedBy TEXT, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS media(groupId TEXT NOT NULL, id TEXT NOT NULL, mimeType TEXT NOT NULL, byteSize INTEGER NOT NULL, sha256 TEXT NOT NULL, createdAt INTEGER NOT NULL, uploadedBy TEXT NOT NULL, PRIMARY KEY(groupId,id));
      CREATE INDEX IF NOT EXISTS media_group ON media(groupId,createdAt);
      CREATE TABLE IF NOT EXISTS media_refs(groupId TEXT NOT NULL, mediaId TEXT NOT NULL, collection TEXT NOT NULL, entityId TEXT NOT NULL, PRIMARY KEY(groupId,mediaId,collection,entityId));
      CREATE INDEX IF NOT EXISTS media_refs_media ON media_refs(groupId,mediaId);
    `);
  }
  close() { this.database.close(); }
  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.database.exec('COMMIT'); return result; }
    catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  private access(groupId: string, uid: string, owner = false): Row {
    const membership = this.database.prepare('SELECT * FROM access WHERE groupId=? AND uid=?').get(groupId,uid) as Row | undefined;
    if (!membership || (owner && membership.role !== 'OWNER')) throw new HttpError(403,'Group access denied');
    return membership;
  }
  private record(groupId: string, collection: string, entityId: string): Row | undefined {
    const record = this.database.prepare('SELECT * FROM records WHERE collection=? AND id=?').get(collection,entityId) as Row | undefined;
    if (record && record.groupId !== groupId) throw new HttpError(409,'Identifier already used');
    return record;
  }
  private value(groupId: string, collection: string, entityId: string): Row | null {
    const row = this.record(groupId,collection,entityId);
    return row?.value ? JSON.parse(row.value) : null;
  }
  private values(groupId: string, collection: string): Row[] {
    return (this.database.prepare('SELECT value FROM records WHERE groupId=? AND collection=? AND value IS NOT NULL')
      .all(groupId,collection) as Row[]).map(row => JSON.parse(row.value));
  }
  private append(groupId: string, changes: Array<Omit<Change,'baseVersion'>>) {
    const group = this.database.prepare('UPDATE groups SET revision=revision+1 WHERE id=? RETURNING revision').get(groupId) as Row;
    const revision = group.revision as number;
    const applied = changes.map(change => {
      const version = (this.record(groupId,change.collection,change.id)?.version ?? 0) + 1;
      this.database.prepare(`INSERT INTO records(groupId,collection,id,version,value) VALUES(?,?,?,?,?)
        ON CONFLICT(collection,id) DO UPDATE SET version=excluded.version,value=excluded.value`).run(
          groupId,change.collection,change.id,version,change.value ? JSON.stringify(change.value) : null);
      this.trackMediaRefs(groupId,change.collection,change.id,change.value);
      return { ...change, version };
    });
    this.database.prepare('INSERT INTO events VALUES(?,?,?)').run(groupId,revision,JSON.stringify(applied));
    return { revision, changes: applied };
  }
  /**
   * Maintain a bounded reference index for private media. A scan of the whole
   * ledger would be a full-history cost; only the changed entry is re-indexed.
   */
  private trackMediaRefs(groupId: string, collection: string, entityId: string, value: Row | null) {
    if (collection !== 'contribution_entries' && collection !== 'expense_entries') return;
    this.database.prepare('DELETE FROM media_refs WHERE groupId=? AND collection=? AND entityId=?')
      .run(groupId,collection,entityId);
    const attachments = value && Array.isArray(value.attachments) ? value.attachments : [];
    for (const attachment of attachments) {
      const mediaId = attachment && typeof attachment.remoteRef === 'string' ? attachment.remoteRef : null;
      if (!mediaId) continue;
      this.database.prepare('INSERT OR IGNORE INTO media_refs VALUES(?,?,?,?)')
        .run(groupId,mediaId,collection,entityId);
    }
  }
  private mediaPath(groupId: string, mediaId: string): string {
    id(groupId); id(mediaId);
    return join(this.mediaDirectory,groupId,mediaId);
  }
  putMedia(uid: string, groupId: string, mediaId: string, mimeType: string, bytes: Buffer) {
    id(groupId); id(mediaId);
    this.access(groupId,uid);
    requireValue(typeof mimeType === 'string' && /^image\/(jpeg|png|webp|heic|heif|gif)$/.test(mimeType),'Unsupported media type');
    requireValue(bytes.length > 0 && bytes.length <= MAX_MEDIA_BYTES,'Invalid media size');
    // Reject a renamed executable/text file that merely claims an image type.
    const signature = bytes.subarray(0,12);
    const isImage = (signature[0]===0xff && signature[1]===0xd8) ||
      (signature.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) ||
      signature.subarray(0,4).toString('ascii') === 'RIFF' ||
      signature.subarray(4,8).toString('ascii') === 'ftyp' ||
      signature.subarray(0,4).toString('ascii') === 'GIF8';
    requireValue(isImage,'Invalid image payload');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const existing = this.database.prepare('SELECT * FROM media WHERE groupId=? AND id=?').get(groupId,mediaId) as Row | undefined;
    if (existing) {
      if (existing.sha256 !== sha256) throw new HttpError(409,'Media identifier already used with different content');
      return { id:mediaId,mimeType:existing.mimeType,byteSize:existing.byteSize,sha256,createdAt:new Date(existing.createdAt).toISOString() };
    }
    const directory = join(this.mediaDirectory,groupId);
    mkdirSync(directory,{recursive:true});
    const destination = this.mediaPath(groupId,mediaId);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    writeFileSync(temporary,bytes,{mode:0o600});
    renameSync(temporary,destination);
    try {
      const createdAt = this.now();
      this.database.prepare('INSERT INTO media VALUES(?,?,?,?,?,?,?)')
        .run(groupId,mediaId,mimeType,bytes.length,sha256,createdAt,uid);
      return { id:mediaId,mimeType,byteSize:bytes.length,sha256,createdAt:new Date(createdAt).toISOString() };
    } catch (error) {
      rmSync(destination,{force:true});
      throw error;
    }
  }
  getMedia(uid: string, groupId: string, mediaId: string) {
    id(groupId); id(mediaId);
    this.access(groupId,uid);
    const row = this.database.prepare('SELECT * FROM media WHERE groupId=? AND id=?').get(groupId,mediaId) as Row | undefined;
    const path = this.mediaPath(groupId,mediaId);
    if (!row || !existsSync(path)) throw new HttpError(404,'Media not found');
    const bytes = readFileSync(path);
    if (bytes.length !== row.byteSize || createHash('sha256').update(bytes).digest('hex') !== row.sha256) {
      throw new HttpError(500,'Media integrity check failed');
    }
    return { mimeType:row.mimeType as string, bytes };
  }
  deleteMedia(uid: string, groupId: string, mediaId: string) {
    id(groupId); id(mediaId);
    this.access(groupId,uid);
    const references = this.database.prepare('SELECT COUNT(*) AS count FROM media_refs WHERE groupId=? AND mediaId=?').get(groupId,mediaId) as Row;
    if (references.count > 0) throw new HttpError(409,'Media is still referenced by an entry');
    this.database.prepare('DELETE FROM media WHERE groupId=? AND id=?').run(groupId,mediaId);
    rmSync(this.mediaPath(groupId,mediaId),{force:true});
    return { deleted:true };
  }
  /** Remove private media that no current entry references after a grace period.
   *
   * The comparison is inclusive so an upload and a maintenance pass in the same
   * millisecond are deterministic: grace 0 means "eligible now". The clock is
   * injectable for boundary tests instead of relying on sleeps.
   */
  collectMediaGarbage(graceMs = MEDIA_GRACE_MS) {
    const cutoff = this.now() - Math.max(0,graceMs);
    const rows = this.database.prepare(`SELECT groupId,id FROM media m WHERE createdAt <= ?
      AND NOT EXISTS (SELECT 1 FROM media_refs r WHERE r.groupId=m.groupId AND r.mediaId=m.id) LIMIT 100`).all(cutoff) as Row[];
    for (const row of rows) {
      this.database.prepare('DELETE FROM media WHERE groupId=? AND id=?').run(row.groupId,row.id);
      rmSync(this.mediaPath(row.groupId,row.id),{force:true});
    }
    return { removed:rows.length };
  }
  createGroup(uid: string, input: Row) {
    id(input.id); id(input.ownerMemberId); text(input.name);
    requireValue(['minutes','points'].includes(input.unit), 'Invalid task unit');
    requireValue(Array.isArray(input.members) && input.members.length <= 200, 'Invalid members');
    if (input.membershipId !== undefined) id(input.membershipId);
    const memberIds = new Set([input.ownerMemberId]);
    for (const member of input.members) { id(member.id); text(member.name,60); requireValue(!memberIds.has(member.id),'Duplicate member'); memberIds.add(member.id); }
    text(input.ownerName,60);
    return this.transaction(() => {
      const existing = this.database.prepare('SELECT owner FROM groups WHERE id=?').get(input.id) as Row | undefined;
      if (existing) { if (existing.owner !== uid) throw new HttpError(403,'Group access denied'); return { id:input.id }; }
      const now = new Date().toISOString();
      const household: Household = { id:input.id, name:input.name.trim(), ownerId:uid,
        contributionUnit:input.unit, crossLedgerCompensationEnabled:false, contributionToMoneyRate:null, createdAt:now };
      this.database.prepare('INSERT INTO groups VALUES(?,?,0,?)').run(input.id,uid,JSON.stringify(household));
      this.database.prepare('INSERT INTO access VALUES(?,?,?,?)').run(input.id,uid,input.ownerMemberId,'OWNER');
      const members = [{ id:input.ownerMemberId,name:input.ownerName,userId:uid }, ...input.members.map((m: Row) => ({id:m.id,name:m.name,userId:null}))];
      const membership = { id:input.membershipId ?? randomUUID(), householdId:input.id, userId:uid, role:'OWNER', joinedAt:now };
      return this.append(input.id,[{collection:'households',id:input.id,value:household},
        {collection:'memberships',id:membership.id,value:membership},
        ...members.map(member => ({collection:'members',id:member.id,value:{...member,householdId:input.id,joinedAt:now}}))]);
    });
  }
  listGroups(uid: string) {
    return this.database.prepare(`SELECT g.id,g.value,g.revision,a.memberId,a.role FROM access a JOIN groups g ON g.id=a.groupId WHERE a.uid=?`).all(uid)
      .map((row: any) => ({ household:JSON.parse(row.value), revision:row.revision, memberId:row.memberId, role:row.role }));
  }
  deltas(uid: string, groupId: string, since: number) {
    this.access(groupId,uid);
    requireValue(Number.isSafeInteger(since) && since >= 0,'Invalid cursor');
    const rows = this.database.prepare('SELECT revision,changes FROM events WHERE groupId=? AND revision>? ORDER BY revision LIMIT 101').all(groupId,since) as Row[];
    return { events:rows.slice(0,100).map(row => ({revision:row.revision,changes:JSON.parse(row.changes)})), hasMore:rows.length > 100 };
  }
  private validate(groupId: string, uid: string, role: string, change: Change) {
    id(change.id); requireValue(editable.has(change.collection),'Collection is not client-writable');
    requireValue(Number.isSafeInteger(change.baseVersion) && change.baseVersion >= 0,'Invalid base version');
    const previous = this.record(groupId,change.collection,change.id);
    if ((previous?.version ?? 0) !== change.baseVersion || (previous && previous.value === null)) throw new HttpError(409,'Revision conflict; local changes must be retained');
    if (change.value === null) {
      // Group/member removal changes membership and needs a dedicated,
      // auditable operation; the generic editor must not orphan history.
      if (change.collection === 'members' || change.collection === 'households' ||
          change.collection === 'settlements') {
        throw new HttpError(400,'This record cannot be deleted through mutations');
      }
      return;
    }
    const value = change.value;
    requireValue(value && typeof value === 'object' && !Array.isArray(value),'Invalid record');
    const householdRecord = change.collection === 'households';
    requireValue(
      value.id === change.id &&
        (householdRecord ? value.id === groupId : value.householdId === groupId),
      'Cross-group payload denied',
    );
    requireValue(JSON.stringify(value).length <= 65536,'Record too large');
    const member = (memberId: unknown) => { id(memberId); requireValue(this.value(groupId,'members',memberId),'Unknown group member'); };
    const participants = (values: unknown) => {
      requireValue(Array.isArray(values) && values.length > 0 && new Set(values).size === values.length,'Invalid participants');
      for (const value of values) member(value);
    };
    if (value.categoryId) requireValue(this.value(groupId,'categories',value.categoryId),'Unknown category');
    if (value.note !== undefined) requireValue(typeof value.note === 'string' && value.note.length <= 10000,'Invalid note');
    if (value.attachments !== undefined) {
      requireValue(Array.isArray(value.attachments) && value.attachments.length <= 10,'Invalid attachments');
      value.attachments = value.attachments.map((attachment: Row) => {
        requireValue(attachment && typeof attachment === 'object' && !Array.isArray(attachment),'Invalid attachment');
        requireValue(attachment.kind === 'photo','Unsupported attachment kind');
        id(attachment.id); id(attachment.remoteRef);
        const stored = this.database.prepare('SELECT * FROM media WHERE groupId=? AND id=?')
          .get(groupId,attachment.remoteRef) as Row | undefined;
        // Media must be uploaded first, under this exact group, so a client can
        // never reference another tenant's private file.
        requireValue(stored,'Private media must be uploaded before attachment sync');
        if (attachment.mimeType !== undefined) requireValue(attachment.mimeType === stored.mimeType,'Media type mismatch');
        if (attachment.byteSize !== undefined) requireValue(attachment.byteSize === stored.byteSize,'Media size mismatch');
        const sanitized: Row = {
          id:attachment.id,
          kind:'photo',
          ref:`media:${stored.id}`,
          remoteRef:stored.id,
          mimeType:stored.mimeType,
          byteSize:stored.byteSize,
          createdAt:typeof attachment.createdAt === 'string' ? attachment.createdAt : new Date(stored.createdAt).toISOString(),
        };
        if (Number.isInteger(attachment.width) && attachment.width >= 0) sanitized.width = attachment.width;
        if (Number.isInteger(attachment.height) && attachment.height >= 0) sanitized.height = attachment.height;
        return sanitized;
      });
    }
    if (change.collection === 'households') {
      // Group-wide settings are owner-only. Identity, tenancy and creation
      // provenance are authority-owned and can never be rewritten by a client.
      requireValue(role === 'OWNER','Only the group owner can change group settings');
      requireValue(previous?.value,'Group must be created through the group endpoint');
      const before = JSON.parse(previous.value);
      text(value.name,100);
      requireValue(value.contributionUnit === 'minutes' || value.contributionUnit === 'points','Invalid task unit');
      requireValue(typeof value.crossLedgerCompensationEnabled === 'boolean','Invalid compensation setting');
      if (value.contributionToMoneyRate !== null) {
        const rate = value.contributionToMoneyRate;
        requireValue(rate && typeof rate === 'object' && !Array.isArray(rate),'Invalid compensation rate');
        requireValue(Number.isFinite(rate.contributionValue) && rate.contributionValue > 0,'Invalid rate contribution value');
        requireValue(rate.contributionUnit === 'minutes' || rate.contributionUnit === 'points','Invalid rate unit');
        requireValue(Number.isSafeInteger(rate.moneyAmountMinor) && rate.moneyAmountMinor > 0,'Invalid rate money amount');
        requireValue(typeof rate.currency === 'string' && /^[A-Z]{3}$/.test(rate.currency),'Invalid rate currency');
      } else {
        requireValue(!value.crossLedgerCompensationEnabled,'A compensation rate is required');
      }
      value.ownerId = before.ownerId;
      value.createdAt = before.createdAt;
      return;
    }
    if (change.collection === 'members') {
      text(value.name,60);
      if (previous?.value) {
        // Renaming a named member keeps its identity. Linked accounts and
        // join history are only changed by the invitation authority.
        const before = JSON.parse(previous.value);
        value.userId = before.userId ?? null;
        value.joinedAt = before.joinedAt;
      } else {
        requireValue(value.userId === null || value.userId === undefined,'Accounts are linked only through invitations');
        value.userId = null;
        value.joinedAt = new Date().toISOString();
      }
      return;
    }
    if (change.collection === 'settlements') {
      // Compensation is a closed, auditable accounting operation: the server
      // validates it against the authoritative household rate and both ledgers.
      // It is never an arbitrary client-supplied balance mutation and it can
      // never be deleted or rewritten through the generic editor.
      requireValue(previous?.value === undefined || previous?.value === null,'Settlements are immutable');
      const household = this.value(groupId,'households',groupId) as Household | null;
      requireValue(household?.crossLedgerCompensationEnabled === true,'Compensation is not enabled');
      const rate = household?.contributionToMoneyRate;
      if (!rate) throw new HttpError(400,'A compensation rate is required');
      requireValue(value.contributionUnit === household.contributionUnit,'Settlement unit does not match the group unit');
      member(value.contributionCreditorMemberId); member(value.counterpartyMemberId);
      requireValue(value.contributionCreditorMemberId !== value.counterpartyMemberId,'Settlement members must differ');
      requireValue(Number.isFinite(value.contributionValue) && value.contributionValue > 0,'Invalid settlement contribution value');
      requireValue(Number.isSafeInteger(value.moneyAmountMinor) && value.moneyAmountMinor > 0,'Invalid settlement money amount');
      requireValue(typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency),'Invalid settlement currency');
      requireValue(Number.isFinite(Date.parse(value.occurredAt)),'Invalid settlement date');
      const snapshot = value.rateSnapshot;
      requireValue(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot),'Invalid rate snapshot');
      requireValue(
        snapshot.contributionValue === rate.contributionValue &&
        snapshot.contributionUnit === rate.contributionUnit &&
        snapshot.moneyAmountMinor === rate.moneyAmountMinor &&
        snapshot.currency === rate.currency,
        'Settlement rate changed; a new preview is required',
      );
      requireValue(
        quoteCrossLedgerMoneyAmount(value.contributionValue,value.contributionUnit,snapshot) === value.moneyAmountMinor,
        'Settlement amount does not match its rate snapshot',
      );
      const members = this.values(groupId,'members').map(item => item.id);
      const proposal = {...value,id:change.id,householdId:groupId} as CrossLedgerSettlement;
      const preconditions = validateSettlementPreconditions(
        proposal,
        this.values(groupId,'contribution_entries') as ContributionEntry[],
        this.values(groupId,'expense_entries') as ExpenseEntry[],
        members,
        this.values(groupId,'settlements') as CrossLedgerSettlement[],
        true,
      );
      requireValue(preconditions.valid,preconditions.errors[0] ?? 'Settlement rejected');
      // Immutable audit fields are owned by the authority.
      value.createdBy = uid;
      delete value.modifiedBy;
      return;
    }
    if (change.collection === 'contribution_entries') {
      if (value.splitMode !== undefined) requireValue(['equal','custom'].includes(value.splitMode),'Invalid task split');
      if (value.splitWeights) { requireValue(Array.isArray(value.splitWeights),'Invalid task weights'); for (const weight of value.splitWeights) member(weight.memberId); }
      text(value.label); member(value.performedByMemberId); participants(value.beneficiaryMemberIds);
      requireValue(Number.isFinite(Date.parse(value.occurredAt)),'Invalid date');
      requireValue(value.unit === 'minutes' || value.unit === 'points','Invalid contribution unit');
      calculateContributionBalances([value as ContributionEntry],value.unit);
    } else if (change.collection === 'expense_entries') {
      requireValue(['equal','custom'].includes(value.splitMode),'Invalid expense split');
      text(value.title); member(value.paidByMemberId); participants(value.participantMemberIds);
      requireValue(Number.isFinite(Date.parse(value.occurredAt)),'Invalid date'); allocateExpense(value as ExpenseEntry);
    } else if (change.collection === 'todo_items') {
      if (previous?.value && JSON.parse(previous.value).status === 'completed') throw new HttpError(409,'Completed todo cannot be reopened');
      text(value.title); participants(value.beneficiaryMemberIds);
      if (value.assigneeMemberId) member(value.assigneeMemberId);
      requireValue(value.status === 'todo' || value.status === 'completed','Invalid todo status');
      requireValue(value.kind === 'task' || value.kind === 'expense','Invalid todo kind');
      if (value.status === 'completed') {
        // A completion is accepted only together with (or after) the
        // deterministic ledger entry written by the same atomic local
        // operation. Balances are never taken from the todo payload.
        const expected = `todo-${digest(change.id)}`;
        const contribution = this.value(groupId,'contribution_entries',expected);
        const expense = this.value(groupId,'expense_entries',expected);
        requireValue(Boolean(contribution || expense),'Use atomic completion endpoint');
        requireValue(
          (value.kind === 'task' && Boolean(contribution)) ||
            (value.kind === 'expense' && Boolean(expense)),
          'Completion ledger mismatch',
        );
        requireValue(Number.isFinite(Date.parse(value.completedAt)),'Invalid completion date');
      }
    } else if (change.collection === 'categories') {
      text(value.name,100);
      if (value.defaultTaskRatio) {
        requireValue(Array.isArray(value.defaultTaskRatio),'Invalid category ratio');
        const seen = new Set();
        for (const weight of value.defaultTaskRatio) { member(weight.memberId); requireValue(!seen.has(weight.memberId) && Number.isFinite(weight.weight) && weight.weight>0,'Invalid category ratio'); seen.add(weight.memberId); }
      }
    } else { text(value.name); participants(value.defaultBeneficiaryMemberIds); requireValue(Number.isFinite(value.defaultValue) && value.defaultValue>0,'Invalid default value'); }
    // Audit identity is authority-owned, never taken from a payload.
    value.createdBy = previous?.value ? JSON.parse(previous.value).createdBy : uid;
    if (previous?.value) value.modifiedBy = uid;
  }
  mutate(uid: string, groupId: string, operationId: string, changes: Change[]) {
    id(operationId); requireValue(Array.isArray(changes) && changes.length > 0 && changes.length <= 100,'Invalid change batch');
    const committed = this.transaction(() => {
      const membership = this.access(groupId,uid);
      const hash = digest(JSON.stringify(changes));
      changes = structuredClone(changes);
      const previous = this.database.prepare('SELECT hash,response FROM mutations WHERE groupId=? AND uid=? AND id=?').get(groupId,uid,operationId) as Row | undefined;
      if (previous) { if (previous.hash !== hash) throw new HttpError(409,'Operation ID reused with different data'); return JSON.parse(previous.response); }
      requireValue(new Set(changes.map(c => `${c.collection}:${c.id}`)).size === changes.length,'Duplicate record in batch');
      for (const change of changes) this.validate(groupId,uid,membership.role,change);
      const result = this.append(groupId,changes);
      this.database.prepare('INSERT INTO mutations VALUES(?,?,?,?,?)').run(groupId,uid,operationId,hash,JSON.stringify(result));
      return result;
    });
    try { this.collectMediaGarbage(); } catch { /* maintenance must not fail a committed write */ }
    return committed;
  }
  createInvite(uid: string, groupId: string, memberId: string) {
    id(memberId);
    return this.transaction(() => {
      this.access(groupId,uid,true);
      const member = this.value(groupId,'members',memberId);
      requireValue(member && !member.userId,'Only an unlinked named member can be invited');
      const token = randomBytes(32).toString('base64url');
      const expiresAt = Date.now() + 7*86400000;
      this.database.prepare('INSERT INTO invites(hash,groupId,memberId,expires) VALUES(?,?,?,?)').run(digest(token),groupId,memberId,expiresAt);
      return { token,expiresAt:new Date(expiresAt).toISOString(),memberId };
    });
  }
  revokeInvite(uid: string, groupId: string, token: string) {
    this.access(groupId,uid,true);
    requireValue(typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token),'Invalid invitation');
    this.database.prepare('UPDATE invites SET revoked=1 WHERE hash=? AND groupId=?').run(digest(token),groupId);
    return { revoked:true };
  }
  acceptInvite(uid: string, token: string) {
    requireValue(typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token),'Invalid invitation');
    return this.transaction(() => {
      const invitation = this.database.prepare('SELECT * FROM invites WHERE hash=?').get(digest(token)) as Row | undefined;
      if (!invitation || invitation.revoked || invitation.expires <= Date.now()) throw new HttpError(404,'Invitation unavailable');
      if (invitation.acceptedBy === uid) return { groupId:invitation.groupId,memberId:invitation.memberId };
      if (invitation.acceptedBy) throw new HttpError(409,'Invitation already used');
      const member = this.value(invitation.groupId,'members',invitation.memberId);
      if (!member || member.userId) throw new HttpError(409,'Member already linked');
      const existing = this.database.prepare('SELECT uid FROM access WHERE groupId=? AND uid=?').get(invitation.groupId,uid);
      if (existing) throw new HttpError(409,'Account already has a distinct member in this group');
      this.database.prepare('INSERT INTO access VALUES(?,?,?,?)').run(invitation.groupId,uid,invitation.memberId,'MEMBER');
      this.database.prepare('UPDATE invites SET acceptedBy=? WHERE hash=?').run(uid,digest(token));
      const membership = {id:randomUUID(),householdId:invitation.groupId,userId:uid,role:'MEMBER',joinedAt:new Date().toISOString()};
      this.append(invitation.groupId,[{collection:'members',id:member.id,value:{...member,userId:uid}},
        {collection:'memberships',id:membership.id,value:membership}]);
      return {groupId:invitation.groupId,memberId:member.id};
    });
  }
  complete(uid: string, groupId: string, todoId: string, input: Row) {
    id(todoId);
    return this.transaction(() => {
      const membership = this.access(groupId,uid);
      const todo = this.value(groupId,'todo_items',todoId) as TodoItem | null;
      if (!todo) throw new HttpError(404,'Todo not found');
      if (todo.status === 'completed') throw new HttpError(409,'Todo already completed');
      const household = this.value(groupId,'households',groupId) as Household;
      const category = todo.categoryId ? this.value(groupId,'categories',todo.categoryId) : null;
      const result = planTodoCompletion({ ...input,todo,household,completedByUserId:uid,category } as CompletionInput | ExpenseCompletionInput);
      const collection = result.kind === 'expense' ? 'expense_entries' : 'contribution_entries';
      const entry = {...(result.kind === 'expense' ? result.expenseEntry : result.contributionEntry),id:`todo-${digest(todoId)}`};
      this.validate(groupId,uid,membership.role,{collection,id:entry.id,baseVersion:0,value:entry});
      return this.append(groupId,[{collection,id:entry.id,value:entry},
        {collection:'todo_items',id:todoId,value:{...todo,...result.updatedTodo}}]);
    });
  }
}
