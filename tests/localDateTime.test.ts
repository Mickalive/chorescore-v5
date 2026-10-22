import { localDateTimeParts, parseLocalDateTime } from '../src/domain/services/localDateTime';

test('accepts leap days, rejects silent date/time overflow and round-trips local wall time', () => {
  const date = parseLocalDateTime('2024-02-29','23:59');
  expect(date).not.toBeNull();
  expect(localDateTimeParts(date!)).toEqual({date:'2024-02-29',time:'23:59'});
  for (const [day,time] of [['2023-02-29','12:00'],['2026-04-31','12:00'],['2026-13-01','12:00'],
    ['2026-01-01','24:00'],['2026-01-01','12:60'],['2026-01-01','-1:00'],['26-01-01','12:00']]) {
    expect(parseLocalDateTime(day,time)).toBeNull();
  }
  expect(parseLocalDateTime('2026-01-01','00:00')?.getHours()).toBe(0);
});
