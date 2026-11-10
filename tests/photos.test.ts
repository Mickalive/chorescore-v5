import { isManagedPhotoRef } from '../src/infrastructure/local/managedPhotoRef';
const root = 'file:///private/documents/chorescore-photos/';
test('managed private photo references remain deletable', () => {
  expect(isManagedPhotoRef(root+'group-1/12345-photo.jpg',root)).toBe(true);
});
test.each(['../secret.jpg','group/../../secret.jpg','group/%2e%2e/secret.jpg','group/a%2f..%2fsecret.jpg',
  'group/p.jpg?path=secret','group/p.jpg#x','group/nested/p.jpg','other.txt'])('photo deletion refuses traversal or external files: %s', suffix => {
  expect(isManagedPhotoRef(root+suffix,root)).toBe(false);
});
test('a different storage root cannot be deleted', () => {
  expect(isManagedPhotoRef('file:///private/secrets/group/p.jpg',root)).toBe(false);
});
