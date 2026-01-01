import { useEffect, useRef } from "react";
import { MediaManager } from "../utils/mediaManager";

interface PlaylistPlayerProps {
  src: string;
  onError?: (errorMessage?: string) => void;
}

export function PlaylistPlayer({ src, onError }: PlaylistPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const cleanup = MediaManager.attachPlaylist(video, src);
    return cleanup;
  }, [src]);

  return (
    <video
      ref={videoRef}
      className="attachment-item"
      controls
      playsInline
      muted
      preload="metadata"
      onError={(event) => onError?.((event.target as HTMLVideoElement)?.error?.message ?? "Playlist load failed")}
    />
  );
}
