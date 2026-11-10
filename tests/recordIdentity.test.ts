import { initializeSchema } from '../src/infrastructure/local/SqliteStorage';

const sqlite = (process as any).getBuiltinModule('node:sqlite');

function device() {
  const native = new sqlite.DatabaseSync(':memory:');
  const bridge: any = {
    execAsync: async (sql: string) => native.exec(sql),
    runAsync: async (sql: string, args: any[]) => native.prepare(sql).run(...args),
    getAllAsync: async (sql: string, args: any[] = []) => native.prepare(sql).all(...args),
    getFirstAsync: async (sql: string, args: any[] = []) => native.prepare(sql).get(...args),
  };
  let HouseholdRepository: any;
  // Separate JS runtimes reproduce independent phone counters and cold starts.
  jest.isolateModules(() => {
    HouseholdRepository = require('../src/infrastructure/repositories/SqliteRepositories').SqliteHouseholdRepository;
  });
  return { native, bridge, households: new HouseholdRepository(async () => bridge) };
}

test('same-clock independent SQLite clients keep separate identities when their records are combined', async () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  const alice = device();
  const bob = device();
  const combined = device();
  try {
    await Promise.all([alice, bob, combined].map(client => initializeSchema(client.bridge)));
    const first = await alice.households.create({ name: 'Alice', ownerId: 'a', contributionUnit: 'points' });
    const second = await bob.households.create({ name: 'Bob', ownerId: 'b', contributionUnit: 'minutes' });
    expect(first.id).not.toBe(second.id);
    await combined.households.seed([first, second]);
    expect((await combined.households.getAll()).map((group: any) => group.name).sort()).toEqual(['Alice', 'Bob']);

    // A process restart at the same clock must not reuse a previous record id.
    let RestartedRepository: any;
    jest.isolateModules(() => {
      RestartedRepository = require('../src/infrastructure/repositories/SqliteRepositories').SqliteHouseholdRepository;
    });
    const restarted = new RestartedRepository(async () => alice.bridge);
    const third = await restarted.create({ name: 'Après relance', ownerId: 'a', contributionUnit: 'points' });
    expect(third.id).not.toBe(first.id);
    expect(await restarted.getAll()).toHaveLength(2);
  } finally {
    clock.mockRestore();
    for (const client of [alice, bob, combined]) client.native.close();
  }
});
