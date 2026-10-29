import { cn } from '@/lib/utils';

/** Mirrored pinwheel. Keep these paths in sync with public/favicon.svg and the Android launcher. */
const BRASS =
  'M14.75 13.41c8.146 0 14.75 6.603 14.75 14.75v1.34H1.34C.6 29.5 0 28.9 0 28.16c0-8.147 6.604-14.75 14.75-14.75z';
const DEEP =
  'M45.59 14.75c0 8.146-6.603 14.75-14.75 14.75H29.5V1.34C29.5.6 30.1 0 30.84 0c8.147 0 14.75 6.604 14.75 14.75z';
const CREAM =
  'M44.25 45.59c-8.146 0-14.75-6.603-14.75-14.75V29.5h28.16c.74 0 1.34.6 1.34 1.34 0 8.147-6.604 14.75-14.75 14.75z';
const LEAF =
  'M13.41 44.25c0-8.146 6.603-14.75 14.75-14.75h1.34v28.16c0 .74-.6 1.34-1.34 1.34-8.147 0-14.75-6.604-14.75-14.75z';

export function Logo({ className, label }: { className?: string; label?: string }) {
  return (
    <span
      className={cn(
        'grid size-9 shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-[#161410]',
        className,
      )}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <svg viewBox="0 0 59 59" className="size-[86%]" aria-hidden="true">
        <g transform="translate(59 0) scale(-1 1)">
          <path fill="#c4a574" d={BRASS} />
          <path fill="#1f6b4a" d={DEEP} />
          <path fill="#f4f7f2" d={CREAM} />
          <path fill="#3d9a6e" d={LEAF} />
        </g>
      </svg>
    </span>
  );
}
