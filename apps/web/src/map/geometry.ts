import bordersUrl from './borders.json?url';
import landUrl from './land.json?url';

/** Equatorial circumference, used to turn a zoom level into a ground distance. */
export const EARTH_METERS = 40_075_017;

const MAX_LAT = 85.05112878;

export interface MapShape {
  rings: Array<Array<[number, number]>>;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Basemap {
  land: MapShape[];
  borders: MapShape[];
}

type Position = [number, number];

/** Web Mercator in the 0–1 square. Longitude may sit outside that after wrapping. */
export function toMercator(longitude: number, latitude: number): Position {
  const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, latitude));
  const x = (longitude + 180) / 360;
  const radians = (lat * Math.PI) / 180;
  const y = (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2;
  return [x, y];
}

export function latitudeOf(mercatorY: number): number {
  const y = Math.max(0, Math.min(1, mercatorY));
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}

/**
 * Coastline and country borders shipped with the app.
 * Photo locations stay on this machine; the map never asks a tile server.
 */
export async function loadBasemap(): Promise<Basemap> {
  const [landFile, borderFile] = await Promise.all([fetchJson(landUrl), fetchJson(bordersUrl)]);
  const land = shapesFromPolygons(landFile);
  if (land.length === 0) throw new Error('Could not load the map');
  return { land, borders: shapesFromLines(borderFile) };
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Could not load the map');
  return JSON.parse(await response.text()) as unknown;
}

function shapesFromPolygons(file: unknown): MapShape[] {
  const shapes: MapShape[] = [];
  for (const geometry of geometries(file)) {
    for (const rings of readPolygons(geometry.type, geometry.coordinates)) {
      const shape = shapeFrom(rings);
      if (shape) shapes.push(shape);
    }
  }
  return shapes;
}

function shapesFromLines(file: unknown): MapShape[] {
  const shapes: MapShape[] = [];
  for (const geometry of geometries(file)) {
    for (const line of readLines(geometry.type, geometry.coordinates)) {
      const shape = shapeFrom([line]);
      if (shape) shapes.push(shape);
    }
  }
  return shapes;
}

function geometries(value: unknown): Array<{ type: string; coordinates: unknown }> {
  if (!isRecord(value) || !isUnknownArray(value.features)) return [];
  const list: Array<{ type: string; coordinates: unknown }> = [];
  for (const feature of value.features) {
    if (!isRecord(feature) || !isRecord(feature.geometry)) continue;
    const { type, coordinates } = feature.geometry;
    if (typeof type !== 'string') continue;
    list.push({ type, coordinates });
  }
  return list;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function readPolygons(type: string, coordinates: unknown): Position[][][] {
  if (type === 'Polygon') {
    const rings = readRings(coordinates);
    return rings.length > 0 ? [rings] : [];
  }
  if (type !== 'MultiPolygon' || !isUnknownArray(coordinates)) return [];
  const polygons: Position[][][] = [];
  for (const polygon of coordinates) {
    const rings = readRings(polygon);
    if (rings.length > 0) polygons.push(rings);
  }
  return polygons;
}

function readLines(type: string, coordinates: unknown): Position[][] {
  if (type === 'LineString') {
    const line = readLine(coordinates);
    return line.length > 1 ? [line] : [];
  }
  if (type !== 'MultiLineString' || !isUnknownArray(coordinates)) return [];
  return coordinates.flatMap((line) => {
    const points = readLine(line);
    return points.length > 1 ? [points] : [];
  });
}

function readRings(value: unknown): Position[][] {
  if (!isUnknownArray(value)) return [];
  const rings: Position[][] = [];
  for (const ring of value) {
    const line = readLine(ring);
    if (line.length > 1) rings.push(line);
  }
  return rings;
}

function readLine(value: unknown): Position[] {
  if (!isUnknownArray(value)) return [];
  const points: Position[] = [];
  for (const coord of value) {
    if (!isUnknownArray(coord)) continue;
    const longitude = coord[0];
    const latitude = coord[1];
    if (typeof longitude !== 'number' || typeof latitude !== 'number') continue;
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;
    points.push(toMercator(longitude, latitude));
  }
  return points;
}

function shapeFrom(rings: Position[][]): MapShape | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { rings, minX, minY, maxX, maxY };
}
