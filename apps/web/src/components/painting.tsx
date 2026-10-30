import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

const LINEN = '#f4efe4';
const DRAW_MS = 14000;
const HOLD_MS = 2000;
const ERASE_MS = 3200;
const REST_MS = 1000;
const CYCLE_MS = DRAW_MS + HOLD_MS + ERASE_MS + REST_MS;

type Point = readonly [number, number];

type Mark = {
  color: string;
  alpha?: number;
  weight?: number;
} & (
  | { kind: 'stroke'; width: number; points: readonly Point[]; smooth?: boolean }
  | { kind: 'fill'; points: readonly Point[]; smooth?: boolean; wash?: boolean; ground?: boolean }
  | { kind: 'dot'; x: number; y: number; r: number }
);

function oval(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  from: number,
  to: number,
  steps = 24,
): Point[] {
  const points: Point[] = [];
  for (let step = 0; step <= steps; step += 1) {
    const angle = from + ((to - from) * step) / steps;
    points.push([cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry]);
  }
  return points;
}

/** Hills, a house, and a tree. */
const HILLS: readonly Mark[] = [
  {
    kind: 'fill',
    color: '#8eb8c9',
    points: [
      [0, 0],
      [1, 0],
      [1, 0.58],
      [0, 0.58],
    ],
  },
  {
    kind: 'fill',
    color: '#e4d2ae',
    alpha: 0.75,
    points: [
      [0, 0.4],
      [1, 0.4],
      [1, 0.6],
      [0, 0.6],
    ],
  },
  { kind: 'dot', color: '#e2b15a', x: 0.74, y: 0.22, r: 0.072 },
  { kind: 'dot', color: '#f6e7c4', x: 0.74, y: 0.22, r: 0.03 },
  {
    kind: 'fill',
    color: '#a3b496',
    points: [
      [0, 0.64],
      [0.16, 0.52],
      [0.34, 0.58],
      [0.52, 0.46],
      [0.72, 0.56],
      [0.88, 0.48],
      [1, 0.54],
      [1, 1],
      [0, 1],
    ],
  },
  {
    kind: 'fill',
    color: '#3d9a6e',
    points: [
      [0, 0.8],
      [0.2, 0.68],
      [0.42, 0.78],
      [0.66, 0.66],
      [0.86, 0.74],
      [1, 0.7],
      [1, 1],
      [0, 1],
    ],
  },
  {
    kind: 'fill',
    color: '#f4f7f2',
    points: [
      [0.16, 0.78],
      [0.4, 0.78],
      [0.4, 0.58],
      [0.16, 0.58],
    ],
  },
  {
    kind: 'fill',
    color: '#6b3f32',
    points: [
      [0.12, 0.58],
      [0.28, 0.44],
      [0.44, 0.58],
    ],
  },
  {
    kind: 'fill',
    color: '#c4a574',
    points: [
      [0.24, 0.78],
      [0.32, 0.78],
      [0.32, 0.66],
      [0.24, 0.66],
    ],
  },
  {
    kind: 'fill',
    color: '#8eb8c9',
    points: [
      [0.18, 0.63],
      [0.23, 0.63],
      [0.23, 0.69],
      [0.18, 0.69],
    ],
  },
  {
    kind: 'stroke',
    color: '#6b3f32',
    width: 0.028,
    points: [
      [0.64, 0.86],
      [0.66, 0.66],
    ],
  },
  { kind: 'dot', color: '#1f6b4a', x: 0.65, y: 0.62, r: 0.058 },
  { kind: 'dot', color: '#3d9a6e', x: 0.58, y: 0.66, r: 0.042 },
  { kind: 'dot', color: '#2f8f62', x: 0.72, y: 0.66, r: 0.044 },
  {
    kind: 'stroke',
    color: '#c4a574',
    width: 0.022,
    points: [
      [0.28, 0.78],
      [0.34, 0.88],
      [0.26, 1],
    ],
  },
];

/** A bowl of fruit on a table. */
const STILL_LIFE: readonly Mark[] = [
  {
    kind: 'fill',
    color: '#efe4d4',
    points: [
      [0, 0],
      [1, 0],
      [1, 0.58],
      [0, 0.58],
    ],
  },
  {
    kind: 'fill',
    color: '#b8896a',
    points: [
      [0, 0.58],
      [1, 0.58],
      [1, 1],
      [0, 1],
    ],
  },
  {
    kind: 'stroke',
    color: '#8d6848',
    width: 0.014,
    points: [
      [0, 0.58],
      [1, 0.58],
    ],
  },
  {
    kind: 'stroke',
    color: '#f4f7f2',
    width: 0.05,
    points: [
      [0.06, 0.72],
      [0.24, 0.64],
      [0.46, 0.74],
      [0.68, 0.63],
      [0.94, 0.72],
    ],
  },
  { kind: 'fill', color: '#174d36', points: oval(0.5, 0.6, 0.2, 0.05, 0, Math.PI) },
  { kind: 'fill', color: '#1f6b4a', points: oval(0.5, 0.58, 0.22, 0.12, 0, Math.PI) },
  {
    kind: 'stroke',
    color: '#143528',
    width: 0.016,
    points: oval(0.5, 0.58, 0.22, 0.05, Math.PI, Math.PI * 2),
  },
  { kind: 'dot', color: '#e07a6a', x: 0.4, y: 0.5, r: 0.058 },
  { kind: 'dot', color: '#f6d0c6', x: 0.385, y: 0.48, r: 0.016 },
  { kind: 'dot', color: '#e2b15a', x: 0.56, y: 0.48, r: 0.05 },
  { kind: 'dot', color: '#c46b4a', x: 0.48, y: 0.46, r: 0.04 },
  {
    kind: 'stroke',
    color: '#1f6b4a',
    width: 0.016,
    points: [
      [0.56, 0.44],
      [0.6, 0.36],
      [0.68, 0.34],
    ],
  },
  { kind: 'dot', color: '#3d9a6e', x: 0.69, y: 0.33, r: 0.03 },
];

