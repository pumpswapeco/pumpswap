import { cn } from '@/lib/utils'

function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    <label
      data-slot="label"
      className={cn(
        'flex items-center gap-1.5 text-sm font-medium leading-none text-foreground select-none',
        className,
      )}
      {...props}
    />
  )
}

export { Label }
