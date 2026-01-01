import { PlaylistPlayer } from "./PlaylistPlayer";
import { MediaManager } from "../utils/mediaManager";
import { getDomain } from "../utils/hashtags";

interface LinkPreviewProps {
  url: string;
}

export function LinkPreview({ url }: LinkPreviewProps) {
  const type = MediaManager.getMediaType(url);
  const domain = getDomain(url);

  const renderMedia = () => {
    switch (type) {
      case "image":
        return <img src={url} alt={`Preview of ${domain}`} loading="lazy" />;
      case "video":
        return (
          <video src={url} controls playsInline muted preload="metadata">
            Your browser does not support inline previews.
          </video>
        );
      case "audio":
        return (
          <audio src={url} controls preload="metadata">
            Your browser does not support inline audio.
          </audio>
        );
      case "playlist":
        return <PlaylistPlayer src={url} />;
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
    <article className={`link-preview-card link-preview-${type}`}>
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
