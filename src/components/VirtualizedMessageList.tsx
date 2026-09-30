import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect,
  useMemo, useRef, useState, type ReactNode
} from "react";
import type { MessageRecord } from "../types";

export interface ReadingPosition {
  messageKey: string;
  /** Pixels from the start of this post, including positions inside long posts. */
  offset: number;
  /** Stable text offset and proportional position within its paragraph across reflow. */
  paragraphOffset?: number;
  paragraphRatio?: number;
}

export interface VirtualizedMessageListHandle {
  scrollToIndex: (index: number, align?: "center" | "end" | "start") => void;
  getPosition: () => ReadingPosition | null;
  restorePosition: (position: ReadingPosition) => void;
}

interface VirtualizedMessageListProps {
  emptyState?: ReactNode;
  estimateHeight?: number;
  messages: MessageRecord[];
  overscan?: number;
  renderMessage: (message: MessageRecord, index: number) => ReactNode;
  onPositionChange?: (position: ReadingPosition) => void;
  layoutKey?: string;
}

function binarySearch(values: number[], target: number): number {
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] <= target) low = middle + 1;
    else high = middle - 1;
  }
  return Math.max(0, low - 1);
}

function MeasuredRow({ children, messageKey, offsetTop, onMeasure }: {
  children: ReactNode;
  messageKey: string;
  offsetTop: number;
  onMeasure: (messageKey: string, height: number) => void;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const node = rowRef.current;
    if (!node) return;
    const update = () => onMeasure(messageKey, node.getBoundingClientRect().height);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [messageKey, onMeasure]);
  return <div className="virtual-row" data-row-key={messageKey} ref={rowRef} style={{ top: `${offsetTop}px` }}>{children}</div>;
}

