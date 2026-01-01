import { PlaylistPlayer } from "./PlaylistPlayer";
import { MediaManager } from "../utils/mediaManager";
import { getDomain } from "../utils/hashtags";
import { useInView } from "../hooks/useInView";
import { useEffect, useState } from "react";

const failedPreviewCache = new Set<string>();

interface LinkPreviewProps {
  url: string;
}

export function LinkPreview({ url }: LinkPreviewProps) {
  const [ref, visible] = useInView<HTMLElement>();
  const [failed, setFailed] = useState(() => failedPreviewCache.has(url));
  const type = MediaManager.getMediaType(url);
  const domain = getDomain(url);

  useEffect(() => {
    setFailed(failedPreviewCache.has(url));
  }, [url]);

  const markFailed = () => {
    failedPreviewCache.add(url);
    setFailed(true);
  };

  const renderMedia = () => {
    if (failed) {
      return (
        <div className="link-preview-placeholder">
          <span className="link-preview-placeholder-title">Preview unavailable</span>
          <span className="link-preview-placeholder-subtitle">Tap to open</span>
        </div>
      );
    }
    if (!visible) {
      return <div className="attachment-media-placeholder" />;
    }

    switch (type) {
      case "image":
        return <img src={url} alt={`Preview of ${domain}`} loading="lazy" onError={markFailed} />;
      case "video":
        return (
          <video src={url} controls playsInline muted preload="metadata" onError={markFailed}>
            Your browser does not support inline previews.
          </video>
        );
      case "audio":
        return (
          <audio src={url} controls preload="metadata" onError={markFailed}>
            Your browser does not support inline audio.
          </audio>
        );
      case "playlist":
        return <PlaylistPlayer src={url} onError={markFailed} />;
      default:
        return (
          <div className="link-preview-placeholder">
            <span className="link-preview-placeholder-title">Preview unavailable</span>
            <span className="link-preview-placeholder-subtitle">Tap to open</span>
          </div>
        );
    }
  };

  return (
    <article ref={ref} className={`link-preview-card link-preview-${type}`}>
      <div className="link-preview-media">{renderMedia()}</div>
      <div className="link-preview-meta">
        <span className="link-preview-domain">{domain}</span>
        <a href={url} target="_blank" rel="noreferrer" className="link-preview-action">
          Open link
        </a>
      </div>
    </article>
  );
}
