import { useLayoutEffect, useRef } from 'react';

export interface FaceCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Crops a full-photo thumbnail down to one face. The box is 0..1 from the
 * top-left of that same image, and the thumbnail keeps the photo's aspect ratio.
 */
export function FaceAvatar({
  src,
  box,
  alt = '',
}: {
  src: string | null;
  box: FaceCrop | null;
  alt?: string;
}) {
  const frame = useRef<HTMLSpanElement>(null);
  const image = useRef<HTMLImageElement>(null);

  useLayoutEffect(() => {
    const frameEl = frame.current;
    const imageEl = image.current;
    if (!frameEl || !imageEl) return;

    const place = () => positionFace(frameEl, imageEl, box);
    imageEl.style.visibility = 'hidden';
    if (imageEl.complete && imageEl.naturalWidth > 0) place();
    const observer = new ResizeObserver(place);
    observer.observe(frameEl);
    imageEl.addEventListener('load', place);
    return () => {
      observer.disconnect();
      imageEl.removeEventListener('load', place);
    };
  }, [src, box]);

  if (!src) {
    return (
      <span className="flex h-full w-full items-center justify-center bg-secondary text-muted-foreground">
        ?
      </span>
    );
  }

  return (
    <span ref={frame} className="relative block h-full w-full overflow-hidden bg-secondary">
      <img ref={image} src={src} alt={alt} draggable={false} className="absolute max-w-none" />
    </span>
  );
}

function positionFace(frame: HTMLElement, image: HTMLImageElement, box: FaceCrop | null) {
  const frameW = frame.clientWidth;
  const frameH = frame.clientHeight;
  const naturalW = image.naturalWidth;
  const naturalH = image.naturalHeight;
  if (!frameW || !frameH || !naturalW || !naturalH || !box || box.width < 0.02 || box.height < 0.02) {
    image.style.objectFit = 'cover';
    image.style.width = '100%';
    image.style.height = '100%';
    image.style.left = '0px';
    image.style.top = '0px';
    image.style.visibility = naturalW ? 'visible' : 'hidden';
    return;
  }

  const padded = padBox(box);
  const regionW = Math.max(padded.width * naturalW, 1);
  const regionH = Math.max(padded.height * naturalH, 1);
  const scale = Math.max(frameW / regionW, frameH / regionH);
  const displayW = naturalW * scale;
  const displayH = naturalH * scale;
  const centerX = (padded.x + padded.width / 2) * displayW;
  const centerY = (padded.y + padded.height / 2) * displayH;
  image.style.objectFit = 'fill';
  image.style.width = `${displayW}px`;
  image.style.height = `${displayH}px`;
  image.style.left = `${frameW / 2 - centerX}px`;
  image.style.top = `${frameH / 2 - centerY}px`;
  image.style.visibility = 'visible';
}

/** A little forehead and chin, without leaving the photo. */
function padBox(box: FaceCrop): FaceCrop {
  const padX = box.width * 0.35;
  const padY = box.height * 0.4;
  let x = box.x - padX;
  let y = box.y - padY;
  let width = box.width + padX * 2;
  let height = box.height + padY * 2;
  if (x < 0) {
    width += x;
    x = 0;
  }
  if (y < 0) {
    height += y;
    y = 0;
  }
  if (x + width > 1) width = 1 - x;
  if (y + height > 1) height = 1 - y;
  return { x, y, width: Math.max(width, 0.02), height: Math.max(height, 0.02) };
}