const VirtualizedMessageList = forwardRef<VirtualizedMessageListHandle, VirtualizedMessageListProps>(
  function VirtualizedMessageList({ emptyState, estimateHeight = 260, messages, overscan = 6, renderMessage, onPositionChange, layoutKey }, ref) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(640);
    const [measurementVersion, setMeasurementVersion] = useState(0);
    const lastScrollTopRef = useRef(0);
    const heightCacheRef = useRef(new Map<string, number>());
    const metricsRef = useRef<{ offsets: number[]; totalHeight: number }>({ offsets: [], totalHeight: 0 });
    const messagesRef = useRef(messages);
    messagesRef.current = messages;
    const anchorRef = useRef<ReadingPosition | null>(null);
    const pendingRestoreRef = useRef<ReadingPosition | null>(null);
    const pendingNavigationRef = useRef<{ messageKey: string; align: "center" | "end" | "start" } | null>(null);
    const navigationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const paragraphAnchorRef = useRef<{ messageKey: string; paragraphOffset: string; ratio: number } | null>(null);
    const locateParagraph = useCallback((position: ReadingPosition) => {
      const row = containerRef.current ? Array.from(containerRef.current.querySelectorAll<HTMLElement>("[data-row-key]")).find((item) => item.dataset.rowKey === position.messageKey) : null;
      if (!row) return null;
      const rowTop = row.getBoundingClientRect().top;
      for (const paragraph of row.querySelectorAll<HTMLElement>(".reader-message-body [data-paragraph-offset]")) {
        const bounds = paragraph.getBoundingClientRect();
        const top = bounds.top - rowTop;
        if (position.offset >= top && position.offset <= top + bounds.height && bounds.height > 0) {
          const paragraphOffset = Number(paragraph.dataset.paragraphOffset);
          if (!Number.isFinite(paragraphOffset)) return null;
          return { paragraphOffset, paragraphRatio: Math.max(0, Math.min(1, (position.offset - top) / bounds.height)) };
        }
      }
      return null;
    }, []);
    const captureParagraph = useCallback((position: ReadingPosition | null) => {
      const paragraph = position ? locateParagraph(position) : null;
      paragraphAnchorRef.current = position && paragraph ? { messageKey: position.messageKey, paragraphOffset: String(paragraph.paragraphOffset), ratio: paragraph.paragraphRatio } : null;
    }, [locateParagraph]);
    const onPositionChangeRef = useRef(onPositionChange);
    onPositionChangeRef.current = onPositionChange;
    const notificationFrameRef = useRef<number | null>(null);
    const restoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const getPosition = useCallback((): ReadingPosition | null => {
      const node = containerRef.current;
      const currentMessages = messagesRef.current;
      if (!node || !currentMessages.length) return null;
      const index = Math.min(currentMessages.length - 1, binarySearch(metricsRef.current.offsets, node.scrollTop));
      const position = { messageKey: currentMessages[index].message_key, offset: Math.max(0, node.scrollTop - (metricsRef.current.offsets[index] ?? 0)) };
      const paragraph = locateParagraph(position);
      return paragraph ? { ...position, ...paragraph } : position;
    }, [locateParagraph]);

    const notifyPosition = useCallback(() => {
      if (notificationFrameRef.current !== null) return;
      notificationFrameRef.current = requestAnimationFrame(() => {
        notificationFrameRef.current = null;
        const position = pendingRestoreRef.current ?? getPosition();
        if (position) onPositionChangeRef.current?.(position);
      });
    }, [getPosition]);

    const applyPosition = useCallback((position: ReadingPosition) => {
      const node = containerRef.current;
      const index = messagesRef.current.findIndex((message) => message.message_key === position.messageKey);
      if (!node || index < 0) return;
      let offset = Math.max(0, position.offset);
      if (position.paragraphOffset !== undefined && position.paragraphRatio !== undefined) {
        const row = Array.from(node.querySelectorAll<HTMLElement>("[data-row-key]")).find((item) => item.dataset.rowKey === position.messageKey);
        const paragraph = row ? Array.from(row.querySelectorAll<HTMLElement>(".reader-message-body [data-paragraph-offset]")).find((item) => Number(item.dataset.paragraphOffset) === position.paragraphOffset) : null;
        if (row && paragraph) {
          const bounds = paragraph.getBoundingClientRect();
          offset = bounds.top - row.getBoundingClientRect().top + Math.max(0, Math.min(1, position.paragraphRatio)) * bounds.height;
        }
      }
      const resolvedPosition = { ...position, offset };
      if (pendingRestoreRef.current?.messageKey === position.messageKey) pendingRestoreRef.current = resolvedPosition;
      const target = (metricsRef.current.offsets[index] ?? 0) + offset;
      // Native overflow anchoring is disabled: the row anchor is our source of truth.
      node.scrollTo({ top: target, behavior: "instant" as ScrollBehavior });
      lastScrollTopRef.current = node.scrollTop;
      setScrollTop(node.scrollTop);
      anchorRef.current = resolvedPosition;
      notifyPosition();
    }, [notifyPosition]);

    useEffect(() => {
      const node = containerRef.current;
      if (!node) return;
      const syncHeight = () => setViewportHeight(node.clientHeight || 640);
      syncHeight();
      const observer = new ResizeObserver(syncHeight);
      observer.observe(node);
      return () => observer.disconnect();
    }, [messages.length > 0]);

    useEffect(() => () => {
      if (notificationFrameRef.current !== null) cancelAnimationFrame(notificationFrameRef.current);
      notificationFrameRef.current = null;
      if (restoreTimerRef.current !== null) clearTimeout(restoreTimerRef.current);
      restoreTimerRef.current = null;
      if (navigationTimerRef.current !== null) clearTimeout(navigationTimerRef.current);
      navigationTimerRef.current = null;
    }, []);

    const metrics = useMemo(() => {
      const offsets: number[] = [];
      let totalHeight = 0;
      for (const message of messages) {
        offsets.push(totalHeight);
        totalHeight += (heightCacheRef.current.get(message.message_key) ?? estimateHeight) + 12;
      }
      metricsRef.current = { offsets, totalHeight };
      return { offsets, totalHeight };
    }, [estimateHeight, measurementVersion, messages]);

    useLayoutEffect(() => {
      const navigation = pendingNavigationRef.current;
      if (navigation && containerRef.current) {
        const node = containerRef.current;
        const index = messagesRef.current.findIndex((message) => message.message_key === navigation.messageKey);
        if (index >= 0) {
          const top = metricsRef.current.offsets[index] ?? 0;
          const height = heightCacheRef.current.get(navigation.messageKey) ?? estimateHeight;
          const nextTop = navigation.align === "center" ? Math.max(0, top - node.clientHeight / 2 + height / 2)
            : navigation.align === "end" ? Math.max(0, top - node.clientHeight + height) : top;
          // Explicit navigation can cross thousands of virtual rows. Jump directly
          // so intermediate posts and their media never mount during an animation.
          node.scrollTo({ top: nextTop, behavior: "instant" as ScrollBehavior });
          lastScrollTopRef.current = node.scrollTop;
          setScrollTop(node.scrollTop);
          if (navigationTimerRef.current !== null) clearTimeout(navigationTimerRef.current);
          navigationTimerRef.current = setTimeout(() => {
            pendingNavigationRef.current = null;
            anchorRef.current = getPosition();
            captureParagraph(anchorRef.current);
          }, 180);
        } else pendingNavigationRef.current = null;
      } else {
        const position = pendingRestoreRef.current ?? anchorRef.current;
        if (position) applyPosition(position);
      }
      if (pendingRestoreRef.current) {
        if (restoreTimerRef.current !== null) clearTimeout(restoreTimerRef.current);
        restoreTimerRef.current = setTimeout(() => {
          pendingRestoreRef.current = null;
          anchorRef.current = getPosition();
          captureParagraph(anchorRef.current);
          notifyPosition();
        }, 180);
      }
    }, [metrics, layoutKey, applyPosition, captureParagraph, estimateHeight, getPosition, notifyPosition]);

    const onMeasure = useCallback((messageKey: string, height: number) => {
      const previous = heightCacheRef.current.get(messageKey);
      if (previous !== undefined && Math.abs(previous - height) < 0.5) return;
      // Capture before replacing measurements so images and typography cannot move the reader.
      if (!pendingRestoreRef.current && !pendingNavigationRef.current) {
        const position = anchorRef.current ?? getPosition();
        const paragraphAnchor = paragraphAnchorRef.current;
        if (position && paragraphAnchor?.messageKey === position.messageKey && containerRef.current) {
          const row = Array.from(containerRef.current.querySelectorAll<HTMLElement>("[data-row-key]")).find((item) => item.dataset.rowKey === position.messageKey);
          const paragraph = row ? Array.from(row.querySelectorAll<HTMLElement>(".reader-message-body [data-paragraph-offset]")).find((item) => item.dataset.paragraphOffset === paragraphAnchor.paragraphOffset) : null;
          if (row && paragraph) {
            const bounds = paragraph.getBoundingClientRect();
            anchorRef.current = { ...position, offset: bounds.top - row.getBoundingClientRect().top + paragraphAnchor.ratio * bounds.height, paragraphOffset: Number(paragraphAnchor.paragraphOffset), paragraphRatio: paragraphAnchor.ratio };
          } else anchorRef.current = position;
        } else anchorRef.current = position;
      }
      heightCacheRef.current.set(messageKey, height);
      setMeasurementVersion((version) => version + 1);
    }, [getPosition]);

    useImperativeHandle(ref, () => ({
      getPosition,
      restorePosition(position) {
        if (!messagesRef.current.some((message) => message.message_key === position.messageKey)) return;
        paragraphAnchorRef.current = null;
        pendingNavigationRef.current = null;
        if (navigationTimerRef.current !== null) clearTimeout(navigationTimerRef.current);
        const paragraphOffset = position.paragraphOffset;
        const paragraphRatio = position.paragraphRatio;
        pendingRestoreRef.current = {
          messageKey: position.messageKey,
          offset: Math.max(0, Number.isFinite(position.offset) ? position.offset : 0),
          ...(paragraphOffset !== undefined && paragraphRatio !== undefined && Number.isSafeInteger(paragraphOffset) && paragraphOffset >= 0 && Number.isFinite(paragraphRatio)
            ? { paragraphOffset, paragraphRatio: Math.max(0, Math.min(1, paragraphRatio)) } : {})
        };
        applyPosition(pendingRestoreRef.current);
        // Trigger an anchor pass even if the target was already mounted.
        setMeasurementVersion((version) => version + 1);
      },
      scrollToIndex(index, align = "start") {
        const node = containerRef.current;
        const message = messagesRef.current[index];
        if (!node || !message) return;
        pendingRestoreRef.current = null;
        paragraphAnchorRef.current = null;
        pendingNavigationRef.current = { messageKey: message.message_key, align };
        // Mount and measure the destination before navigating. Further measurements
        // refine this target rather than applying the previous reading anchor.
        setMeasurementVersion((version) => version + 1);
      }
    }), [applyPosition, estimateHeight, getPosition]);

    const overscanHeight = overscan * estimateHeight;
    const startIndex = messages.length ? binarySearch(metrics.offsets, Math.max(0, scrollTop - overscanHeight)) : 0;
    const endIndex = messages.length ? Math.min(messages.length - 1, binarySearch(metrics.offsets, scrollTop + viewportHeight + overscanHeight) + 2) : 0;

    const visibleIndices = new Set<number>();
    for (let index = startIndex; index <= endIndex && index < messages.length; index += 1) visibleIndices.add(index);
    // A saved offset can be deeper than the estimated height. Always mount its row
    // so measurement can expand the spacer and complete the exact restoration.
    if (pendingRestoreRef.current) {
      const index = messages.findIndex((message) => message.message_key === pendingRestoreRef.current?.messageKey);
      if (index >= 0) visibleIndices.add(index);
    }

    if (pendingNavigationRef.current) {
      const index = messages.findIndex((message) => message.message_key === pendingNavigationRef.current?.messageKey);
      if (index >= 0) visibleIndices.add(index);
    }

    const cancelPendingNavigation = () => {
      pendingRestoreRef.current = null;
      pendingNavigationRef.current = null;
      if (navigationTimerRef.current !== null) clearTimeout(navigationTimerRef.current);
      if (restoreTimerRef.current !== null) clearTimeout(restoreTimerRef.current);
      anchorRef.current = getPosition();
      captureParagraph(anchorRef.current);
    };

    if (!messages.length) return <div className="empty-panel">{emptyState ?? "No messages match the current filter."}</div>;
    return (
      <div className="virtual-list-container" ref={containerRef} style={{ overflowAnchor: "none" }}
        onWheel={cancelPendingNavigation}
        onTouchStart={cancelPendingNavigation}
        onPointerDown={cancelPendingNavigation}
        onKeyDown={(event) => { if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(event.key)) cancelPendingNavigation(); }}
        onScroll={(event) => {
          const top = event.currentTarget.scrollTop;
          const previous = lastScrollTopRef.current;
          lastScrollTopRef.current = top;
          setScrollTop(top);
          if (!pendingRestoreRef.current && !pendingNavigationRef.current) { anchorRef.current = getPosition(); captureParagraph(anchorRef.current); }
          notifyPosition();
          window.dispatchEvent(new CustomEvent("vn-reader-scroll", { detail: { top, direction: top > previous ? "down" : "up" } }));
        }}>
        <div className="virtual-list-spacer" style={{ height: `${metrics.totalHeight}px` }}>
          {[...visibleIndices].sort((left, right) => left - right).map((index) => {
            const message = messages[index];
            return <MeasuredRow key={message.message_key} messageKey={message.message_key} offsetTop={metrics.offsets[index] ?? 0} onMeasure={onMeasure}>
              {renderMessage(message, index)}
            </MeasuredRow>;
          })}
        </div>
      </div>
    );
  }
);
export default VirtualizedMessageList;
