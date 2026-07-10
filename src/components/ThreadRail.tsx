import type { MessageRecord } from "../types";

interface ThreadRailProps {
  open: boolean;
  threadMessages: MessageRecord[];
  currentMessageKey: string | null;
  onSelectMessage: (messageKey: string) => void;
  onClose: () => void;
}

function trim(value: string, limit = 80): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return "(no text)";
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}…`;
}

export default function ThreadRail({
  open,
  threadMessages,
  currentMessageKey,
  onSelectMessage,
  onClose
}: ThreadRailProps) {
  if (!threadMessages.length) {
    return null;
  }

  const root = threadMessages[0];

  return (
    <aside className={`thread-rail ${open ? "is-open" : ""}`} aria-hidden={!open}>
      <div className="thread-rail-header">
        <div>
          <p className="eyebrow">In thread</p>
          <h3>#{root?.thread_root_id ?? "?"}</h3>
        </div>
        <button type="button" className="btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="thread-rail-list">
        {threadMessages.map((message, index) => (
          <button
            key={message.message_key}
            type="button"
            className={`thread-rail-item ${
              message.message_key === currentMessageKey ? "is-current" : ""
            }`}
            onClick={() => onSelectMessage(message.message_key)}
          >
            <span className="thread-rail-item-head">
              {index === 0 ? "ROOT" : `↳ #${message.message_id}`}
              {message.is_quote_reply ? " · QUOTE" : message.is_reply ? " · REPLY" : ""}
            </span>
            <span className="thread-rail-item-preview">
              {trim(message.text || message.quote_text || "(media)", 120)}
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}
