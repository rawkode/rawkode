export function dayID(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
export function parseDay(value:string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const result = new Date(0);
  result.setFullYear(year,month-1,day);
  result.setHours(12,0,0,0);
  return dayID(result) === value ? result : null;
}
export function offsetDay(day:string, offset:number) {
  const date = parseDay(day)!;
  date.setDate(date.getDate()+offset);
  return dayID(date);
}
export const longDate = (day:string) => parseDay(day)!.toLocaleDateString(undefined,{day:'numeric',month:'long',year:'numeric'});
