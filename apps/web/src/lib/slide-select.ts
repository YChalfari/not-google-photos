import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';

const MOVE_PX = 8;
const HOLD_MS = 220;
const STEP_PX = 4;

type Phase = 'pending' | 'paint' | 'scroll';
type Mode = 'add' | 'clear';

type Drag = {
  pointerId: number;
  pointerType: string;
  phase: Phase;
  mode: Mode;
  startX: number;
  startY: number;
  startT: number;
  x: number;
  y: number;
  lastX: number;
  lastY: number;
  seen: Set<string>;
  started: boolean;
};

/**
 * Slide a pointer across `data-select-id` children to select them.
 * A finger flick up or down still scrolls. A sideways slide, a short hold
 * then a slide, or any mouse drag paints on the photos under the pointer.
 * Starting on a selected item clears the ones you cross.
 */
export function useSlideSelect({
  enabled,
  isSelected,
  onToggle,
}: {
  enabled: boolean;
  isSelected: (id: string) => boolean;
  onToggle: (id: string) => void;
}) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const optionsRef = useRef({ enabled, isSelected, onToggle });
  optionsRef.current = { enabled, isSelected, onToggle };
  const dragRef = useRef<Drag | null>(null);
  const ignoreClickRef = useRef(false);
  const activeRef = useRef(false);
  const frameRef = useRef(0);

  const setContainer = useCallback((next: HTMLDivElement | null) => {
    nodeRef.current = next;
    setNode(next);
  }, []);

  function paintId(drag: Drag, id: string) {
    if (drag.seen.has(id)) return;
    drag.seen.add(id);
    const selected = optionsRef.current.isSelected(id);
    if (drag.mode === 'add' ? selected : !selected) return;
    optionsRef.current.onToggle(id);
  }

  function paintAlong(drag: Drag, x: number, y: number) {
    const container = nodeRef.current;
    if (!container) return;
    const dx = x - drag.lastX;
    const dy = y - drag.lastY;
    const dist = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(dist / STEP_PX));
    for (let step = 0; step <= steps; step += 1) {
      const t = steps === 0 ? 1 : step / steps;
      const id = idAt(container, drag.lastX + dx * t, drag.lastY + dy * t);
      if (id) paintId(drag, id);
    }
    drag.lastX = x;
    drag.lastY = y;
  }

  function stopLoop() {
    if (frameRef.current === 0) return;
    cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
  }

  function tick() {
    const drag = dragRef.current;
    const container = nodeRef.current;
    if (!drag || drag.phase !== 'paint' || !container) {
      frameRef.current = 0;
      return;
    }
    nudgeScroll(container, drag.y);
    paintAlong(drag, drag.x, drag.y);
    frameRef.current = requestAnimationFrame(tick);
  }

  function begin(drag: Drag) {
    if (drag.started) return;
    drag.started = true;
    drag.phase = 'paint';
    activeRef.current = true;
    const container = nodeRef.current;
    if (container?.setPointerCapture) {
      try {
        container.setPointerCapture(drag.pointerId);
      } catch {
        // The pointer can already be gone.
      }
    }
    paintAlong(drag, drag.x, drag.y);
    if (frameRef.current === 0) frameRef.current = requestAnimationFrame(tick);
  }

  const onTouchMoveRef = useRef<(event: TouchEvent) => void>(() => {});
  onTouchMoveRef.current = (event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerType !== 'touch') return;
    const touch =
      [...event.changedTouches, ...event.touches].find(
        (item) => item.identifier === drag.pointerId,
      ) ?? event.touches[0];
    if (!touch) return;
    if (drag.phase === 'paint') {
      if (event.cancelable) event.preventDefault();
      return;
    }
    if (drag.phase === 'scroll') return;
    const dx = touch.clientX - drag.startX;
    const dy = touch.clientY - drag.startY;
    const intent = slideIntent(performance.now() - drag.startT, dx, dy, 'touch');
    if (intent === 'wait') return;
    if (intent === 'scroll' || (Math.abs(dy) > Math.abs(dx) && !event.cancelable)) {
      drag.phase = 'scroll';
      return;
    }
    if (event.cancelable) event.preventDefault();
    drag.x = touch.clientX;
    drag.y = touch.clientY;
    begin(drag);
  };

  useEffect(() => {
    if (!node || !enabled) return;
    const onTouchMove = (event: TouchEvent) => onTouchMoveRef.current(event);
    node.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => node.removeEventListener('touchmove', onTouchMove);
  }, [node, enabled]);

  useEffect(() => stopLoop, []);

  function end(pointerId: number) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    const moved = Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= MOVE_PX;
    dragRef.current = null;
    activeRef.current = false;
    stopLoop();
    if (!drag.started && !moved) return;
    ignoreClickRef.current = true;
    window.setTimeout(() => {
      ignoreClickRef.current = false;
    }, 0);
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!optionsRef.current.enabled || event.button !== 0 || dragRef.current) return;
    const container = nodeRef.current;
    if (!container) return;
    const id = idAt(container, event.clientX, event.clientY);
    if (!id) return;
    dragRef.current = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      phase: 'pending',
      mode: optionsRef.current.isSelected(id) ? 'clear' : 'add',
      startX: event.clientX,
      startY: event.clientY,
      startT: performance.now(),
      x: event.clientX,
      y: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      seen: new Set(),
      started: false,
    };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (drag.phase === 'scroll') return;
    if (drag.phase === 'pending') {
      if (drag.pointerType === 'touch') return;
      const intent = slideIntent(
        performance.now() - drag.startT,
        event.clientX - drag.startX,
        event.clientY - drag.startY,
        drag.pointerType,
      );
      if (intent !== 'paint') return;
      begin(drag);
      return;
    }
    paintAlong(drag, event.clientX, event.clientY);
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    end(event.pointerId);
  }

  function onLostPointerCapture(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    end(event.pointerId);
  }

  function consumeClick() {
    if (!ignoreClickRef.current) return false;
    ignoreClickRef.current = false;
    return true;
  }

  return {
    ref: setContainer,
    activeRef,
    ignoreClickRef,
    consumeClick,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    onLostPointerCapture,
  };
}

