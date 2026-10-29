import { EARTH_METERS, latitudeOf, toMercator, type Basemap, type MapShape } from '@/map/geometry';

export interface MapPhoto {
  id: string;
  latitude: number;
  longitude: number;
}

interface View {
  centerX: number;
  centerY: number;
  scale: number;
}

interface Cluster {
  x: number;
  y: number;
  count: number;
  radius: number;
  ids: string[];
}

interface Palette {
  ocean: string;
  oceanDeep: string;
  land: string;
  coast: string;
  border: string;
  cluster: string;
  clusterText: string;
  ring: string;
  ink: string;
  chip: string;
}

interface PointerPoint {
  x: number;
  y: number;
}

const CLUSTER_CELL = 52;
/** Closest a pinch or the + button can get: about a neighborhood, not a street. */
const MIN_VIEW_METERS = 1_200;
/** A lone photo still opens on the surrounding area, not an empty patch of color. */
const MIN_SPAN = 0.0016;

/**
 * Pan and zoom over a local coastline. Screen math stays in CSS pixels;
 * the canvas buffer is scaled for the display.
 */
export class PhotoMap {
  private readonly context: CanvasRenderingContext2D;
  private readonly points: Array<MapPhoto & { x: number; y: number }>;
  private view: View = { centerX: 0.5, centerY: 0.42, scale: 1 };
  private width = 0;
  private height = 0;
  private ratio = 1;
  private clusters: Cluster[] = [];
  private colors: Palette | null = null;
  private frame = 0;
  private motion = 0;
  private disposed = false;
  private velocityX = 0;
  private velocityY = 0;
  private pointers = new Map<number, PointerPoint>();
  private drag: { id: number; x: number; y: number; moved: boolean; lastT: number } | null = null;
  private pinch: (PointerPoint & { distance: number }) | null = null;
  private gestureMoved = false;
  private tapTimer = 0;
  private lastTap = { x: 0, y: 0, time: 0 };
  private canZoomIn = true;
  private canZoomOut = true;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly surface: HTMLElement,
    private readonly basemap: Basemap,
    points: readonly MapPhoto[],
    private readonly onOpen: (ids: string[]) => void,
    private readonly onLimits: (limits: { zoomIn: boolean; zoomOut: boolean }) => void,
  ) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not draw the map');
    this.context = context;
    this.points = points.map((point) => {
      const [x, y] = toMercator(point.longitude, point.latitude);
      return { ...point, x, y };
    });
    this.surface.addEventListener('wheel', this.onWheel, { passive: false });
    this.surface.addEventListener('pointerdown', this.onPointerDown);
    this.surface.addEventListener('pointermove', this.onPointerMove);
    this.surface.addEventListener('pointerup', this.onPointerUp);
    this.surface.addEventListener('pointercancel', this.onPointerUp);
    this.surface.addEventListener('contextmenu', this.onContextMenu);
    this.resizeObserver.observe(canvas);
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    this.resize();
  }

  destroy(): void {
    this.disposed = true;
    this.motion += 1;
    window.clearTimeout(this.tapTimer);
    if (this.frame) cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.themeObserver.disconnect();
    this.surface.removeEventListener('wheel', this.onWheel);
    this.surface.removeEventListener('pointerdown', this.onPointerDown);
    this.surface.removeEventListener('pointermove', this.onPointerMove);
    this.surface.removeEventListener('pointerup', this.onPointerUp);
    this.surface.removeEventListener('pointercancel', this.onPointerUp);
    this.surface.removeEventListener('contextmenu', this.onContextMenu);
  }

  zoomIn(): void {
    this.animateZoom(this.width / 2, this.height / 2, 1.8);
  }

  zoomOut(): void {
    this.animateZoom(this.width / 2, this.height / 2, 1 / 1.8);
  }

  showPhotos(): void {
    this.animateTo(this.photoFrame());
  }

  onKey(event: { key: string; preventDefault: () => void }): void {
    const step = Math.min(this.width, this.height) * 0.18;
    if (event.key === 'ArrowLeft') this.nudge(step, 0);
    else if (event.key === 'ArrowRight') this.nudge(-step, 0);
    else if (event.key === 'ArrowUp') this.nudge(0, step);
    else if (event.key === 'ArrowDown') this.nudge(0, -step);
    else if (event.key === '+' || event.key === '=') this.zoomIn();
    else if (event.key === '-' || event.key === '_') this.zoomOut();
    else if (event.key === '0' || event.key === 'Home') this.showPhotos();
    else if (event.key === ' ') event.preventDefault();
    else return;
    event.preventDefault();
  }

  private readonly resizeObserver = new ResizeObserver(() => this.resize());

  private readonly themeObserver = new MutationObserver(() => {
    this.colors = null;
    this.requestDraw();
  });

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const bufferWidth = Math.floor(rect.width * ratio);
    const bufferHeight = Math.floor(rect.height * ratio);
    if (this.canvas.width !== bufferWidth || this.canvas.height !== bufferHeight) {
      this.canvas.width = bufferWidth;
      this.canvas.height = bufferHeight;
    }
    const first = this.width === 0;
    this.width = rect.width;
    this.height = rect.height;
    this.ratio = ratio;
    if (first) this.fit(false);
    else this.drawNow();
  }

  private nudge(dx: number, dy: number): void {
    this.stopMotion();
    this.view.centerX -= dx / this.view.scale;
    this.view.centerY -= dy / this.view.scale;
    this.clamp();
    this.requestDraw();
  }

  private fit(animate: boolean): void {
    const target = this.photoFrame();
    if (animate) this.animateTo(target);
    else {
      this.view = target;
      this.clamp();
      this.drawNow();
    }
  }

  private photoFrame(): View {
    const { width, height } = this;
    if (this.points.length === 0 || width < 2 || height < 2) {
      return { centerX: 0.5, centerY: 0.42, scale: this.minScale() };
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of this.points) {
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const spanX = Math.max(maxX - minX, MIN_SPAN);
    const spanY = Math.max(maxY - minY, MIN_SPAN);
    const scale = Math.min(width / (spanX * 1.7), height / (spanY * 1.7));
    return { centerX, centerY, scale: this.clampScale(scale, centerY) };
  }

  private animateTo(target: View): void {
    this.stopMotion();
    const token = this.motion;
    const start = { ...this.view };
    let deltaX = target.centerX - start.centerX;
    if (deltaX > 0.5) deltaX -= 1;
    if (deltaX < -0.5) deltaX += 1;
    const started = performance.now();
    const step = (now: number) => {
      if (token !== this.motion || this.disposed) return;
      const t = Math.min(1, (now - started) / 260);
      const eased = 1 - (1 - t) ** 3;
      const logScale =
        Math.log(start.scale) + (Math.log(target.scale) - Math.log(start.scale)) * eased;
      this.view.scale = Math.exp(logScale);
      this.view.centerX = start.centerX + deltaX * eased;
      this.view.centerY = start.centerY + (target.centerY - start.centerY) * eased;
      this.clamp();
      this.drawNow();
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  private animateZoom(sx: number, sy: number, factor: number): void {
    this.animateTo(this.zoomed(sx, sy, factor));
  }

  private zoomed(sx: number, sy: number, factor: number): View {
    const scale = this.clampScale(this.view.scale * factor, this.view.centerY);
    const worldX = this.view.centerX + (sx - this.width / 2) / this.view.scale;
    const worldY = this.view.centerY + (sy - this.height / 2) / this.view.scale;
    return {
      scale,
      centerX: worldX - (sx - this.width / 2) / scale,
      centerY: worldY - (sy - this.height / 2) / scale,
    };
  }

  private applyZoom(sx: number, sy: number, factor: number): void {
    this.view = this.zoomed(sx, sy, factor);
    this.clamp();
    this.requestDraw();
  }

  private minScale(): number {
    return Math.min(this.width, this.height) * 0.92;
  }

  private maxScale(centerY: number): number {
    const latitude = (latitudeOf(centerY) * Math.PI) / 180;
    const cos = Math.max(0.2, Math.cos(latitude));
    return (cos * EARTH_METERS * Math.max(this.width, 1)) / MIN_VIEW_METERS;
  }

  private clampScale(scale: number, centerY: number): number {
    return Math.min(this.maxScale(centerY), Math.max(this.minScale(), scale));
  }

  private clamp(): void {
    this.view.scale = this.clampScale(this.view.scale, this.view.centerY);
    const padY = (this.height * 0.4) / this.view.scale;
    this.view.centerY = Math.min(1 + padY, Math.max(-padY, this.view.centerY));
    this.view.centerX = wrap(this.view.centerX);
  }

  private stopMotion(): void {
    this.motion += 1;
    this.velocityX = 0;
    this.velocityY = 0;
  }

  private requestDraw(): void {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private drawNow(): void {
    if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    this.draw();
  }

  private draw(): void {
    if (this.disposed || this.width < 2 || this.height < 2) return;
    const context = this.context;
    const colors = this.palette();
    context.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    const gradient = context.createLinearGradient(0, 0, 0, this.height);
    gradient.addColorStop(0, colors.ocean);
    gradient.addColorStop(1, colors.oceanDeep);
    context.fillStyle = gradient;
    context.fillRect(0, 0, this.width, this.height);
    context.lineJoin = 'round';
    context.lineCap = 'round';
    this.drawLand(colors);
    this.drawBorders(colors);
    this.drawPhotos(colors);
    this.drawScale(colors);
    this.reportLimits();
  }

  private drawLand(colors: Palette): void {
    const context = this.context;
    const coast = Math.min(1.75, 0.65 + this.view.scale / 14_000);
    for (const offset of this.worldOffsets()) {
      context.beginPath();
      let drew = false;
      for (const shape of this.basemap.land) {
        if (!this.visible(shape, offset) || this.tiny(shape)) continue;
        for (const ring of shape.rings) {
          if (this.trace(ring, offset, true)) drew = true;
        }
      }
      if (!drew) continue;
      context.fillStyle = colors.land;
      context.fill('evenodd');
      context.lineWidth = coast;
      context.strokeStyle = colors.coast;
      context.stroke();
    }
  }

  private drawBorders(colors: Palette): void {
    const context = this.context;
    context.beginPath();
    let drew = false;
    for (const offset of this.worldOffsets()) {
      for (const shape of this.basemap.borders) {
        if (!this.visible(shape, offset) || this.tiny(shape)) continue;
        for (const ring of shape.rings) {
          if (this.trace(ring, offset, false)) drew = true;
        }
      }
    }
    if (!drew) return;
    context.lineWidth = 1.15;
    context.strokeStyle = colors.border;
    context.stroke();
  }

  private trace(ring: Array<[number, number]>, offset: number, closed: boolean): boolean {
    const context = this.context;
    let started = false;
    let previousX = 0;
    let previousY = 0;
    const last = ring.length - 1;
    for (let index = 0; index < ring.length; index += 1) {
      const point = ring[index];
      if (!point) continue;
      const [x, y] = this.screen(point[0] + offset, point[1]);
      const end = index === last;
      if (started && !end && Math.abs(x - previousX) < 0.8 && Math.abs(y - previousY) < 0.8)
        continue;
      if (!started) context.moveTo(x, y);
      else context.lineTo(x, y);
      started = true;
      previousX = x;
      previousY = y;
    }
    if (!started) return false;
    if (closed) context.closePath();
    return true;
  }

  private drawPhotos(colors: Palette): void {
    const groups = new Map<string, Cluster>();
    const margin = CLUSTER_CELL;
    for (const point of this.points) {
      const [x, y] = this.screen(wrapNear(point.x, this.view.centerX), point.y);
      if (x < -margin || x > this.width + margin || y < -margin || y > this.height + margin)
        continue;
      const key = `${Math.floor(x / CLUSTER_CELL)}:${Math.floor(y / CLUSTER_CELL)}`;
      const group = groups.get(key);
      if (!group) {
        groups.set(key, { x, y, count: 1, radius: 0, ids: [point.id] });
        continue;
      }
      group.count += 1;
      group.x = (group.x * (group.count - 1) + x) / group.count;
      group.y = (group.y * (group.count - 1) + y) / group.count;
      group.ids.push(point.id);
    }
    const clusters = mergeClusters([...groups.values()]);
    clusters.sort((a, b) => b.count - a.count);
    this.clusters = clusters;

    const context = this.context;
    context.beginPath();
    for (const group of clusters) {
      context.moveTo(group.x + group.radius, group.y + 1.5);
      context.arc(group.x, group.y + 1.5, group.radius, 0, Math.PI * 2);
    }
    context.fillStyle = 'rgb(0 0 0 / 0.28)';
    context.fill();

    context.beginPath();
    for (const group of clusters) {
      context.moveTo(group.x + group.radius, group.y);
      context.arc(group.x, group.y, group.radius, 0, Math.PI * 2);
    }
    context.fillStyle = colors.cluster;
    context.fill();
    context.lineWidth = 2.5;
    context.strokeStyle = colors.ring;
    context.stroke();

    context.fillStyle = colors.clusterText;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    for (const group of clusters) {
      if (group.count < 2) continue;
      context.font = `600 ${group.count > 99 ? 11 : 12}px "Source Sans 3", sans-serif`;
      context.fillText(countLabel(group.count), group.x, group.y + 0.5);
    }
  }

  private drawScale(colors: Palette): void {
    const latitude = (latitudeOf(this.view.centerY) * Math.PI) / 180;
    const metersPerPixel = (Math.cos(latitude) * EARTH_METERS) / this.view.scale;
    const target = Math.min(132, this.width * 0.34);
    const meters = niceDistance(metersPerPixel * target);
    const pixels = meters / metersPerPixel;
    if (!Number.isFinite(pixels) || pixels < 24) return;
    const label = distanceLabel(meters);
    const x = 16;
    const y = this.height - 18;
    const context = this.context;
    context.font = '600 12px "Source Sans 3", sans-serif';
    const textWidth = context.measureText(label).width;
    const inner = Math.max(pixels, textWidth);
    const lineX = x + (inner - pixels) / 2;
    context.fillStyle = colors.chip;
    roundRect(context, x - 8, y - 28, inner + 16, 38, 8);
    context.fill();
    context.strokeStyle = colors.ink;
    context.fillStyle = colors.ink;
    context.lineWidth = 1.5;
    context.lineCap = 'butt';
    context.beginPath();
    context.moveTo(lineX, y);
    context.lineTo(lineX + pixels, y);
    context.moveTo(lineX, y - 5);
    context.lineTo(lineX, y + 5);
    context.moveTo(lineX + pixels, y - 5);
    context.lineTo(lineX + pixels, y + 5);
    context.stroke();
    context.textAlign = 'center';
    context.textBaseline = 'bottom';
    context.fillText(label, x + inner / 2, y - 7);
    context.lineCap = 'round';
  }

  private palette(): Palette {
    if (this.colors) return this.colors;
    const style = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string) =>
      style.getPropertyValue(name).trim() || fallback;
    this.colors = {
      ocean: read('--map-ocean', '#17323c'),
      oceanDeep: read('--map-ocean-deep', '#10262e'),
      land: read('--map-land', '#5d6e58'),
      coast: read('--map-coast', 'rgb(232 238 226 / 0.7)'),
      border: read('--map-border', 'rgb(232 224 206 / 0.45)'),
      cluster: read('--primary', '#3d9a6e'),
      clusterText: read('--primary-foreground', '#f4f7f2'),
      ring: read('--map-ring', '#f7f4ee'),
      ink: read('--foreground', '#f3efe6'),
      chip: read('--card', '#221f1b'),
    };
    return this.colors;
  }

  private screen(mercatorX: number, mercatorY: number): [number, number] {
    return [
      (mercatorX - this.view.centerX) * this.view.scale + this.width / 2,
      (mercatorY - this.view.centerY) * this.view.scale + this.height / 2,
    ];
  }

  private worldOffsets(): number[] {
    const half = this.width / 2 / this.view.scale;
    const start = Math.floor(this.view.centerX - half);
    const end = Math.floor(this.view.centerX + half);
    const offsets: number[] = [];
    for (let offset = start; offset <= end; offset += 1) offsets.push(offset);
    return offsets.length > 0 ? offsets : [0];
  }

  private visible(shape: MapShape, offset: number): boolean {
    const [x0, y0] = this.screen(shape.minX + offset, shape.minY);
    const [x1, y1] = this.screen(shape.maxX + offset, shape.maxY);
    const left = Math.min(x0, x1);
    const right = Math.max(x0, x1);
    const top = Math.min(y0, y1);
    const bottom = Math.max(y0, y1);
    return right >= -2 && left <= this.width + 2 && bottom >= -2 && top <= this.height + 2;
  }

  private tiny(shape: MapShape): boolean {
    const width = (shape.maxX - shape.minX) * this.view.scale;
    const height = (shape.maxY - shape.minY) * this.view.scale;
    return width < 1.2 && height < 1.2;
  }

  private reportLimits(): void {
    const zoomIn = this.view.scale < this.maxScale(this.view.centerY) * 0.98;
    const zoomOut = this.view.scale > this.minScale() * 1.02;
    if (zoomIn === this.canZoomIn && zoomOut === this.canZoomOut) return;
    this.canZoomIn = zoomIn;
    this.canZoomOut = zoomOut;
    if (!this.disposed) this.onLimits({ zoomIn, zoomOut });
  }

  private local(event: { clientX: number; clientY: number }): PointerPoint {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private readonly onContextMenu = (event: Event) => {
    event.preventDefault();
  };

  private readonly onWheel = (event: WheelEvent) => {
    event.preventDefault();
    this.stopMotion();
    window.clearTimeout(this.tapTimer);
    const point = this.local(event);
    let delta = event.deltaY;
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
    if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= this.height;
    const factor = Math.exp(-delta * (event.ctrlKey ? 0.012 : 0.0053));
    this.applyZoom(point.x, point.y, factor);
  };

  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    this.stopMotion();
    if (event.target instanceof Element && event.target.closest('button')) return;
    this.surface.setPointerCapture(event.pointerId);
    const point = this.local(event);
    this.pointers.set(event.pointerId, point);
    if (this.pointers.size === 1) {
      this.gestureMoved = false;
      this.drag = {
        id: event.pointerId,
        x: point.x,
        y: point.y,
        moved: false,
        lastT: performance.now(),
      };
      this.pinch = null;
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    this.drag = null;
    this.pinch = this.pinchGesture();
    this.gestureMoved = true;
    window.clearTimeout(this.tapTimer);
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    const point = this.local(event);
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.set(event.pointerId, point);
    if (this.pointers.size >= 2) {
      const next = this.pinchGesture();
      if (!next || !this.pinch || this.pinch.distance === 0) return;
      this.view.centerX -= (next.x - this.pinch.x) / this.view.scale;
      this.view.centerY -= (next.y - this.pinch.y) / this.view.scale;
      this.view = this.zoomed(next.x, next.y, next.distance / this.pinch.distance);
      this.clamp();
      this.pinch = next;
      this.gestureMoved = true;
      this.requestDraw();
      return;
    }
    if (!this.drag || this.drag.id !== event.pointerId) return;
    const dx = point.x - this.drag.x;
    const dy = point.y - this.drag.y;
    if (!this.drag.moved && Math.hypot(dx, dy) > 5) {
      this.drag.moved = true;
      this.gestureMoved = true;
      window.clearTimeout(this.tapTimer);
    }
    if (!this.drag.moved) return;
    this.view.centerX -= dx / this.view.scale;
    this.view.centerY -= dy / this.view.scale;
    this.clamp();
    const now = performance.now();
    const dt = now - this.drag.lastT;
    if (dt > 0 && dt < 48) {
      this.velocityX = dx / dt;
      this.velocityY = dy / dt;
    }
    this.drag.x = point.x;
    this.drag.y = point.y;
    this.drag.lastT = now;
    this.requestDraw();
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    const point = this.local(event);
    this.pointers.delete(event.pointerId);
    if (this.pointers.size >= 2) {
      this.pinch = this.pinchGesture();
      return;
    }
    this.pinch = null;
    if (this.pointers.size === 1) {
      const remaining = this.pointers.entries().next().value;
      if (!remaining) return;
      const [id, at] = remaining;
      this.drag = { id, x: at.x, y: at.y, moved: true, lastT: performance.now() };
      this.gestureMoved = true;
      return;
    }
    const tapped = this.drag?.id === event.pointerId && !this.drag.moved && !this.gestureMoved;
    this.drag = null;
    this.canvas.style.cursor = '';
    if (tapped) this.noteTap(point.x, point.y);
    else if (Math.hypot(this.velocityX, this.velocityY) > 0.05) this.glide();
  };

  private pinchGesture(): (PointerPoint & { distance: number }) | null {
    const points = [...this.pointers.values()];
    const a = points[0];
    const b = points[1];
    if (!a || !b) return null;
    return {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    };
  }

  private noteTap(x: number, y: number): void {
    const now = performance.now();
    if (now - this.lastTap.time < 280 && Math.hypot(x - this.lastTap.x, y - this.lastTap.y) < 28) {
      window.clearTimeout(this.tapTimer);
      this.lastTap.time = 0;
      this.animateZoom(x, y, 2);
      return;
    }
    this.lastTap = { x, y, time: now };
    window.clearTimeout(this.tapTimer);
    this.tapTimer = window.setTimeout(() => this.openAt(x, y), 260);
  }

  private openAt(x: number, y: number): void {
    let nearest: Cluster | null = null;
    let best = Infinity;
    for (const group of this.clusters) {
      const distance = Math.hypot(group.x - x, group.y - y);
      const reach = Math.max(group.radius + 8, 22);
      if (distance <= reach && distance < best) {
        best = distance;
        nearest = group;
      }
    }
    if (!nearest || nearest.ids.length === 0) return;
    this.onOpen(nearest.ids);
  }

  private glide(): void {
    const token = this.motion;
    let last = performance.now();
    const step = (now: number) => {
      if (token !== this.motion || this.disposed) return;
      const dt = Math.min(34, now - last);
      last = now;
      this.view.centerX -= (this.velocityX * dt) / this.view.scale;
      this.view.centerY -= (this.velocityY * dt) / this.view.scale;
      const decay = 0.9 ** (dt / 16);
      this.velocityX *= decay;
      this.velocityY *= decay;
      this.clamp();
      this.drawNow();
      if (Math.hypot(this.velocityX, this.velocityY) > 0.02) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

function wrap(value: number): number {
  return ((value % 1) + 1) % 1;
}

function wrapNear(value: number, center: number): number {
  let next = value;
  const delta = next - center;
  if (delta > 0.5) next -= 1;
  else if (delta < -0.5) next += 1;
  return next;
}

function clusterRadius(count: number): number {
  if (count === 1) return 7;
  return Math.min(28, 13 + Math.log2(count) * 2.6);
}

/** Grid cells can sit on top of each other. Fold those into one bubble so the count stays readable. */
function mergeClusters(groups: Cluster[]): Cluster[] {
  const list = groups.map((group) => ({ ...group, radius: clusterRadius(group.count) }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < list.length; i += 1) {
      const left = list[i];
      if (!left) continue;
      for (let j = i + 1; j < list.length; j += 1) {
        const right = list[j];
        if (!right) continue;
        const distance = Math.hypot(left.x - right.x, left.y - right.y);
        if (distance >= left.radius + right.radius - 2) continue;
        const count = left.count + right.count;
        list[i] = {
          x: (left.x * left.count + right.x * right.count) / count,
          y: (left.y * left.count + right.y * right.count) / count,
          count,
          radius: clusterRadius(count),
          ids: left.ids.concat(right.ids),
        };
        list.splice(j, 1);
        merged = true;
        break;
      }
      if (merged) break;
    }
  }
  return list;
}

function countLabel(count: number): string {
  if (count < 1000) return String(count);
  const thousands = count / 1000;
  const rounded = thousands >= 10 ? String(Math.round(thousands)) : thousands.toFixed(1);
  return `${rounded.replace(/\.0$/, '')}k`;
}

function niceDistance(meters: number): number {
  if (!Number.isFinite(meters) || meters <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(meters));
  const fraction = meters / power;
  const step = fraction >= 5 ? 5 : fraction >= 2 ? 2 : 1;
  return step * power;
}

function distanceLabel(meters: number): string {
  if (meters >= 1000) {
    const kilometers = meters / 1000;
    const text = kilometers >= 10 ? String(Math.round(kilometers)) : String(kilometers);
    return `${text} km`;
  }
  return `${Math.round(meters)} m`;
}

function roundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}
