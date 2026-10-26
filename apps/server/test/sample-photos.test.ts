import exifr from 'exifr';
import { describe, expect, it } from 'vitest';
import { SAMPLE_SHOTS, localToUtc, renderSamplePhoto } from '../src/cli/sample-photos';

describe('sample photos', () => {
  it('converts Asia/Jerusalem wall time to the right instant', () => {
    expect(
      localToUtc({ y: 2024, m: 6, d: 15, h: 11, min: 5 }, 'Asia/Jerusalem').toISOString(),
    ).toBe('2024-06-15T08:05:00.000Z');
    expect(
      localToUtc({ y: 2025, m: 1, d: 12, h: 14, min: 0 }, 'Asia/Jerusalem').toISOString(),
    ).toBe('2025-01-12T12:00:00.000Z');
  });

  it('embeds the capture time and GPS in the JPEG', async () => {
    const shot = SAMPLE_SHOTS.find((item) => item.id === 'port-2024');
    expect(shot?.place).toBeTruthy();
    const rendered = await renderSamplePhoto(shot!);
    const gps = await exifr.gps(rendered.bytes);
    expect(gps.latitude).toBeCloseTo(shot!.place!.latitude, 3);
    expect(gps.longitude).toBeCloseTo(shot!.place!.longitude, 3);

    const parsed = (await exifr.parse(rendered.bytes)) as {
      Make?: string;
      Model?: string;
      DateTimeOriginal?: Date;
    };
    expect(parsed.Make).toBe('NGP');
    expect(parsed.Model).toBe('Seed');
    const taken = parsed.DateTimeOriginal;
    expect(taken).toBeInstanceOf(Date);
    expect(taken?.getUTCFullYear()).toBe(2024);
    expect(taken?.getUTCMonth()).toBe(5);
    expect(taken?.getUTCDate()).toBe(15);
    expect(taken?.getUTCHours()).toBe(11);
    expect(taken?.getUTCMinutes()).toBe(5);
  });
});