/** A window looking onto a garden, with flowers on the sill. */
const WINDOW: readonly Mark[] = [
  {
    kind: 'fill',
    color: '#e7dcc8',
    points: [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
  },
  {
    kind: 'fill',
    color: '#c5d9e4',
    points: [
      [0.2, 0.14],
      [0.8, 0.14],
      [0.8, 0.62],
      [0.2, 0.62],
    ],
  },
  { kind: 'dot', color: '#e2b15a', x: 0.64, y: 0.26, r: 0.04 },
  {
    kind: 'fill',
    color: '#a3b496',
    points: [
      [0.2, 0.48],
      [0.36, 0.4],
      [0.52, 0.5],
      [0.68, 0.42],
      [0.8, 0.48],
      [0.8, 0.62],
      [0.2, 0.62],
    ],
  },
  {
    kind: 'fill',
    color: '#3d9a6e',
    points: [
      [0.2, 0.56],
      [0.4, 0.5],
      [0.62, 0.57],
      [0.8, 0.52],
      [0.8, 0.62],
      [0.2, 0.62],
    ],
  },
  {
    kind: 'stroke',
    color: '#5c4a30',
    width: 0.03,
    points: [
      [0.2, 0.14],
      [0.8, 0.14],
      [0.8, 0.62],
      [0.2, 0.62],
      [0.2, 0.14],
    ],
  },
  {
    kind: 'stroke',
    color: '#5c4a30',
    width: 0.018,
    points: [
      [0.5, 0.14],
      [0.5, 0.62],
    ],
  },
  {
    kind: 'stroke',
    color: '#5c4a30',
    width: 0.018,
    points: [
      [0.2, 0.38],
      [0.8, 0.38],
    ],
  },
  {
    kind: 'fill',
    color: '#f4f7f2',
    points: [
      [0.12, 0.62],
      [0.88, 0.62],
      [0.88, 0.68],
      [0.12, 0.68],
    ],
  },
  {
    kind: 'fill',
    color: '#c46b4a',
    points: [
      [0.4, 0.68],
      [0.62, 0.68],
      [0.58, 0.86],
      [0.44, 0.86],
    ],
  },
  {
    kind: 'stroke',
    color: '#1f6b4a',
    width: 0.012,
    points: [
      [0.46, 0.68],
      [0.43, 0.5],
    ],
  },
  {
    kind: 'stroke',
    color: '#1f6b4a',
    width: 0.012,
    points: [
      [0.51, 0.68],
      [0.53, 0.46],
    ],
  },
  {
    kind: 'stroke',
    color: '#1f6b4a',
    width: 0.012,
    points: [
      [0.56, 0.68],
      [0.62, 0.52],
    ],
  },
  { kind: 'dot', color: '#e07a6a', x: 0.43, y: 0.48, r: 0.036 },
  { kind: 'dot', color: '#e2b15a', x: 0.53, y: 0.44, r: 0.032 },
  { kind: 'dot', color: '#d46a8a', x: 0.62, y: 0.5, r: 0.03 },
  { kind: 'dot', color: '#f4f7f2', x: 0.42, y: 0.47, r: 0.01 },
];

const PAINTINGS = [HILLS, STILL_LIFE, WINDOW] as const;

function markWeight(mark: Mark): number {
  if (mark.kind === 'dot') return 0.22;
  if (mark.kind === 'fill') return 0.42;
  let distance = 0;
  for (let index = 1; index < mark.points.length; index += 1) {
    const previous = mark.points[index - 1];
    const point = mark.points[index];
    if (!previous || !point) continue;
    distance += Math.hypot(point[0] - previous[0], point[1] - previous[1]);
  }
  return Math.max(distance, 0.08);
}

function paintMark(
  context: CanvasRenderingContext2D,
  mark: Mark,
  portion: number,
  width: number,
  height: number,
) {
  if (portion <= 0) return;
  const px = (unit: number) => unit * width;
  const py = (unit: number) => unit * height;
  context.save();
  context.globalAlpha = mark.alpha ?? 1;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  if (mark.kind === 'dot') {
    context.fillStyle = mark.color;
    context.beginPath();
    context.arc(px(mark.x), py(mark.y), mark.r * Math.min(width, height) * portion, 0, Math.PI * 2);
    context.fill();
  } else if (mark.kind === 'fill') {
    context.beginPath();
    const first = mark.points[0];
    if (first) context.moveTo(px(first[0]), py(first[1]));
    for (const point of mark.points.slice(1)) context.lineTo(px(point[0]), py(point[1]));
    context.closePath();
    context.save();
    context.clip();
    context.fillStyle = mark.color;
    context.fillRect(0, 0, width * portion, height);
    context.restore();
  } else {
    const points = mark.points;
    let length = 0;
    const mapped: Array<[number, number]> = [];
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      if (!point) continue;
      const next: [number, number] = [px(point[0]), py(point[1])];
      const previous = mapped[mapped.length - 1];
      if (previous) length += Math.hypot(next[0] - previous[0], next[1] - previous[1]);
      mapped.push(next);
    }
    const start = mapped[0];
    if (start && length > 0) {
      context.beginPath();
      context.moveTo(start[0], start[1]);
      for (const point of mapped.slice(1)) context.lineTo(point[0], point[1]);
      context.strokeStyle = mark.color;
      context.lineWidth = mark.width * Math.min(width, height);
      const drawn = Math.max(portion, 0.001) * length;
      context.setLineDash([drawn, length]);
      context.stroke();
      context.setLineDash([]);
    }
  }
  context.restore();
}

