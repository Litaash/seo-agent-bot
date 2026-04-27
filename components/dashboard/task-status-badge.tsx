import { cn } from "@/lib/utils";
import { formatTaskStatus, taskStatusBadgeClass } from "@/lib/format";

/**
 * Small status pill rendered in task lists, the task header, and the
 * live log header. Kept as a Server Component (no interactivity) so the
 * dashboard's initial paint includes the styled status with no client
 * hydration cost.
 */
export function TaskStatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full px-2 text-xs font-medium",
        taskStatusBadgeClass(status),
        className,
      )}
    >
      {formatTaskStatus(status)}
    </span>
  );
}
