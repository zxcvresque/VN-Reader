import type { AdminContext } from "./AdminApp";

/** Sample data only helps someone who can see responses or statistics. */
export const canSample = (context: Pick<AdminContext, "can">) => context.can("responses.read") || context.can("insights.read");
