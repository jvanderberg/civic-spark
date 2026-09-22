// Adapted from T3 Code, copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.txt.
import { LoaderCircle as Spinner } from "lucide-react";
import { cn } from "./utils.ts";
export function ComposerPrimaryActions({
  isRunning,
  isStopping,
  isQueueing,
  hasSendableContent,
  isConnecting,
  isSendBusy,
  isEnvironmentUnavailable,
  sendDisabledReason,
  onInterrupt,
}: {
  isRunning: boolean;
  /** The stop was clicked and the server has not acknowledged it yet. */
  isStopping: boolean;
  /** A send waits for the running turn instead of starting one. */
  isQueueing: boolean;
  hasSendableContent: boolean;
  isConnecting: boolean;
  isSendBusy: boolean;
  isEnvironmentUnavailable: boolean;
  sendDisabledReason: string | null;
  onInterrupt: () => void;
}) {
  const isSendDisabled = sendDisabledReason !== null;
  const renderStopGenerationButton = (insidePendingAction: boolean) => (
    <button
      type="button"
      className={cn(
        "flex items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-[0_1px_--theme(--color-white/16%)] transition-all duration-150 enabled:cursor-pointer enabled:hover:bg-destructive enabled:hover:scale-105 active:inset-shadow-[0_1px_--theme(--color-black/8%)] active:shadow-none disabled:opacity-60",
        insidePendingAction
          ? "size-8 sm:size-7"
          : hasSendableContent
            ? "size-9 sm:size-8"
            : "size-8 sm:h-8 sm:w-8",
      )}
      onClick={onInterrupt}
      disabled={isStopping}
      aria-label={isStopping ? "Stopping generation" : "Stop generation"}
    >
      {isStopping ? (
        <Spinner className="size-3.5" aria-hidden="true" />
      ) : (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <rect x="2" y="2" width="8" height="8" rx="1.5" />
        </svg>
      )}
    </button>
  );
  const sendButton = (
    <button
      type="submit"
      className={cn(
        "relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-[0_1px_--theme(--color-white/16%)] hover:scale-105 active:inset-shadow-[0_1px_--theme(--color-black/8%)] active:shadow-none disabled:pointer-events-none disabled:opacity-30 disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8",
        "bg-message-action text-message-action-foreground enabled:shadow-message-action/24 hover:bg-message-action-hover",
      )}
      disabled={
        isSendBusy ||
        isSendDisabled ||
        isConnecting ||
        isEnvironmentUnavailable ||
        !hasSendableContent
      }
      aria-label={isQueueing ? "Queue for the current turn" : "Send to agent"}
    >
      {isConnecting || isSendBusy ? (
        <Spinner className="size-3.5" aria-hidden="true" />
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );

  // Upstream pairs the stop control with the send control while a turn runs;
  // here that send control queues the message for the current turn. The
  // wrapper keeps the pair together in Civic Spark's space-between footer.
  if (isStopping) return renderStopGenerationButton(false);
  if (!isRunning) return sendButton;
  return (
    <div className="flex items-center justify-end gap-1.5">
      {renderStopGenerationButton(false)}
      {hasSendableContent ? sendButton : null}
    </div>
  );
}
