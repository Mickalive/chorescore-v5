import { HttpMediaGateway } from '../src/infrastructure/sync/HttpMediaGateway';
import { RemoteSyncAdapter } from '../src/infrastructure/sync/RemoteSyncAdapter';

test.each(['http://remote.example', 'http://localhost.evil.example', 'ftp://authority.example',
  'https://user:password@authority.example', 'https://authority.example?token=secret'])
('both authenticated transports refuse unsafe authority %s before reading a token', baseUrl => {
  const getAccessToken = jest.fn();
  expect(() => new HttpMediaGateway({ baseUrl, getAccessToken })).toThrow();
  expect(() => new RemoteSyncAdapter({ baseUrl, getAccessToken, getRepos: jest.fn() })).toThrow();
  expect(getAccessToken).not.toHaveBeenCalled();
});

test.each(['https://authority.example/api/', 'http://127.0.0.1:8080', 'http://localhost:8080'])
('HTTPS authorities and explicit local development servers remain usable: %s', baseUrl => {
  expect(new HttpMediaGateway({ baseUrl, getAccessToken: async () => null }).isAvailable()).toBe(true);
});
