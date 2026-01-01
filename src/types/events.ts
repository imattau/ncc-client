export type Attachment = {
  url?: string;
  type?: "image" | "video" | "audio" | "playlist" | "file";
  description?: string;
};

export interface NostrEvent {
  id: string;
  kind: number;
  author: string;
  content: string;
  created_at: number;
  tags?: string[][];
  likes?: number;
  reposts?: number;
  relays?: string[];
  attachments?: Attachment[];
  isArticle?: boolean;
  isServiceRecord?: boolean;
}
