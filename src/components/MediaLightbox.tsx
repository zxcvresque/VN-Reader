import { useEffect } from "react";

export interface LightboxMedia {
  url: string;
  kind: string | null;
  caption?: string;
}

interface MediaLightboxProps {
  media: LightboxMedia | null;
  onClose: () => void;
}

export default function MediaLightbox({ media, onClose }: MediaLightboxProps) {
  useEffect(() => {
    if (!media) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // Lock body scroll
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [media, onClose]);

  if (!media) return null;

  const isVideo = media.kind === "video" || media.kind === "animation";
  const isAudio = media.kind === "audio";

  return (
    <div
      className="lightbox-overlay"
      role="dialog"
      aria-modal="true"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button
        type="button"
        className="lightbox-close"
        onClick={onClose}
        aria-label="Close (Esc)"
      >
        ×
      </button>

      <div className="lightbox-stage" onClick={onClose}>
        {isVideo ? (
          <video
            className="lightbox-media"
            src={media.url}
            controls
            autoPlay
            onClick={(event) => event.stopPropagation()}
          />
        ) : isAudio ? (
          <audio
            className="lightbox-audio"
            src={media.url}
            controls
            autoPlay
            onClick={(event) => event.stopPropagation()}
          />
        ) : (
          <img
            className="lightbox-media"
            src={media.url}
            alt={media.caption ?? ""}
            onClick={(event) => event.stopPropagation()}
          />
        )}
      </div>

      {media.caption ? <div className="lightbox-caption">{media.caption}</div> : null}
    </div>
  );
}
