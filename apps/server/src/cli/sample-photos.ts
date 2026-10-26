import sharp from 'sharp';

/** Sample accounts created by `pnpm seed`. */
export const SAMPLE_PASSWORD = 'seed-library';

export const SAMPLE_ACCOUNTS = {
  alex: { email: 'alex@example.com', name: 'Alex', role: 'admin' as const, quotaBytes: null },
  sam: {
    email: 'sam@example.com',
    name: 'Sam',
    role: 'member' as const,
    quotaBytes: 50 * 1024 ** 3,
  },
};

export const SAMPLE_PEOPLE = [
  { key: 'maya', name: 'Maya', owner: 'alex' as const },
  { key: 'noam', name: 'Noam', owner: 'alex' as const },
  { key: 'jordan', name: 'Jordan', owner: 'sam' as const },
];

const WIDTH = 960;
const HEIGHT = 640;
const FACE_WIDTH = 0.16;
const FACE_HEIGHT = 0.24;

export interface LocalParts {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
}

export interface ShotFace {
  personKey: string;
  owner: 'alex' | 'sam';
  /** Center of the face, as a fraction of the frame. */
  cx: number;
  cy: number;
}

export interface SampleShot {
  id: string;
  filename: string;
  owners: Array<'alex' | 'sam'>;
  /** Included in the shared album. */
  shared: boolean;
  local: LocalParts;
  timeZone: string;
  place?: {
    city: string;
    region: string;
    country: string;
    countryCode: string;
    latitude: number;
    longitude: number;
  };
  favorite?: boolean;
  faces: ShotFace[];
  palette: { sky: string; ground: string; accent: string };
}

export interface RenderedFace {
  personKey: string;
  owner: 'alex' | 'sam';
  boxX: number;
  boxY: number;
  boxWidth: number;
  boxHeight: number;
  landmarks: [number, number][];
}

export interface RenderedShot {
  shot: SampleShot;
  bytes: Buffer;
  width: number;
  height: number;
  capturedAt: Date;
  /** Local wall time, `YYYY-MM-DD HH:MM:SS`, for `timestamp without time zone`. */
  wallClock: string;
  localDate: string;
  faces: RenderedFace[];
}

const TEL_AVIV = {
  city: 'Tel Aviv',
  region: 'Tel Aviv',
  country: 'Israel',
  countryCode: 'IL',
  latitude: 32.0853,
  longitude: 34.7818,
};
const JERUSALEM = {
  city: 'Jerusalem',
  region: 'Jerusalem',
  country: 'Israel',
  countryCode: 'IL',
  latitude: 31.7683,
  longitude: 35.2137,
};
const HAIFA = {
  city: 'Haifa',
  region: 'Haifa',
  country: 'Israel',
  countryCode: 'IL',
  latitude: 32.794,
  longitude: 34.9896,
};
const EILAT = {
  city: 'Eilat',
  region: 'South',
  country: 'Israel',
  countryCode: 'IL',
  latitude: 29.5577,
  longitude: 34.9519,
};

export const SAMPLE_ALBUM = {
  title: 'Weekends together',
  description: 'A shared album with photos from both libraries.',
};

/**
 * Two accounts, several years of dates, GPS in four cities, and faces that belong to the
 * library of the person who took the photo. `forward` is the same bytes in both libraries.
 */
