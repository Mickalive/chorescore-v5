/** Actual disk-backed SQLite through Node's driver. Only the native bridge is
 * substituted; schema, SQL repositories, transactions and use cases are real.
 * This does not validate the Expo Android bridge or device UI.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase, initializeSchema, applyV4ColumnMigrations } from '../src/infrastructure/local/SqliteStorage';
import { createSqliteRepositories } from '../src/infrastructure/repositories/RepositoryFactory';
import { createGroupWithMembers } from '../src/application/use-cases/groupMembers';
import { RemoteSyncAdapter } from '../src/infrastructure/sync/RemoteSyncAdapter';
import { completeTodoAtomic } from '../src/application/use-cases/completeTodoAtomic';
import { adoptLocalGroups } from '../src/application/use-cases/adoptLocalGroups';
import { createBalanceSnapshot } from '../src/domain/calculations/materializedBalances';
import { createScopedRepositories } from '../src/infrastructure/repositories/ScopedRepositoryFacade';
import { createProjectedSettlement } from '../src/application/use-cases/groupBalances';


let mockDatabase: any;
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: async () => mockDatabase }));

const sqlite = (process as any).getBuiltinModule('node:sqlite');
const folder = mkdtempSync(join(tmpdir(), 'chorescore-sqlite-'));
const path = join(folder, 'data.db');
let native: any;
function open() {
  native = new sqlite.DatabaseSync(path);
  mockDatabase = {
    execAsync: async (sql: string) => native.exec(sql),
    runAsync: async (sql: string, ...args: any[]) => native.prepare(sql).run(...(Array.isArray(args[0]) ? args[0] : args)),
    getAllAsync: async (sql: string, ...args: any[]) => native.prepare(sql).all(...(Array.isArray(args[0]) ? args[0] : args)),
    getFirstAsync: async (sql: string, ...args: any[]) => native.prepare(sql).get(...(Array.isArray(args[0]) ? args[0] : args)) ?? null,
    closeAsync: async () => native.close(),
    withTransactionAsync: async (fn: () => Promise<void>) => {
      native.exec('BEGIN');
      try { await fn(); native.exec('COMMIT'); }
      catch (error) { native.exec('ROLLBACK'); throw error; }
    },
  };
}
// getDatabase retains the bridge object, so keep its methods pointing at the
// current driver when closing/reopening the same database file.
afterAll(() => { native.close(); rmSync(folder, { recursive: true }); });

test('real SQLite: task + expense completion is unique, rollback-safe and durable after reopen', async () => {
  open();
  await getDatabase();
  const repos = (await createSqliteRepositories())!;
  expect(repos).not.toBeNull();
  const { household, ownerMember, namedMembers } = await createGroupWithMembers(repos, {
    name: 'Foyer', owner: { userId: 'a', displayName: 'Alice' }, memberNames: ['Bob'], contributionUnit: 'points',
  });
  const ids = [ownerMember.id, namedMembers[0].id];
  for (const kind of ['task', 'expense'] as const) {
    const todo = await repos.todos.create({ householdId: household.id, title: kind, kind,
      status: 'todo', assigneeMemberId: ids[0], beneficiaryMemberIds: ids,
      dueAt: null, reminderAt: null, notes: 'Persistante', persistentTaskId: null });
    const common = { todo, household, completedByUserId: 'a' };
    const input = kind === 'task'
      ? { ...common, performerMemberId: ids[0], beneficiaryMemberIds: ids, value: 12 }
      : { ...common, paidByMemberId: ids[0], participantMemberIds: ids, amountMinor: 101, currency: 'EUR' };
    const failed = jest.spyOn(repos.todos, 'update').mockRejectedValueOnce(new Error('disk failure'));
    await expect(completeTodoAtomic(repos, input)).rejects.toThrow('disk failure');
    expect((await repos.todos.getById(todo.id))?.status).toBe('todo');
    expect(await repos.syncState.getDirtyRecords(household.id,
      kind === 'task' ? 'contribution_entries' : 'expense_entries', 0)).toHaveLength(0);
    failed.mockRestore();
    const result = await Promise.allSettled([completeTodoAtomic(repos, input), completeTodoAtomic(repos, input)]);
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  }
  const unicodeTodo = await repos.todos.create({ householdId: household.id,
    title: 'Payer l\u2019électricité – tâche café', kind: 'task', status: 'todo',
    assigneeMemberId: ids[0], beneficiaryMemberIds: ids, dueAt: null, reminderAt: null,
    notes: 'Dépôt à l\u2019agence nº 4', persistentTaskId: null });
  native.close();
  native = new sqlite.DatabaseSync(path);
  expect(await repos.todos.getById(unicodeTodo.id)).toMatchObject({
    title: 'Payer l\u2019électricité – tâche café',
    notes: 'Dépôt à l\u2019agence nº 4',
  });
  expect(await repos.contributions.getByHousehold(household.id)).toEqual([
    expect.objectContaining({ unit: 'points', value: 12, note: 'Persistante' }),
  ]);
  const expenses = await repos.expenses.getByHousehold(household.id);
  expect(expenses).toHaveLength(1);
  expect(expenses[0]).toMatchObject({ amountMinor: 101, currency: 'EUR', note: 'Persistante' });
  const persistedTodos = await repos.todos.getByHousehold(household.id);
  expect(persistedTodos).toHaveLength(3);
  expect(persistedTodos).toEqual(expect.arrayContaining([
    expect.objectContaining({ status: 'completed' }),
    expect.objectContaining({ status: 'todo', title: 'Payer l\u2019électricité – tâche café' }),
  ]));
  await initializeSchema(mockDatabase);
  expect(await applyV4ColumnMigrations(mockDatabase)).toBe(0);
  expect((await repos.households.getById(household.id))?.contributionUnit).toBe('points');
});

test('photo references follow committed edits/deletions and survive rollback or shared references', async () => {
  const repos = (await createSqliteRepositories())!;
  const group = (await repos.households.getAll())[0];
  const members = await repos.members.getByHousehold(group.id);
  const ref = 'file:///private/chorescore-photos/test/photo.jpg';
  const attachments = [{ id: 'photo', kind: 'photo' as const, ref, createdAt: new Date().toISOString() }];
  const make = () => repos.expenses.create({ householdId: group.id, title: 'Photo', amountMinor: 100,
    currency: 'EUR', paidByMemberId: members[0].id, participantMemberIds: members.map(m => m.id),
    splitMode: 'equal', attachments, occurredAt: new Date().toISOString(), createdBy: 'a' });
  const one = await make(), two = await make();
  const count = () => mockDatabase.getFirstAsync('SELECT COUNT(*) AS n FROM attachment_links WHERE ref = ?', [ref]);
  expect((await count()).n).toBe(2);
  await expect(repos.withTransaction(async () => {
    await repos.expenses.update(one.id, { attachments: [] });
    throw new Error('cancel');
  })).rejects.toThrow('cancel');
  expect((await count()).n).toBe(2);
  await repos.expenses.delete(one.id);
  expect((await count()).n).toBe(1);
  await repos.expenses.update(two.id, { attachments: [] });
  expect((await count()).n).toBe(0);
  expect(await mockDatabase.getAllAsync(`SELECT f.ref FROM attachment_files f
    WHERE f.committed = 1 AND NOT EXISTS (SELECT 1 FROM attachment_links l WHERE l.ref = f.ref)`)).toEqual([{ ref }]);
});

test('outbox sequences are unique across concurrent reservations and process restart', async () => {
  const repos = (await createSqliteRepositories())!;
  const values = await Promise.all(Array.from({ length: 20 }, () => repos.syncState.nextLocalRevision('g', 'members')));
  expect(new Set(values).size).toBe(20);
  native.close(); native = new sqlite.DatabaseSync(path);
  const reopened = (await createSqliteRepositories())!;
  expect(await reopened.syncState.nextLocalRevision('g', 'members')).toBeGreaterThan(Math.max(...values));
});

test('entry mutation and local outbox commit together when the sync write fails', async () => {
  const repos = (await createSqliteRepositories())!;
  const group = (await repos.households.getAll())[0];
  const members = await repos.members.getByHousehold(group.id);
  const before = await repos.contributions.getByHousehold(group.id);
  const originalRun = mockDatabase.runAsync;
  const failure = jest.spyOn(mockDatabase, 'runAsync').mockImplementation(async (sql: unknown, ...args: any[]) => {
    if (typeof sql === 'string' && /INSERT.*sync_records/i.test(sql)) throw new Error('outbox disk failure');
    return originalRun(sql,...args);
  });
  try {
    await expect(repos.withTransaction(() => repos.contributions.create({
      householdId:group.id,persistentTaskId:null,label:'Must roll back',performedByMemberId:members[0].id,
      beneficiaryMemberIds:members.map(m => m.id),value:7,unit:'points',occurredAt:new Date().toISOString(),createdBy:'a',
    }))).rejects.toThrow('outbox disk failure');
  } finally { failure.mockRestore(); }
  expect(await repos.contributions.getByHousehold(group.id)).toEqual(before);
  // The rolled-back reservation must not poison the transaction queue.
  await repos.withTransaction(() => repos.contributions.create({
    householdId:group.id,persistentTaskId:null,label:'Retry succeeds',performedByMemberId:members[0].id,
    beneficiaryMemberIds:members.map(m => m.id),value:7,unit:'points',occurredAt:new Date().toISOString(),createdBy:'a',
  }));
  expect((await repos.contributions.getByHousehold(group.id)).length).toBe(before.length+1);
});

test('group deletion is isolated, owner-only, rollback-safe and clears private rows and links', async () => {
  const { createScopedRepositories } = await import('../src/infrastructure/repositories/ScopedRepositoryFacade');
  const raw = (await createSqliteRepositories())!;
  const {household,ownerMember,namedMembers} = await createGroupWithMembers(raw,{
    name:'Delete test',owner:{userId:'delete-owner',displayName:'Owner'},memberNames:['Member'],contributionUnit:'minutes',
  });
  await raw.memberships.create({userId:'delete-member',householdId:household.id,role:'MEMBER'});
  const attachment = {id:'delete-photo',kind:'photo' as const,ref:'file:///private/chorescore-photos/delete/photo.jpg',createdAt:new Date().toISOString()};
  await raw.withTransaction(() => raw.expenses.create({householdId:household.id,title:'Private',amountMinor:101,currency:'CHF',
    paidByMemberId:ownerMember.id,participantMemberIds:[ownerMember.id,namedMembers[0].id],splitMode:'equal',attachments:[attachment],
    occurredAt:new Date().toISOString(),createdBy:'delete-owner'}));
  const otherGroups = (await raw.households.getAll()).filter(h=>h.id!==household.id);
  const member = createScopedRepositories(raw,'delete-member');
  await expect(member.withTransaction(()=>member.households.delete(household.id))).rejects.toThrow();
  const owner = createScopedRepositories(raw,'delete-owner');
  await expect(owner.withTransaction(async()=>{await owner.households.delete(household.id);throw new Error('abort deletion');})).rejects.toThrow('abort deletion');
  expect(await owner.members.getByHousehold(household.id)).toHaveLength(2);
  expect(await owner.expenses.getByHousehold(household.id)).toHaveLength(1);
  await owner.withTransaction(()=>owner.households.delete(household.id));
  for(const table of ['members','memberships','expense_entries','todo_items','contribution_entries','categories','persistent_tasks','invitations','settlements']) {
    expect((await mockDatabase.getFirstAsync(`SELECT COUNT(*) AS n FROM ${table} WHERE householdId = ?`,[household.id])).n).toBe(0);
  }
  expect(await raw.households.getAll()).toEqual(otherGroups);
  expect(await mockDatabase.getFirstAsync('SELECT COUNT(*) AS n FROM attachment_links WHERE ref=?',[attachment.ref])).toEqual({n:0});
  const dirty=await raw.syncState.getDirtyRecords(household.id,'households',0);
  expect(dirty).toEqual([expect.objectContaining({id:household.id,payload:null,deletedAt:expect.any(String)})]);
});

test('repository pagination reads a bounded window from 50 000 entries', async () => {
  const { loadActivityHistoryPage } = await import('../src/application/use-cases/activityHistory');
  const repos = (await createSqliteRepositories())!;
  const householdId = 'bulk-history';
  const insert = native.prepare(`INSERT INTO contribution_entries
    (id, householdId, label, performedByMemberId, beneficiaryMemberIds, value, unit,
     persistentTaskId, occurredAt, createdBy, modifiedBy, categoryId,
     categoryLabelSnapshot, note, attachmentsJson, splitMode, splitWeightsJson, splitSource)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  native.exec('BEGIN');
  try {
    for (let index = 0; index < 50_000; index += 1) {
      const occurredAt = new Date(Date.UTC(2025, 0, 1) + index * 1_000).toISOString();
      insert.run(
        `bulk-${String(index).padStart(5, '0')}`, householdId, `Bulk ${index}`,
        'm1', '["m1"]', 1, 'minutes', null, occurredAt, 'u',
        null, null, null, null, null, null, null, null,
      );
    }
    native.exec('COMMIT');
  } catch (error) {
    native.exec('ROLLBACK');
    throw error;
  }

  const started = process.hrtime.bigint();
  const page = await loadActivityHistoryPage(repos, householdId, {
    limit: 20,
    filter: 'contribution',
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  expect(page.entries).toHaveLength(20);
  expect(page.hasMore).toBe(true);
  const labels = page.entries.map((entry) => {
    if (entry.type !== 'contribution') throw new Error('unexpected history type');
    return entry.entry.label;
  });
  expect(labels[0]).toBe('Bulk 49999');
  expect(labels[19]).toBe('Bulk 49980');
  expect(elapsedMs).toBeLessThan(2_000);

  native.prepare('DELETE FROM contribution_entries WHERE householdId = ?').run(householdId);
}, 30_000);

test('50 000 pending writes are read in bounded SQLite pages without skipping a revision', async () => {
  const repos = (await createSqliteRepositories())!;
  const householdId = 'bulk-outbox';
  const insert = native.prepare('INSERT INTO sync_records (id, householdId, collection, revision, updatedAt, deletedAt, payload) VALUES (?, ?, ?, ?, ?, ?, ?)');
  native.exec('BEGIN');
  try {
    for (let i = 1; i <= 50_000; i++) {
      insert.run(`outbox-${i}`, householdId, 'contribution_entries', i, '2026-01-01T00:00:00.000Z', null, '{}');
    }
    native.exec('COMMIT');
  } catch (error) {
    native.exec('ROLLBACK');
    throw error;
  }
  const original = mockDatabase.getAllAsync;
  const returnedSizes: number[] = [];
  const query = jest.spyOn(mockDatabase, 'getAllAsync').mockImplementation(async (sql: any, ...args: any[]) => {
    const rows = await original(sql, ...args);
    if (sql.includes('FROM sync_records')) returnedSizes.push(rows.length);
    return rows;
  });
  try {
    expect(await repos.syncState.countDirtyRecords(householdId, 'contribution_entries', 40_000)).toBe(10_000);
    expect(await repos.syncState.countDirtyRecords('another-group', 'contribution_entries', 0)).toBe(0);
    const hydrate = jest.spyOn(repos.syncState, 'getDirtyRecords').mockRejectedValue(new Error('Status must not hydrate outbox payloads'));
    try {
      const sync = new RemoteSyncAdapter({ getRepos: () => repos, getAccessToken: async () => null });
      expect((await sync.getStatus(householdId)).pendingChanges).toBe(50_000);
      expect(hydrate).not.toHaveBeenCalled();
    } finally { hydrate.mockRestore(); }
    let cursor = 0;
    const seen = new Set<string>();
    for (let pageNumber = 0; pageNumber <= 500; pageNumber++) {
      const page = await repos.syncState.getDirtyRecords(householdId, 'contribution_entries', cursor, 100);
      if (!page.length) break;
      expect(page.length).toBeLessThanOrEqual(100);
      expect(page[0].revision).toBeGreaterThan(cursor);
      for (const record of page) {
        if (seen.has(record.id)) throw new Error('Duplicate outbox record');
        seen.add(record.id);
      }
      cursor = page[page.length - 1].revision;
    }
    expect(seen.size).toBe(50_000);
    expect(cursor).toBe(50_000);
    expect(returnedSizes).toHaveLength(501);
    expect(Math.max(...returnedSizes)).toBe(100);
  } finally {
    query.mockRestore();
    native.prepare('DELETE FROM sync_records WHERE householdId = ?').run(householdId);
  }
}, 30_000);

test('reminder and open todo queries exclude 50 000 completed rows at the SQL boundary', async () => {
  const repos = (await createSqliteRepositories())!;
  const householdId = 'reminder-query-audit';
  const insert = native.prepare('INSERT INTO todo_items (id,householdId,title,beneficiaryMemberIds,status,createdAt,reminderAt) VALUES (?,?,?,?,?,?,?)');
  native.exec('BEGIN');
  try {
    for (let i = 0; i < 50_000; i++) insert.run(`past-completed-${i}`, householdId, 'Completed', '[]', 'completed', '2026-01-01T00:00:00.000Z', '2099-01-01T12:00:00.000Z');
    insert.run('future-pending', householdId, 'Future', '[]', 'todo', '2026-01-01T00:00:00.000Z', '2099-01-01T12:00:00.000Z');
    insert.run('past-pending', householdId, 'Past', '[]', 'todo', '2026-01-01T00:00:00.000Z', '2000-01-01T12:00:00.000Z');
    insert.run('future-another-group', 'another-household', 'Private', '[]', 'todo', '2026-01-01T00:00:00.000Z', '2099-01-01T12:00:00.000Z');
    native.exec('COMMIT');
  } catch (error) { native.exec('ROLLBACK'); throw error; }
  const original = mockDatabase.getAllAsync;
  const returned: number[] = [];
  const query = jest.spyOn(mockDatabase, 'getAllAsync').mockImplementation(async (sql: any, ...args: any[]) => {
    const rows = await original(sql, ...args);
    if (sql.includes('FROM todo_items')) returned.push(rows.length);
    return rows;
  });
  try {
    expect((await repos.todos.getFutureReminders(householdId, '2026-01-01T00:00:00.000Z')).map(todo => todo.id)).toEqual(['future-pending']);
    expect(returned).toEqual([1]);
    const plan = native.prepare("EXPLAIN QUERY PLAN SELECT * FROM todo_items WHERE householdId=? AND status != 'completed' AND reminderAt IS NOT NULL AND reminderAt > ? ORDER BY reminderAt,id").all(householdId, '2026-01-01T00:00:00.000Z');
    expect(JSON.stringify(plan)).toContain('idx_todos_future_reminders');
    expect((await repos.todos.getOpenByHousehold(householdId)).map(todo => todo.id).sort()).toEqual(['future-pending','past-pending']);
    expect(returned).toEqual([1,2]);
    const openPlan=native.prepare("EXPLAIN QUERY PLAN SELECT * FROM todo_items WHERE householdId=? AND status != 'completed' ORDER BY createdAt DESC,id DESC").all(householdId);
    expect(JSON.stringify(openPlan)).toContain('idx_todos_open');
  } finally {
    query.mockRestore();
    native.prepare('DELETE FROM todo_items WHERE householdId=? OR id=?').run(householdId, 'future-another-group');
  }
}, 30_000);

test('local groups survive first Google sign-in without replaying history or adopting other accounts', async () => {
  const repos = (await createSqliteRepositories())!;
  const local = 'local-device-migration';
  const storage = { getItem: async () => local, setItem: async () => {}, deleteItem: async () => {}, clear: async () => {} };
  const original = await createGroupWithMembers(repos, { name: 'Avant Google',
    owner: { userId: local, displayName: 'Moi' }, memberNames: ['Camille'], contributionUnit: 'points' });
  const published = await createGroupWithMembers(repos, { name: 'Déjà publié',
    owner: { userId: local, displayName: 'Moi' }, memberNames: [], contributionUnit: 'points' });
  await repos.syncState.setGroupState({ householdId: published.household.id, remoteKnown: true,
    lastRevision: 1, lastSyncedAt: null, lastError: null });
  const stranger = await createGroupWithMembers(repos, { name: 'Autre compte',
    owner: { userId: 'local-another-device', displayName: 'Autre' }, memberNames: [], contributionUnit: 'points' });
  const todo = await repos.todos.create({ householdId: original.household.id, title: 'Ancienne dépense',
    kind: 'expense', status: 'todo', assigneeMemberId: original.ownerMember.id,
    beneficiaryMemberIds: [original.ownerMember.id, original.namedMembers[0].id],
    dueAt: null, reminderAt: null, notes: 'Conserver', persistentTaskId: null });
  await completeTodoAtomic(repos, { todo, household: original.household, completedByUserId: local,
    paidByMemberId: original.ownerMember.id, participantMemberIds: todo.beneficiaryMemberIds,
    amountMinor: 101, currency: 'CHF' });
  const history = await repos.expenses.getByHousehold(original.household.id);
  const members = await repos.members.getByHousehold(original.household.id);
  const oldMembership = await repos.memberships.getByUserAndHousehold(local, original.household.id);
  expect(await repos.memberships.getByUserAndHousehold('google-real', original.household.id)).toBeNull();

  const broken = jest.spyOn(repos.syncState, 'storeLocalRecords').mockRejectedValueOnce(new Error('disk full'));
  await expect(adoptLocalGroups(repos, storage, 'google-real', () => 'google-real')).rejects.toThrow('disk full');
  broken.mockRestore();
  expect((await repos.households.getById(original.household.id))?.ownerId).toBe(local);
  expect(await repos.members.getByHousehold(original.household.id)).toEqual(members);

  let activeAccount: string | null = 'google-real';
  const updateMember = repos.members.update.bind(repos.members);
  const changedAccount = jest.spyOn(repos.members, 'update').mockImplementationOnce(async (id, data) => {
    const result = await updateMember(id, data);
    activeAccount = null;
    return result;
  });
  await expect(adoptLocalGroups(repos, storage, 'google-real', () => activeAccount)).rejects.toThrow('Account changed');
  changedAccount.mockRestore();
  expect((await repos.households.getById(original.household.id))?.ownerId).toBe(local);
  expect(await repos.members.getByHousehold(original.household.id)).toEqual(members);
  expect(await repos.memberships.getByUserAndHousehold(local, original.household.id)).toEqual(oldMembership);

  await adoptLocalGroups(repos, storage, 'google-real', () => 'google-real');
  native.close(); native = new sqlite.DatabaseSync(path);
  expect((await repos.households.getById(original.household.id))?.ownerId).toBe('google-real');
  expect(await repos.memberships.getByUserAndHousehold('google-real', original.household.id))
    .toEqual({ ...oldMembership, userId: 'google-real' });
  expect(await repos.members.getByHousehold(original.household.id)).toEqual(members.map(member =>
    member.id === original.ownerMember.id ? { ...member, userId: 'google-real' } : member));
  expect(await repos.expenses.getByHousehold(original.household.id)).toEqual(history);
  expect((await repos.todos.getById(todo.id))?.status).toBe('completed');
  expect((await repos.households.getById(published.household.id))?.ownerId).toBe(local);
  expect((await repos.households.getById(stranger.household.id))?.ownerId).toBe('local-another-device');
  const dirty = await repos.syncState.getDirtyRecords(original.household.id, 'memberships', 0);
  expect(JSON.parse(dirty.find(record => record.id === oldMembership!.id)!.payload!))
    .toMatchObject({ id: oldMembership!.id, userId: 'google-real' });
  await adoptLocalGroups(repos, storage, 'second-google', () => 'second-google');
  expect((await repos.households.getById(original.household.id))?.ownerId).toBe('google-real');
  await expect(adoptLocalGroups(repos, storage, 'signed-out', () => null)).rejects.toThrow('Account changed');
});

test('stored balance projections match history across edits, remote replacements, deletions and rollback', async () => {
  const repos=(await createSqliteRepositories())!;
  const { household, ownerMember, namedMembers }=await createGroupWithMembers(repos, {
    name:'Projection',owner:{userId:'projection-owner',displayName:'Alice'},memberNames:['Bob','Charlie'],contributionUnit:'points',
  });
  const hid=household.id; const ids=[ownerMember.id,...namedMembers.map(member => member.id)];
  const assertSnapshot=async () => {
    const expected=createBalanceSnapshot(await repos.contributions.getByHousehold(hid),await repos.expenses.getByHousehold(hid),
      await repos.settlements.getByHousehold(hid),'points',ids);
    expect(await repos.balanceProjections.getByHousehold(hid,'points',ids)).toEqual(expected);
  };
  const task=await repos.contributions.create({householdId:hid,label:'Poids',performedByMemberId:ids[0],
    beneficiaryMemberIds:ids.slice(0,2),value:8,unit:'points',persistentTaskId:null,occurredAt:new Date().toISOString(),createdBy:'projection-owner',
    splitMode:'custom',splitWeights:[{memberId:ids[0],weight:1},{memberId:ids[1],weight:3}],splitSource:'custom'});
  const expense=await repos.expenses.create({householdId:hid,title:'Centimes',amountMinor:101,currency:'CHF',paidByMemberId:ids[1],
    participantMemberIds:ids.slice(0,2),splitMode:'custom',customShares:[{memberId:ids[0],amountMinor:50},{memberId:ids[1],amountMinor:51}],
    occurredAt:new Date().toISOString(),createdBy:'projection-owner'});
  const settlement=await repos.settlements.create({householdId:hid,contributionCreditorMemberId:ids[0],counterpartyMemberId:ids[1],
    contributionValue:1,contributionUnit:'points',moneyAmountMinor:50,currency:'CHF',
    rateSnapshot:{contributionValue:1,contributionUnit:'points',moneyAmountMinor:50,currency:'CHF'},
    occurredAt:new Date().toISOString(),createdBy:'projection-owner'});
  const selfExpense=await repos.expenses.create({householdId:hid,title:'Pour soi',amountMinor:1,currency:'eur',paidByMemberId:ids[0],
    participantMemberIds:[ids[0]],splitMode:'equal',occurredAt:new Date().toISOString(),createdBy:'projection-owner'});
  await assertSnapshot();
  await repos.contributions.update(task.id,{value:20});
  await repos.expenses.update(expense.id,{amountMinor:105,customShares:[{memberId:ids[0],amountMinor:52},{memberId:ids[1],amountMinor:53}]});
  await assertSnapshot();
  await repos.raw.contributions.seed([{...task,value:4}]);
  await repos.raw.contributions.seed([{...task,value:4}]); // replay must not double totals
  await repos.raw.expenses.seed([expense]);
  await repos.raw.expenses.seed([expense]);
  await assertSnapshot();
  const before=await repos.balanceProjections.getByHousehold(hid,'points',ids);
  await expect(repos.withTransaction(async () => {
    await repos.contributions.update(task.id,{value:100});
    await repos.expenses.delete(expense.id);
    throw new Error('disk failure');
  })).rejects.toThrow('disk failure');
  expect(await repos.balanceProjections.getByHousehold(hid,'points',ids)).toEqual(before);
  await repos.expenses.delete(expense.id); await assertSnapshot();
  await repos.settlements.delete(settlement.id); await assertSnapshot();
  expect((await repos.balanceProjections.getByHousehold(hid,'points',ids)).moneyByCurrency.get('EUR')).toEqual(new Map(ids.map(id => [id,0])));
  await repos.expenses.delete(selfExpense.id); await assertSnapshot();
  expect((await repos.balanceProjections.getByHousehold(hid,'points',ids)).moneyByCurrency.size).toBe(0);
  await repos.contributions.delete(task.id); await assertSnapshot();
  await repos.households.delete(hid);
  expect(native.prepare('SELECT COUNT(*) AS n FROM balance_totals WHERE householdId=?').get(hid).n).toBe(0);
});

test('50 000 legacy rows backfill once in bounded pages and restart reads only stored member totals', async () => {
  const repos=(await createSqliteRepositories())!;
  const {household,ownerMember,namedMembers}=await createGroupWithMembers(repos,{name:'Long historique',
    owner:{userId:'large-projection',displayName:'Alice'},memberNames:['Bob'],contributionUnit:'points'});
  const hid=household.id; const ids=[ownerMember.id,namedMembers[0].id];
  const insert=native.prepare("INSERT INTO contribution_entries(id,householdId,label,performedByMemberId,beneficiaryMemberIds,value,unit,occurredAt,createdBy) VALUES (?,?,'Ancienne',?,?,1,'points','2000-01-01T00:00:00.000Z','large-projection')");
  native.exec('BEGIN');
  for(let index=0;index<50_000;index++) insert.run(`projection-legacy-${index}`,hid,ids[0],JSON.stringify(ids));
  native.exec('COMMIT');
  const returned:number[]=[];
  const original=mockDatabase.getAllAsync;
  const query=jest.spyOn(mockDatabase,'getAllAsync').mockImplementation(async (...args:any[]) => {
    const rows=await original(...args); returned.push(rows.length); return rows;
  });
  try {
    const snapshot=await repos.balanceProjections.getByHousehold(hid,'points',ids);
    expect(snapshot.contribution).toEqual(new Map([[ids[0],25_000],[ids[1],-25_000]]));
    expect(Math.max(...returned)).toBeLessThanOrEqual(100);
    expect(native.prepare('SELECT COUNT(*) AS n FROM contribution_entries WHERE householdId=? AND balanceImpactJson IS NULL').get(hid).n).toBe(0);
    expect(await repos.syncState.countDirtyRecords(hid,'contribution_entries',0)).toBe(0);
    native.close(); native=new sqlite.DatabaseSync(path); returned.length=0;
    expect(await repos.balanceProjections.getByHousehold(hid,'points',ids)).toEqual(snapshot);
    expect(returned.reduce((a,b) => a+b,0)).toBe(2);
    const plan=native.prepare('EXPLAIN QUERY PLAN SELECT * FROM contribution_entries WHERE householdId=? AND balanceImpactJson IS NULL ORDER BY id LIMIT 100').all(hid);
    expect(JSON.stringify(plan)).toContain('idx_contribution_entries_balance_backfill');
  } finally { query.mockRestore(); }
},30_000);

test('balance projection and open todo reads enforce current household membership', async () => {
  const repos=(await createSqliteRepositories())!;
  const {household,ownerMember}=await createGroupWithMembers(repos,{name:'Privé',owner:{userId:'private-projection',displayName:'Alice'},memberNames:[],contributionUnit:'points'});
  const scoped=createScopedRepositories(repos,'private-projection');
  await expect(createScopedRepositories(repos,'intruder').balanceProjections.getByHousehold(household.id,'points',[ownerMember.id])).rejects.toThrow();
  await expect(createScopedRepositories(repos,'intruder').todos.getOpenByHousehold(household.id)).rejects.toThrow();
  expect(await scoped.todos.getOpenByHousehold(household.id)).toEqual([]);
  expect((await scoped.balanceProjections.getByHousehold(household.id,'points',[ownerMember.id])).contribution.get(ownerMember.id)).toBe(0);
  const membership=await repos.memberships.getByUserAndHousehold('private-projection',household.id);
  await repos.memberships.delete(membership!.id);
  await expect(scoped.balanceProjections.getByHousehold(household.id,'points',[ownerMember.id])).rejects.toThrow();
  await expect(scoped.todos.getOpenByHousehold(household.id)).rejects.toThrow();
});

test('concurrent compensation confirms against the current projection and rejects changed settings', async () => {
  const repos=(await createSqliteRepositories())!;
  const {household,ownerMember,namedMembers}=await createGroupWithMembers(repos,{name:'Compensation atomique',
    owner:{userId:'projected-settlement',displayName:'Alice'},memberNames:['Bob'],contributionUnit:'points'});
  const ids=[ownerMember.id,namedMembers[0].id];
  const rate={contributionValue:1,contributionUnit:'points' as const,moneyAmountMinor:100,currency:'CHF'};
  await repos.households.update(household.id,{crossLedgerCompensationEnabled:true,contributionToMoneyRate:rate});
  await repos.contributions.create({householdId:household.id,label:'Crédit',performedByMemberId:ids[0],beneficiaryMemberIds:ids,
    value:10,unit:'points',persistentTaskId:null,occurredAt:new Date().toISOString(),createdBy:'projected-settlement'});
  await repos.expenses.create({householdId:household.id,title:'Avance',amountMinor:1000,currency:'CHF',paidByMemberId:ids[1],
    participantMemberIds:ids,splitMode:'equal',occurredAt:new Date().toISOString(),createdBy:'projected-settlement'});
  const input={householdId:household.id,contributionCreditorMemberId:ids[0],counterpartyMemberId:ids[1],
    contributionValue:3,contributionUnit:'points' as const,moneyAmountMinor:300,currency:'CHF',rateSnapshot:rate,
    occurredAt:new Date().toISOString(),createdBy:'projected-settlement'};
  const results=await Promise.allSettled([createProjectedSettlement(repos,input),createProjectedSettlement(repos,input)]);
  expect(results.filter(result => result.status==='fulfilled')).toHaveLength(1);
  expect(await repos.settlements.getByHousehold(household.id)).toHaveLength(1);
  const snapshot=await repos.balanceProjections.getByHousehold(household.id,'points',ids);
  expect(snapshot.contribution).toEqual(new Map([[ids[0],2],[ids[1],-2]]));
  expect(snapshot.moneyByCurrency.get('CHF')).toEqual(new Map([[ids[0],-200],[ids[1],200]]));
  await repos.households.update(household.id,{crossLedgerCompensationEnabled:false});
  await expect(createProjectedSettlement(repos,input)).rejects.toThrow('disabled');
  await repos.households.update(household.id,{crossLedgerCompensationEnabled:true,contributionToMoneyRate:{...rate,moneyAmountMinor:101}});
  await expect(createProjectedSettlement(repos,input)).rejects.toThrow('rate changed');
  expect(await repos.settlements.getByHousehold(household.id)).toHaveLength(1);
});
