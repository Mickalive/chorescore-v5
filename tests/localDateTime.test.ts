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

test('rejects the missing spring DST hour using a real Europe/Berlin runtime', () => {
  const { spawnSync } = require('node:child_process');
  const { pathToFileURL } = require('node:url');
  const moduleUrl = pathToFileURL(require('node:path').resolve('src/domain/services/localDateTime.ts')).href;
  const result = spawnSync(process.execPath,['--input-type=module','-e',
    `import {parseLocalDateTime,localDateTimeParts} from ${JSON.stringify(moduleUrl)};
     console.log(JSON.stringify([
       parseLocalDateTime('2026-03-29','02:30'),
       localDateTimeParts(parseLocalDateTime('2026-03-29','03:30')),
       localDateTimeParts(parseLocalDateTime('2026-10-25','02:30'))
     ]));`],{env:{...process.env,TZ:'Europe/Berlin'},encoding:'utf8'});
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([null,
    {date:'2026-03-29',time:'03:30'},{date:'2026-10-25',time:'02:30'}]);
});