export const SAMPLE_SHOTS: SampleShot[] = [
  {
    id: 'beach-2023',
    filename: 'IMG_20230615_181000.jpg',
    owners: ['alex'],
    shared: false,
    local: { y: 2023, m: 6, d: 15, h: 18, min: 10 },
    timeZone: 'Asia/Jerusalem',
    place: TEL_AVIV,
    faces: [{ personKey: 'maya', owner: 'alex', cx: 0.42, cy: 0.46 }],
    palette: { sky: '#7eb6d6', ground: '#e6d2a2', accent: '#f2c14e' },
  },
  {
    id: 'port-2024',
    filename: 'IMG_20240615_110500.jpg',
    owners: ['alex'],
    shared: true,
    local: { y: 2024, m: 6, d: 15, h: 11, min: 5 },
    timeZone: 'Asia/Jerusalem',
    place: { ...TEL_AVIV, latitude: 32.097, longitude: 34.774 },
    faces: [
      { personKey: 'maya', owner: 'alex', cx: 0.36, cy: 0.48 },
      { personKey: 'noam', owner: 'alex', cx: 0.62, cy: 0.5 },
    ],
    palette: { sky: '#8ec0d8', ground: '#c5d5c0', accent: '#e07a3d' },
  },
  {
    id: 'walls-2024',
    filename: 'IMG_20240616_094000.jpg',
    owners: ['alex'],
    shared: true,
    local: { y: 2024, m: 6, d: 16, h: 9, min: 40 },
    timeZone: 'Asia/Jerusalem',
    place: JERUSALEM,
    faces: [{ personKey: 'noam', owner: 'alex', cx: 0.5, cy: 0.47 }],
    palette: { sky: '#9bb7c9', ground: '#d7c4a3', accent: '#c4a574' },
  },
  {
    id: 'haifa-2025',
    filename: 'IMG_20250615_162000.jpg',
    owners: ['alex'],
    shared: true,
    local: { y: 2025, m: 6, d: 15, h: 16, min: 20 },
    timeZone: 'Asia/Jerusalem',
    place: HAIFA,
    favorite: true,
    faces: [{ personKey: 'maya', owner: 'alex', cx: 0.58, cy: 0.45 }],
    palette: { sky: '#6ea0c8', ground: '#7ea36b', accent: '#f4efe4' },
  },
  {
    id: 'morning-2022',
    filename: 'IMG_20221002_081500.jpg',
    owners: ['alex'],
    shared: false,
    local: { y: 2022, m: 10, d: 2, h: 8, min: 15 },
    timeZone: 'Asia/Jerusalem',
    place: JERUSALEM,
    faces: [],
    palette: { sky: '#d8c7a2', ground: '#b7a48a', accent: '#efe6d2' },
  },
  {
    id: 'recent-2026',
    filename: 'IMG_20261020_190500.jpg',
    owners: ['alex'],
    shared: false,
    local: { y: 2026, m: 10, d: 20, h: 19, min: 5 },
    timeZone: 'Asia/Jerusalem',
    place: TEL_AVIV,
    faces: [{ personKey: 'maya', owner: 'alex', cx: 0.48, cy: 0.5 }],
    palette: { sky: '#243044', ground: '#1e2a28', accent: '#f0d78c' },
  },
  {
    id: 'forward',
    filename: 'WhatsApp Image 2024-08-01.jpg',
    owners: ['alex', 'sam'],
    shared: false,
    local: { y: 2024, m: 8, d: 1, h: 21, min: 12 },
    timeZone: 'Asia/Jerusalem',
    faces: [{ personKey: 'maya', owner: 'alex', cx: 0.5, cy: 0.46 }],
    palette: { sky: '#2a3142', ground: '#3a332c', accent: '#d98b6a' },
  },
  {
    id: 'sam-port',
    filename: 'IMG_20240615_114000.jpg',
    owners: ['sam'],
    shared: true,
    local: { y: 2024, m: 6, d: 15, h: 11, min: 40 },
    timeZone: 'Asia/Jerusalem',
    place: { ...TEL_AVIV, latitude: 32.09, longitude: 34.77 },
    faces: [{ personKey: 'jordan', owner: 'sam', cx: 0.44, cy: 0.48 }],
    palette: { sky: '#79b4cf', ground: '#d9c7a1', accent: '#3d7a6a' },
  },
  {
    id: 'eilat',
    filename: 'IMG_20250112_140000.jpg',
    owners: ['sam'],
    shared: false,
    local: { y: 2025, m: 1, d: 12, h: 14, min: 0 },
    timeZone: 'Asia/Jerusalem',
    place: EILAT,
    faces: [{ personKey: 'jordan', owner: 'sam', cx: 0.63, cy: 0.5 }],
    palette: { sky: '#3f8f9d', ground: '#e8b86a', accent: '#ef6f4a' },
  },
  {
    id: 'haifa-sam',
    filename: 'IMG_20230615_184000.jpg',
    owners: ['sam'],
    shared: false,
    local: { y: 2023, m: 6, d: 15, h: 18, min: 40 },
    timeZone: 'Asia/Jerusalem',
    place: HAIFA,
    faces: [],
    palette: { sky: '#5b8eae', ground: '#6d8f62', accent: '#f2e7c9' },
  },
];

/** UTC instant for a wall-clock time in an IANA zone. */
export function localToUtc(parts: LocalParts, timeZone: string): Date {
  const utcGuess = Date.UTC(parts.y, parts.m - 1, parts.d, parts.h, parts.min, 0);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const asUtcFields = (instant: number) => {
    const map = Object.fromEntries(
      formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
    );
    return Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      Number(map.hour),
      Number(map.minute),
      Number(map.second),
    );
  };
  const offset = asUtcFields(utcGuess) - utcGuess;
  return new Date(utcGuess - offset);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function wallClock(parts: LocalParts): string {
  return `${parts.y}-${pad(parts.m)}-${pad(parts.d)} ${pad(parts.h)}:${pad(parts.min)}:00`;
}

