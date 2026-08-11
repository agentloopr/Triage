/**
 * Typed pipeline events.
 *
 * The system this was extracted from called `postSlackMessage` from inside the passes, which fused
 * "what happened" with "where it gets announced" — and made the pipeline untestable without a Slack
 * workspace. Everything worth telling a human about is emitted here instead; wiring it to Slack, a
 * console, or nothing at all is the caller's business.
 *
 * Unhandled listener errors are swallowed on purpose: a broken notification must never take down a
 * run that has already written to the tracker.
 */
export type PipelineEvent =
  | { type: 'pass:start'; pass: string; itemCount?: number }
  | { type: 'pass:done'; pass: string; ms: number; detail?: string }
  | { type: 'skipped'; layer: 'event' | 'source' | 'content'; reason: string }
  /** An item Pass 2a could not categorize — surfaced, because these used to be dropped silently. */
  | { type: 'items:uncategorized'; items: Array<{ number: number; title: string }> }
  | { type: 'items:held'; items: Array<{ item: number; title: string; gate: string; question: string; notifyAssignee?: string }> }
  | { type: 'items:skipped-not-task'; items: Array<{ item: number; title: string; reason: string }> }
  | { type: 'flags'; flags: Array<{ kind: string; items: number[]; note: string }> }
  | { type: 'executed'; created: number; commented: number; skipped: number; failed: number; refused: number; unsupported: number }
  | { type: 'audit'; passed: number; mismatched: number; report: string }
  /** Something is wrong with the machinery itself, not with the content. */
  | { type: 'alert'; detail: string };

export type PipelineListener = (event: PipelineEvent) => void;

export class PipelineEvents {
  private listeners: PipelineListener[] = [];

  on(listener: PipelineListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  emit(event: PipelineEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        console.warn(`[events] listener threw on ${event.type}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
