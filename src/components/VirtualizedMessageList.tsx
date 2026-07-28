import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import type { MessageRecord } from "../types";

export interface VirtualizedMessageListHandle {
  scrollToIndex: (index: number, align?: "center" | "end" | "start") => void;
}

interface VirtualizedMessageListProps {
  emptyState?: ReactNode;
  estimateHeight?: number;
  messages: MessageRecord[];
  overscan?: number;
  renderMessage: (message: MessageRecord, index: number) => ReactNode;
}

function binarySearch(values: number[], target: number): number {
  let low = 0;
  let high = values.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] < target) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return Math.max(0, low - 1);
}

function MeasuredRow({
  children,
  messageKey,
  offsetTop,
  onMeasure
}: {
  children: ReactNode;
  messageKey: string;
  offsetTop: number;
  onMeasure: (messageKey: string, height: number) => void;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = rowRef.current;
    if (!node) {
      return undefined;
    }

    const update = () => onMeasure(messageKey, node.getBoundingClientRect().height);
    update();

    const observer = new ResizeObserver(update);
    observer.observe(node);

    return () => observer.disconnect();
  }, [messageKey, onMeasure]);

  return (
    <div className="virtual-row" ref={rowRef} style={{ top: `${offsetTop}px` }}>
      {children}
    </div>
  );
}

const VirtualizedMessageList = forwardRef<VirtualizedMessageListHandle, VirtualizedMessageListProps>(
  function VirtualizedMessageList(
    { emptyState, estimateHeight = 260, messages, overscan = 6, renderMessage },
    ref
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(640);
    const [measurementVersion, setMeasurementVersion] = useState(0);
    const lastScrollTopRef = useRef(0);
    const heightCacheRef = useRef<Map<string, number>>(new Map());
    const metricsRef = useRef<{ offsets: number[]; totalHeight: number }>({
      offsets: [],
      totalHeight: 0
    });

    useEffect(() => {
      const node = containerRef.current;
      if (!node) {
        return undefined;
      }

      const syncHeight = () => setViewportHeight(node.clientHeight || 640);
      syncHeight();

      const observer = new ResizeObserver(syncHeight);
      observer.observe(node);

      return () => observer.disconnect();
    }, []);

    const metrics = useMemo(() => {
      const heights = messages.map(
        (message) => heightCacheRef.current.get(message.message_key) ?? estimateHeight
      );

      const offsets: number[] = [];
      let totalHeight = 0;
      for (const height of heights) {
        offsets.push(totalHeight);
        totalHeight += height + 12;
      }

      metricsRef.current = { offsets, totalHeight };
      return { offsets, totalHeight };
    }, [estimateHeight, measurementVersion, messages]);

    const overscanHeight = overscan * estimateHeight;
    const startIndex = messages.length
      ? binarySearch(metrics.offsets, Math.max(0, scrollTop - overscanHeight))
      : 0;
    const endIndex = messages.length
      ? Math.min(
          messages.length - 1,
          binarySearch(metrics.offsets, scrollTop + viewportHeight + overscanHeight) + 2
        )
      : 0;

    useImperativeHandle(ref, () => ({
      scrollToIndex(index, align = "start") {
        const node = containerRef.current;
        if (!node || !messages[index]) {
          return;
        }

        const offsetTop = metricsRef.current.offsets[index] ?? 0;
        const itemHeight =
          heightCacheRef.current.get(messages[index].message_key) ?? estimateHeight;

        let nextTop = offsetTop;
        if (align === "center") {
          nextTop = Math.max(0, offsetTop - node.clientHeight / 2 + itemHeight / 2);
        } else if (align === "end") {
          nextTop = Math.max(0, offsetTop - node.clientHeight + itemHeight);
        }

        node.scrollTo({ top: nextTop, behavior: "smooth" });
      }
    }));

    if (!messages.length) {
      return <div className="empty-panel">{emptyState ?? "No messages match the current filter."}</div>;
    }

    return (
      <div
        className="virtual-list-container"
        ref={containerRef}
        onScroll={(event) => {
          const top = event.currentTarget.scrollTop;
          const previous = lastScrollTopRef.current;
          lastScrollTopRef.current = top;
          setScrollTop(top);
          window.dispatchEvent(
            new CustomEvent("vn-reader-scroll", {
              detail: {
                top,
                direction: top > previous ? "down" : "up"
              }
            })
          );
        }}
      >
        <div className="virtual-list-spacer" style={{ height: `${metrics.totalHeight}px` }}>
          {messages.slice(startIndex, endIndex + 1).map((message, visibleIndex) => {
            const actualIndex = startIndex + visibleIndex;
            return (
              <MeasuredRow
                key={message.message_key}
                messageKey={message.message_key}
                offsetTop={metrics.offsets[actualIndex] ?? 0}
                onMeasure={(messageKey, height) => {
                  const previous = heightCacheRef.current.get(messageKey);
                  if (previous !== height) {
                    heightCacheRef.current.set(messageKey, height);
                    setMeasurementVersion((version) => version + 1);
                  }
                }}
              >
                {renderMessage(message, actualIndex)}
              </MeasuredRow>
            );
          })}
        </div>
      </div>
    );
  }
);

export default VirtualizedMessageList;
