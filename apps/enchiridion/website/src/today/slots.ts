export type TodaySlot = 'document' | 'agenda' | 'people' | 'weather';
export interface TodayConfiguration { version: 1; main: TodaySlot[]; context: TodaySlot[] }
export const defaultTodayConfiguration: TodayConfiguration = { version: 1, main: ['document'], context: ['agenda', 'people', 'weather'] };
export function todayConfiguration(input?: Partial<TodayConfiguration>): TodayConfiguration {
  const result = { ...defaultTodayConfiguration, ...input };
  const all = [...result.main, ...result.context];
  if (result.version !== 1 || !all.includes('document') || new Set(all).size !== all.length || all.some(id => !['document', 'agenda', 'people', 'weather'].includes(id))) throw new Error('Invalid Today layout');
  return result;
}
