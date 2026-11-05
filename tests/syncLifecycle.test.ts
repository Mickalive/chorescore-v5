import { RemoteSyncAdapter } from '../src/infrastructure/sync/RemoteSyncAdapter';

beforeEach(() => jest.useFakeTimers());
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

function service() {
  const sync = new RemoteSyncAdapter({
    request: async () => ({}), getAccessToken: async () => 'token',
    getRepos: () => { throw new Error('Network and repositories are not used in this lifecycle test'); },
    pollIntervalMs: 1000,
  });
  const pull = jest.spyOn(sync, 'pullChanges').mockResolvedValue(undefined);
  const push = jest.spyOn(sync, 'pushChanges').mockResolvedValue(undefined);
  return { sync, pull, push };
}

test('concurrent starts share one initial sync and one polling timer', async () => {
  const { sync, pull, push } = service();
  let release!: () => void;
  pull.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const first = sync.startSync('g');
  const second = sync.startSync('g');
  expect(pull).toHaveBeenCalledTimes(1);
  release();
  await Promise.all([first, second]);
  expect(push).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1000);
  expect(pull).toHaveBeenCalledTimes(2);
  expect(push).toHaveBeenCalledTimes(2);
  await sync.stopSync('g');
  await jest.advanceTimersByTimeAsync(2000);
  expect(push).toHaveBeenCalledTimes(2);
});

test('stopping while the first pull is pending cannot recreate a timer or push', async () => {
  const { sync, pull, push } = service();
  let release!: () => void;
  pull.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const first = sync.startSync('g');
  await sync.stopSync('g');
  release();
  await first;
  await jest.advanceTimersByTimeAsync(3000);
  expect(push).not.toHaveBeenCalled();
  expect(pull).toHaveBeenCalledTimes(1);
});

test('stopping every group stops every poll', async () => {
  const { sync, pull, push } = service();
  await Promise.all([sync.startSync('a'), sync.startSync('b')]);
  expect(push).toHaveBeenCalledTimes(2);
  await sync.stopSync('*');
  await jest.advanceTimersByTimeAsync(3000);
  expect(push).toHaveBeenCalledTimes(2);
  expect(pull).toHaveBeenCalledTimes(2);
});

test('an old cancelled startup cannot delete a replacement session', async () => {
  const { sync, pull, push } = service();
  let release!: () => void;
  pull.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const old = sync.startSync('g');
  await sync.stopSync('g');
  await sync.startSync('g');
  release();
  await old;
  await jest.advanceTimersByTimeAsync(1000);
  expect(push).toHaveBeenCalledTimes(2);
  await sync.stopSync('g');
  await jest.advanceTimersByTimeAsync(3000);
  expect(push).toHaveBeenCalledTimes(2);
});