export function slideIntent(
  elapsedMs: number,
  dx: number,
  dy: number,
  pointerType: string,
): 'wait' | 'paint' | 'scroll' {
  if (Math.hypot(dx, dy) < MOVE_PX) return 'wait';
  if (pointerType !== 'touch') return 'paint';
  if (elapsedMs >= HOLD_MS) return 'paint';
  if (Math.abs(dx) >= Math.abs(dy)) return 'paint';
  return 'scroll';
}

function idAt(container: HTMLElement, x: number, y: number): string | null {
  const hit = document.elementFromPoint(x, y);
  if (!(hit instanceof Element) || !container.contains(hit)) return null;
  return hit.closest('[data-select-id]')?.getAttribute('data-select-id') ?? null;
}

function nudgeScroll(container: HTMLElement, clientY: number) {
  const edge = 72;
  let current: HTMLElement | null = container;
  while (current && current !== document.body && current !== document.documentElement) {
    const overflow = getComputedStyle(current).overflowY;
    if (
      (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') &&
      current.scrollHeight > current.clientHeight + 4
    ) {
      const rect = current.getBoundingClientRect();
      if (clientY < rect.top + edge) current.scrollTop -= 12;
      else if (clientY > rect.bottom - edge) current.scrollTop += 12;
      return;
    }
    current = current.parentElement;
  }
  const scrolling = document.scrollingElement;
  if (!scrolling) return;
  if (clientY < edge) scrolling.scrollTop -= 12;
  else if (clientY > window.innerHeight - 160) scrolling.scrollTop += 12;
}
