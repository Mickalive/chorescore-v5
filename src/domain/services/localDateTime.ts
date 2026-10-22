/** Parse explicit local date/time without Date's silent overflow (31 February)
 * or DST-gap normalization. No implicit UTC conversion of date-only strings. */
export function parseLocalDateTime(date: string, time: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const [year,month,day] = date.split('-').map(Number);
  const [hour,minute] = time.split(':').map(Number);
  if (year < 100 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const result = new Date(year,month-1,day,hour,minute,0,0);
  return result.getFullYear() === year && result.getMonth() === month-1 && result.getDate() === day &&
    result.getHours() === hour && result.getMinutes() === minute ? result : null;
}
export function localDateTimeParts(value: Date): {date:string;time:string} {
  const pad = (part: number) => String(part).padStart(2,'0');
  return {date:`${String(value.getFullYear()).padStart(4,'0')}-${pad(value.getMonth()+1)}-${pad(value.getDate())}`,
    time:`${pad(value.getHours())}:${pad(value.getMinutes())}`};
}
