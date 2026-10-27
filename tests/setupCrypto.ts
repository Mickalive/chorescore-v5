// Substitute only the unavailable native entropy bridge with real Node crypto.
// The application still calls Expo's native crypto API on Android/iOS.
jest.mock('expo-crypto', () => ({
  ...jest.requireActual('expo-crypto'),
  randomUUID: () => require('node:crypto').randomUUID(),
}));
