import {it,expect} from 'vitest';
import {parseDay,offsetDay} from '../src/dates';
it('rejects invalid civil dates and traverses leap days',()=>{
  expect(parseDay('2026-02-29')).toBeNull();expect(parseDay('../foo')).toBeNull();
  expect(offsetDay('2028-02-28',1)).toBe('2028-02-29');expect(offsetDay('2026-12-31',1)).toBe('2027-01-01');
});
