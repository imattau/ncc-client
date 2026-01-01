import Hls from "hls.js";

export type MediaType = "image" | "video" | "playlist" | "audio" | "link" | "unknown";

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "avif"];
const VIDEO_EXTENSIONS = ["mp4", "mov", "webm", "mkv"];
const AUDIO_EXTENSIONS = ["mp3", "wav", "ogg", "m4a", "flac", "aac"];
const PLAYLIST_PATTERN = /\.m3u8$/i;

const extractExtension = (url: string) => {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/");
    const last = segments[segments.length - 1];
    if (!last) return null;
    const parts = last.split(".");
    if (parts.length < 2) return null;
    return parts[parts.length - 1].toLowerCase();
  } catch {
    return null;
  }
};

type IframeAttributes = {
  src: string;
  sandbox: "allow-popups allow-popups-to-escape-sandbox";
  loading: "lazy";
  referrerPolicy: "no-referrer";
};

export class MediaManager {
  static isPlaylist(url: string) {
    return PLAYLIST_PATTERN.test(url);
  }

  static getMediaType(url: string, attachmentType?: string): MediaType {
    if (!url) return "unknown";
    const normalizedType = attachmentType?.toLowerCase();
    switch (normalizedType) {
      case "image":
        return "image";
      case "video":
        return MediaManager.isPlaylist(url) ? "playlist" : "video";
      case "audio":
        return "audio";
      case "playlist":
        return "playlist";
      case "file":
        break;
      default:
        break;
    }

    if (MediaManager.isPlaylist(url)) return "playlist";

    const ext = extractExtension(url);
    if (ext) {
      if (IMAGE_EXTENSIONS.includes(ext)) return "image";
      if (VIDEO_EXTENSIONS.includes(ext)) return "video";
      if (AUDIO_EXTENSIONS.includes(ext)) return "audio";
    }

    try {
      const parsed = new URL(url);
      const protocol = parsed.protocol.toLowerCase();
      if (protocol === "http:" || protocol === "https:") {
        return "link";
      }
    } catch {
      //
    }

    return "unknown";
  }

  static isVisualMedia(url: string) {
    const type = MediaManager.getMediaType(url);
    return type === "image" || type === "video" || type === "playlist" || type === "audio";
  }

  static isAudioLink(url: string) {
    return MediaManager.getMediaType(url) === "audio";
  }

  static getIframeAttributes(url: string): IframeAttributes {
    return {
      src: url,
      sandbox: "allow-popups allow-popups-to-escape-sandbox",
      loading: "lazy",
      referrerPolicy: "no-referrer"
    };
  }

  static attachPlaylist(videoElement: HTMLVideoElement, src: string) {
    if (videoElement.canPlayType("application/vnd.apple.mpegurl")) {
      videoElement.src = src;
      return () => {};
    }

    if (Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(src);
      hls.attachMedia(videoElement);
      return () => {
        hls.destroy();
      };
    }

    videoElement.src = src;
    return () => {};
  }
}