function paintScene(
  context: CanvasRenderingContext2D,
  marks: readonly Mark[],
  progress: number,
  width: number,
  height: number,
) {
  const weights = marks.map(markWeight);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let remaining = Math.min(Math.max(progress, 0), 1) * total;
  for (let index = 0; index < marks.length; index += 1) {
    const mark = marks[index];
    const weight = weights[index] ?? 0;
    if (!mark || weight <= 0) continue;
    const portion = Math.min(Math.max(remaining / weight, 0), 1);
    paintMark(context, mark, portion, width, height);
    remaining -= weight;
    if (remaining <= 0) break;
  }
}

function renderFrame(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  elapsed: number,
  still: boolean,
) {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = LINEN;
  context.fillRect(0, 0, width, height);
  const painting = still ? HILLS : PAINTINGS[Math.floor(elapsed / CYCLE_MS) % PAINTINGS.length];
  if (!painting) return;
  const local = still ? 0 : elapsed % CYCLE_MS;
  const progress = still ? 1 : Math.min(local / DRAW_MS, 1);
  paintScene(context, painting, progress, width, height);
  if (!still && local > DRAW_MS + HOLD_MS && local < DRAW_MS + HOLD_MS + ERASE_MS) {
    const wiped = (local - DRAW_MS - HOLD_MS) / ERASE_MS;
    context.save();
    context.globalCompositeOperation = 'destination-out';
    context.beginPath();
    const edge = wiped * (width + 36);
    context.moveTo(0, 0);
    for (let y = 0; y <= height; y += 6) {
      context.lineTo(edge + Math.sin(y * 0.09) * 12, y);
    }
    context.lineTo(0, height);
    context.closePath();
    context.fill();
    context.restore();
  }
  if (!still && local >= DRAW_MS + HOLD_MS + ERASE_MS) {
    context.fillStyle = LINEN;
    context.fillRect(0, 0, width, height);
  }
}

function prepare(
  canvas: HTMLCanvasElement,
): { context: CanvasRenderingContext2D; width: number; height: number } | null {
  const context = canvas.getContext('2d');
  if (!context) return null;
  const bounds = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(bounds.width * ratio));
  const height = Math.max(1, Math.round(bounds.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { context, width, height };
}

export function Painting({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let elapsed = 0;
    let last = performance.now();
    let stopped = false;
    let loop = false;

    const draw = (still: boolean) => {
      const ready = prepare(canvas);
      if (!ready) return;
      renderFrame(ready.context, ready.width, ready.height, elapsed, still);
    };

    const tick = (now: number) => {
      if (stopped || !loop) return;
      const delta = Math.min(48, now - last);
      last = now;
      if (!document.hidden) elapsed += delta;
      draw(false);
      frame = window.requestAnimationFrame(tick);
    };

    const start = () => {
      window.cancelAnimationFrame(frame);
      last = performance.now();
      loop = !motion.matches;
      if (motion.matches) draw(true);
      else frame = window.requestAnimationFrame(tick);
    };

    const observer = new ResizeObserver(() => draw(motion.matches));
    observer.observe(canvas);
    start();
    motion.addEventListener('change', start);
    return () => {
      stopped = true;
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      motion.removeEventListener('change', start);
    };
  }, []);

  return (
    <div
      className={cn(
        'rounded-sm bg-[#efe6d4] p-2 shadow-[0_12px_28px_rgb(22_20_16/0.18)] ring-1 ring-[#d9cbb3]',
        className,
      )}
    >
      <canvas ref={canvasRef} className="block aspect-[4/3] w-full bg-[#f4efe4]" aria-hidden />
    </div>
  );
}
