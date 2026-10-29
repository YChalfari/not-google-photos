import cityData from './cities.json' with { type: 'json' };

/**
 * Offline nearest-city lookup. The list is GeoNames cities with population over 15,000
 * (https://download.geonames.org/export/dump/cities15000.zip), compiled into cities.json.
 * A lookup never uses the network.
 */
export const PLACE_RADIUS_METERS = 50_000;

export interface Place {
  city: string;
  region: string | null;
  country: string;
  countryCode: string;
}

interface CityFile {
  countries: string[];
  codes: string[];
  regions: string[];
  /** name, country index, region index (-1 when unknown), latitude, longitude. */
  cities: Array<[string, number, number, number, number]>;
}

const data = cityData as CityFile;
const buckets = new Map<string, number[]>();

for (let index = 0; index < data.cities.length; index += 1) {
  const city = data.cities[index];
  if (!city) continue;
  const key = cellKey(Math.floor(city[3]), Math.floor(city[4]));
  const bucket = buckets.get(key);
  if (bucket) bucket.push(index);
  else buckets.set(key, [index]);
}

function cellKey(latCell: number, lonCell: number): string {
  return `${latCell}:${lonCell}`;
}

function wrapLonCell(cell: number): number {
  let value = cell;
  while (value >= 180) value -= 360;
  while (value < -180) value += 360;
  return value;
}

function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Nearest city within {@link PLACE_RADIUS_METERS}, or null when nothing is that close. */
export function nearestPlace(latitude: number, longitude: number): Place | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const latCell = Math.floor(latitude);
  const lonCell = Math.floor(longitude);
  const metersPerDegree = Math.max(111_320 * Math.cos((Math.abs(latitude) * Math.PI) / 180), 1);
  const span = Math.min(40, Math.ceil(PLACE_RADIUS_METERS / metersPerDegree) + 1);
  let best: { index: number; distance: number } | undefined;
  const seen = new Set<string>();
  for (let dLat = -1; dLat <= 1; dLat += 1) {
    for (let dLon = -span; dLon <= span; dLon += 1) {
      const key = cellKey(latCell + dLat, wrapLonCell(lonCell + dLon));
      if (seen.has(key)) continue;
      seen.add(key);
      const indexes = buckets.get(key);
      if (!indexes) continue;
      for (const index of indexes) {
        const city = data.cities[index];
        if (!city) continue;
        const distance = distanceMeters(latitude, longitude, city[3], city[4]);
        if (!best || distance < best.distance) best = { index, distance };
      }
    }
  }
  if (!best || best.distance > PLACE_RADIUS_METERS) return null;
  const city = data.cities[best.index];
  if (!city) return null;
  const country = data.countries[city[1]];
  const countryCode = data.codes[city[1]];
  if (!country || !countryCode) return null;
  const region = city[2] >= 0 ? (data.regions[city[2]] ?? null) : null;
  return { city: city[0], region, country, countryCode };
}
