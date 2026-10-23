import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { HttpError } from './auth';
import { calculateContributionBalances } from '../src/domain/calculations/contributionLedger';
import { allocateExpense } from '../src/domain/calculations/expenseLedger';
import { CompletionInput, ExpenseCompletionInput, planTodoCompletion } from '../src/domain/services/todoCompletionService';
import { ContributionEntry, ExpenseEntry, Household, TodoItem } from '../src/domain/entities';

type Row = Record<string, any>;
export interface Change { collection: string; id: string; baseVersion: number; value: Row | null; }
const editable = new Set(['contribution_entries','expense_entries','todo_items','persistent_tasks','categories','members','households']);
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new HttpError(400, message);
}
function id(value: unknown): asserts value is string { requireValue(typeof value === 'string' && idPattern.test(value), 'Invalid identifier'); }
function text(value: unknown, max = 200) { requireValue(typeof value === 'string' && value.trim() && value.length <= max, 'Invalid text'); }
function digest(value: string) { return createHash('sha256').update(value).digest('hex'); }

/** Single authoritative writer on a persistent SQLite volume. Accounting uses
 * the same pure domain rules as the app; no balances are accepted from clients. */
export class CollaborationStore {
  readonly database: DatabaseSync;
  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY, owner TEXT NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS access(groupId TEXT NOT NULL, uid TEXT NOT NULL, memberId TEXT NOT NULL UNIQUE, role TEXT NOT NULL, PRIMARY KEY(groupId,uid));
      CREATE TABLE IF NOT EXISTS records(groupId TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, value TEXT, PRIMARY KEY(collection,id));
      CREATE INDEX IF NOT EXISTS records_group ON records(groupId,collection);
      CREATE TABLE IF NOT EXISTS events(groupId TEXT NOT NULL, revision INTEGER NOT NULL, changes TEXT NOT NULL, PRIMARY KEY(groupId,revision));
      CREATE TABLE IF NOT EXISTS mutations(groupId TEXT NOT NULL, uid TEXT NOT NULL, id TEXT NOT NULL, hash TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(groupId,uid,id));
      CREATE TABLE IF NOT EXISTS invites(hash TEXT PRIMARY KEY, groupId TEXT NOT NULL, memberId TEXT NOT NULL, expires INTEGER NOT NULL, acceptedBy TEXT, revoked INTEGER NOT NULL DEFAULT 0);
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
  private append(groupId: string, changes: Array<Omit<Change,'baseVersion'>>) {
    const group = this.database.prepare('UPDATE groups SET revision=revision+1 WHERE id=? RETURNING revision').get(groupId) as Row;
    const revision = group.revision as number;
    const applied = changes.map(change => {
      const version = (this.record(groupId,change.collection,change.id)?.version ?? 0) + 1;
      this.database.prepare(`INSERT INTO records(groupId,collection,id,version,value) VALUES(?,?,?,?,?)
        ON CONFLICT(collection,id) DO UPDATE SET version=excluded.version,value=excluded.value`).run(
          groupId,change.collection,change.id,version,change.value ? JSON.stringify(change.value) : null);
      return { ...change, version };
    });
    this.database.prepare('INSERT INTO events VALUES(?,?,?)').run(groupId,revision,JSON.stringify(applied));
    return { revision, changes: applied };
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
      if (change.collection === 'members' || change.collection === 'households') {
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
    if (value.attachments !== undefined) requireValue(Array.isArray(value.attachments),'Invalid attachments');
    if (value.attachments?.length) throw new HttpError(400,'Private cloud media must be uploaded before attachment sync');
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
    return this.transaction(() => {
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