function exifStamp(parts: LocalParts): string {
  return `${parts.y}:${pad(parts.m)}:${pad(parts.d)} ${pad(parts.h)}:${pad(parts.min)}:00`;
}

function faceGeometry(face: ShotFace): RenderedFace {
  const boxX = clamp01(face.cx - FACE_WIDTH / 2);
  const boxY = clamp01(face.cy - FACE_HEIGHT / 2);
  const boxWidth = Math.min(FACE_WIDTH, 1 - boxX);
  const boxHeight = Math.min(FACE_HEIGHT, 1 - boxY);
  const landmarks: [number, number][] = [
    [face.cx - 0.03, face.cy - 0.025],
    [face.cx + 0.03, face.cy - 0.025],
    [face.cx, face.cy + 0.015],
    [face.cx - 0.022, face.cy + 0.055],
    [face.cx + 0.022, face.cy + 0.055],
  ];
  return {
    personKey: face.personKey,
    owner: face.owner,
    boxX,
    boxY,
    boxWidth,
    boxHeight,
    landmarks: landmarks.map(([x, y]) => [clamp01(x), clamp01(y)]),
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Unit vector. Faces of one person sit near each other; different people do not. */
export function faceEmbedding(personKey: string, variant: number): number[] {
  const slot = Math.max(
    0,
    SAMPLE_PEOPLE.findIndex((person) => person.key === personKey),
  );
  const values = Array.from({ length: 512 }, (_, index) => {
    const cluster = index % 32 === slot ? 1 : 0;
    const wobble = Math.sin(slot * 19.1 + variant * 3.7 + index * 0.37) * 0.02;
    return cluster + wobble;
  });
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return values.map((value) => value / norm);
}

function scene(shot: SampleShot): string {
  const faces = shot.faces
    .map((face) => {
      const cx = face.cx * WIDTH;
      const cy = face.cy * HEIGHT;
      return `<ellipse cx="${cx}" cy="${cy}" rx="54" ry="72" fill="#f0c7a6"/>
        <circle cx="${cx - 16}" cy="${cy - 12}" r="4" fill="#2b241f"/>
        <circle cx="${cx + 16}" cy="${cy - 12}" r="4" fill="#2b241f"/>
        <path d="M ${cx - 14} ${cy + 22} Q ${cx} ${cy + 34} ${cx + 14} ${cy + 22}" fill="none" stroke="#a15b48" stroke-width="3"/>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${shot.palette.sky}"/>
  <rect y="${Math.round(HEIGHT * 0.62)}" width="${WIDTH}" height="${Math.round(HEIGHT * 0.38)}" fill="${shot.palette.ground}"/>
  <circle cx="${WIDTH - 140}" cy="110" r="42" fill="${shot.palette.accent}"/>
  ${faces}
</svg>`;
}

/** JPEG with an EXIF date (and GPS, when the shot has a place) embedded after the SOI. */
export async function renderSamplePhoto(shot: SampleShot): Promise<RenderedShot> {
  const jpeg = await sharp(Buffer.from(scene(shot)))
    .jpeg({ quality: 82 })
    .toBuffer();
  const capturedAt = localToUtc(shot.local, shot.timeZone);
  return {
    shot,
    bytes: injectExif(jpeg, buildExif(shot, capturedAt)),
    width: WIDTH,
    height: HEIGHT,
    capturedAt,
    wallClock: wallClock(shot.local),
    localDate: `${shot.local.y}-${pad(shot.local.m)}-${pad(shot.local.d)}`,
    faces: shot.faces.map(faceGeometry),
  };
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 };

interface Field {
  tag: number;
  type: number;
  count: number;
  data: Buffer;
}

function ascii(tag: number, value: string): Field {
  const data = Buffer.from(`${value}\0`, 'ascii');
  return { tag, type: 2, count: data.length, data };
}

function long(tag: number, value: number): Field {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(value, 0);
  return { tag, type: 4, count: 1, data };
}

function short(tag: number, value: number): Field {
  const data = Buffer.alloc(2);
  data.writeUInt16LE(value, 0);
  return { tag, type: 3, count: 1, data };
}

function rationals(tag: number, parts: Array<[number, number]>): Field {
  const data = Buffer.alloc(parts.length * 8);
  parts.forEach(([numerator, denominator], index) => {
    data.writeUInt32LE(numerator, index * 8);
    data.writeUInt32LE(denominator, index * 8 + 4);
  });
  return { tag, type: 5, count: parts.length, data };
}

function measure(fields: Field[]): number {
  let extra = 0;
  for (const field of fields) {
    const bytes = (TYPE_SIZE[field.type] ?? 1) * field.count;
    if (bytes > 4) extra += bytes;
  }
  return 2 + fields.length * 12 + 4 + extra;
}

function writeIfd(fields: Field[], base: number): Buffer {
  const sorted = [...fields].sort((a, b) => a.tag - b.tag);
  const table = 2 + sorted.length * 12 + 4;
  let extra = 0;
  const entries: Buffer[] = [];
  const overflow: Buffer[] = [];
  for (const field of sorted) {
    const bytes = (TYPE_SIZE[field.type] ?? 1) * field.count;
    if (field.data.length !== bytes) {
      throw new Error(`EXIF tag ${field.tag} has ${field.data.length} bytes, expected ${bytes}`);
    }
    const entry = Buffer.alloc(12);
    entry.writeUInt16LE(field.tag, 0);
    entry.writeUInt16LE(field.type, 2);
    entry.writeUInt32LE(field.count, 4);
    if (bytes <= 4) field.data.copy(entry, 8);
    else {
      entry.writeUInt32LE(base + table + extra, 8);
      overflow.push(field.data);
      extra += bytes;
    }
    entries.push(entry);
  }
  const count = Buffer.alloc(2);
  count.writeUInt16LE(sorted.length, 0);
  return Buffer.concat([count, ...entries, Buffer.alloc(4), ...overflow]);
}

function toDms(decimal: number): [[number, number], [number, number], [number, number]] {
  const absolute = Math.abs(decimal);
  let degrees = Math.floor(absolute);
  let minutes = Math.floor((absolute - degrees) * 60);
  let secondsHundredths = Math.round(((absolute - degrees) * 60 - minutes) * 60 * 100);
  if (secondsHundredths === 6000) {
    secondsHundredths = 0;
    minutes += 1;
  }
  if (minutes === 60) {
    minutes = 0;
    degrees += 1;
  }
  return [
    [degrees, 1],
    [minutes, 1],
    [secondsHundredths, 100],
  ];
}

function buildExif(shot: SampleShot, capturedAt: Date): Buffer {
  const stamp = exifStamp(shot.local);
  const localAsUtc = Date.UTC(
    shot.local.y,
    shot.local.m - 1,
    shot.local.d,
    shot.local.h,
    shot.local.min,
    0,
  );
  const offsetMin = Math.round((localAsUtc - capturedAt.getTime()) / 60_000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;

  const exifFields: Field[] = [ascii(0x9003, stamp), ascii(0x9004, stamp), ascii(0x9011, offset)];
  const gpsFields: Field[] = [];
  if (shot.place) {
    gpsFields.push(
      { tag: 0x0000, type: 1, count: 4, data: Buffer.from([2, 3, 0, 0]) },
      ascii(0x0001, shot.place.latitude >= 0 ? 'N' : 'S'),
      rationals(0x0002, toDms(shot.place.latitude)),
      ascii(0x0003, shot.place.longitude >= 0 ? 'E' : 'W'),
      rationals(0x0004, toDms(shot.place.longitude)),
    );
  }

  const ifd0Base: Field[] = [
    ascii(0x010e, shot.place?.city ?? 'Sample'),
    ascii(0x010f, 'NGP'),
    ascii(0x0110, 'Seed'),
    short(0x0112, 1),
    ascii(0x0131, 'Not Google Photos seed'),
    ascii(0x0132, stamp),
  ];
  const ifd0Size = measure(ifd0Base) + 12 + (gpsFields.length ? 12 : 0);
  const exifAt = 8 + ifd0Size;
  const gpsAt = exifAt + measure(exifFields);
  const ifd0: Field[] = [...ifd0Base, long(0x8769, exifAt)];
  if (gpsFields.length) ifd0.push(long(0x8825, gpsAt));

  const header = Buffer.alloc(8);
  header.write('II', 0, 'ascii');
  header.writeUInt16LE(42, 2);
  header.writeUInt32LE(8, 4);
  return Buffer.concat([
    header,
    writeIfd(ifd0, 8),
    writeIfd(exifFields, exifAt),
    gpsFields.length ? writeIfd(gpsFields, gpsAt) : Buffer.alloc(0),
  ]);
}

function injectExif(jpeg: Buffer, tiff: Buffer): Buffer {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('sharp did not return a JPEG');
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const segment = Buffer.alloc(4 + payload.length);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment.writeUInt16BE(payload.length + 2, 2);
  payload.copy(segment, 4);
  return Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)]);
}
