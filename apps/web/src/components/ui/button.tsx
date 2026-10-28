import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-[transform,background-color,color,box-shadow] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:scale-[0.97] active:shadow-[inset_0_1px_2px_rgb(0_0_0/0.28)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/75',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive/75',
        outline: 'border border-input bg-card hover:bg-accent active:bg-secondary',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-secondary/80 active:bg-secondary/60',
        ghost: 'hover:bg-accent active:bg-secondary',
        link: 'text-primary underline-offset-4 hover:underline active:opacity-70',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-11 rounded-md px-6',
        icon: 'size-10',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild = false,
  pending = false,
  disabled,
  children,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean; pending?: boolean }) {
  const classNames = cn(buttonVariants({ variant, size }), className);
  if (asChild) {
    return (
      <Slot className={classNames} {...props}>
        {children}
      </Slot>
    );
  }
  return (
    <button
      className={classNames}
      aria-busy={pending || undefined}
      disabled={disabled || pending}
      {...props}
    >
      {pending ? <Loader2 className="animate-spin" /> : null}
      {children}
    </button>
  );
}

export { buttonVariants };
