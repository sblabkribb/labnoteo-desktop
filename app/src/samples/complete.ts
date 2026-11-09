/**
 * `@` sample completion (plan SP5 Task 13). Task 11 adds only the reopen predicate, so the editor's shared
 * completion guards can list it now; Task 13 gives it its real body.
 */
import type { ReopenIf } from '../links/complete';

/** Reopens the list after `compositionend` inside a sample trigger. A stub until Task 13. */
export const sampleReopen: ReopenIf = () => false;
