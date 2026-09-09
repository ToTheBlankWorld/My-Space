import { describe, expect, it } from 'vitest';

import { durationMinutesSchema, isoDateTimeSchema, timeZoneSchema } from '../temporal';

describe('isoDateTimeSchema', () => {
  it.each([
    '2026-03-29T01:30:00.000Z',
    '2026-03-29T01:30:00Z',
    '2026-03-29T01:30:00+01:00',
    '2026-03-29T01:30:00.123456-05:00',
  ])('accepts %s', (value) => {
    expect(isoDateTimeSchema.parse(value)).toBe(value);
  });

  it('rejects a wall-clock timestamp without an offset', () => {
    // Ambiguous across timezones: it names a local reading, not an instant.
    expect(isoDateTimeSchema.safeParse('2026-03-29T01:30:00').success).toBe(false);
  });

  it.each(['2026-13-01T00:00:00Z', '2026-02-30T00:00:00Z', 'yesterday', ''])(
    'rejects %s',
    (value) => {
      expect(isoDateTimeSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe('timeZoneSchema', () => {
  it.each(['UTC', 'Europe/Lisbon', 'America/New_York', 'Asia/Kolkata'])(
    'accepts the IANA zone %s',
    (value) => {
      expect(timeZoneSchema.parse(value)).toBe(value);
    },
  );

  it.each(['Mars/Olympus_Mons', 'GMT+5', ''])('rejects %s', (value) => {
    expect(timeZoneSchema.safeParse(value).success).toBe(false);
  });
});

describe('durationMinutesSchema', () => {
  it('accepts zero and whole positive minutes', () => {
    expect(durationMinutesSchema.parse(0)).toBe(0);
    expect(durationMinutesSchema.parse(90)).toBe(90);
  });

  it.each([-1, 12.5, Number.NaN])('rejects %s', (value) => {
    expect(durationMinutesSchema.safeParse(value).success).toBe(false);
  });
});
