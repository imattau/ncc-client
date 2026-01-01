import DOMPurify from "dompurify";
import { marked } from "marked";
import { nip19 } from "nostr-tools";
import type { NostrEvent } from "../types/events";
import { LruCache } from "../utils/lruCache";
import { extractHashtags, extractNostrUris, extractUrls } from "../utils/hashtags";
import { parseNaddrUri, type NaddrReference } from "../utils/nostrUri";

export type PostRenderResult = {
  previewText: string;
  needsPreview: boolean;
  usesMarkdown: boolean;
  sanitizedHtml?: string;
  hashtags: string[];
  links: string[];
  naddrReferences: NaddrReference[];
  embeddedEvent?: NostrEvent;
};

export interface PostRendererOptions {
  previewLength?: number;
  cacheSize?: number;
  resolveEvent?: (id: string) => NostrEvent | undefined;
  onMissingReference?: (id: string) => void;
}

const DEFAULT_PREVIEW_LENGTH = 220;
const DEFAULT_CACHE_SIZE = 160;

type PostHandler = (event: NostrEvent, expanded: boolean) => PostRenderResult;

export class PostRenderer {
  private readonly previewLength: number;
  private readonly cache: LruCache<string, string>;
  private readonly resolveEvent?: (id: string) => NostrEvent | undefined;
  private readonly onMissingReference?: (id: string) => void;

  constructor(options?: PostRendererOptions) {
    this.previewLength = options?.previewLength ?? DEFAULT_PREVIEW_LENGTH;
    this.cache = new LruCache(options?.cacheSize ?? DEFAULT_CACHE_SIZE);
    this.resolveEvent = options?.resolveEvent;
    this.onMissingReference = options?.onMissingReference;
  }

  render(event: NostrEvent, expanded: boolean): PostRenderResult {
    const handler = this.getHandler(event);
    return handler(event, expanded);
  }

  private getHandler(event: NostrEvent): PostHandler {
    if (event.kind === 7) {
      return this.renderReaction;
    }
    if (event.kind === 30059) {
      return this.renderServiceRecord;
    }
    if (event.kind === 1059) {
      return this.renderRepost;
    }
    if (event.kind === 9735) {
      return this.renderZap;
    }
    if (event.kind === 3) {
      return this.renderContacts;
    }
    return this.renderTextual;
  }

  private renderTextual: PostHandler = (event, expanded) => {
    const content = event.content ?? "";
    const needsPreview = content.length > this.previewLength;
    const previewText = needsPreview && !expanded ? `${content.slice(0, this.previewLength)}…` : content;
    const highlightMarkdown = this.shouldHighlight(event, content);
    const sanitizedHtml =
      highlightMarkdown && expanded ? this.sanitize(content, event.id, highlightMarkdown) : undefined;

    const hashtags = extractHashtags(content);
    const links = extractUrls(content);
    const embeddedEvent = this.resolveReferencedEvent(content);
    const naddrReferences = extractNostrUris(content)
      .map((uri) => parseNaddrUri(uri))
      .filter((ref): ref is NaddrReference => Boolean(ref));

    return {
      previewText,
      needsPreview,
      usesMarkdown: highlightMarkdown,
      sanitizedHtml,
      hashtags,
      links,
      naddrReferences,
      embeddedEvent
    };
  };

  private renderReaction: PostHandler = (event) => {
    const reactionContent = event.content?.trim() || "reaction";
    const referenceId = event.tags?.find((tag) => tag[0] === "e")?.[1];
    const previewText = referenceId ? `Reaction to ${referenceId}` : reactionContent;
    return {
      previewText,
      needsPreview: false,
      usesMarkdown: false,
      hashtags: [],
      links: [],
      naddrReferences: []
    };
  };

  private renderServiceRecord: PostHandler = (event) => ({
    previewText: `Service record · thumb ${event.tags?.find((tag) => tag[0] === "k")?.[1] ?? "unknown"}`,
    needsPreview: false,
    usesMarkdown: false,
    hashtags: [],
    links: [],
    naddrReferences: []
  });

  private renderRepost: PostHandler = (event) => {
    const referenceId = event.tags?.find((tag) => tag[0] === "e")?.[1];
    const referencedEvent = referenceId ? this.resolveEvent?.(referenceId) : undefined;
    if (referenceId && !referencedEvent) {
      this.onMissingReference?.(referenceId);
    }
    const snippet = referencedEvent ? this.renderExcerpt(referencedEvent) : undefined;
    const previewText = referencedEvent
      ? `Repost · ${snippet}`
      : referenceId
      ? `Repost of ${referenceId}`
      : "Repost";

      return {
        previewText,
        needsPreview: false,
        usesMarkdown: false,
        hashtags: [],
        links: [],
        naddrReferences: []
      };
  };

  private renderContacts: PostHandler = (event) => {
    const contactNames = event.tags
      ?.filter((tag) => tag[0] === "p")
      .map((tag) => tag[1])
      .slice(0, 3);
    const previewText = contactNames
      ? `Contacts: ${contactNames.join(", ")}${contactNames.length > 3 ? ", …" : ""}`
      : "Contacts updated";
    return {
      previewText,
      needsPreview: false,
      usesMarkdown: false,
      hashtags: [],
      links: [],
      naddrReferences: []
    };
  };

  private renderZap: PostHandler = (event) => {
    const amountTag = event.tags?.find((tag) => tag[0] === "amount")?.[1];
    const lnurl = event.tags?.find((tag) => tag[0] === "bolt11")?.[1];
    const previewText = amountTag
      ? `Zap · amount ${amountTag} sats`
      : lnurl
      ? "Zap · lightning invoice"
      : "Zap event";
    return {
      previewText,
      needsPreview: false,
      usesMarkdown: false,
      hashtags: [],
      links: [],
      naddrReferences: []
    };
  };

  private sanitize(text: string, key: string, highlight: boolean) {
    const cacheKey = `${highlight ? "md" : "plain"}:${key}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const sanitized = highlight
      ? DOMPurify.sanitize((marked.parse(text) as string) ?? "")
      : DOMPurify.sanitize(text.replace(/\n/g, "<br/>"));
    this.cache.set(cacheKey, sanitized);
    return sanitized;
  }

  private shouldHighlight(event: NostrEvent, content: string) {
    if (event.isArticle || event.kind === 30023) return true;
    return PostRenderer.detectMarkdown(content);
  }

  private static detectMarkdown(text: string) {
    if (!text) return false;
    const markers = [/^#{1,6}\s+/m, /^([-*]|\+)\s+/m, /^>\s+/m, /```/, /\[[^\]]+\]\([^)]+\)/];
    return markers.some((pattern) => pattern.test(text));
  }

  private renderExcerpt(event: NostrEvent) {
    const content = event.content ?? "";
    if (!content) return "referenced post";
    if (content.length <= this.previewLength) return content;
    return `${content.slice(0, this.previewLength)}…`;
  }

  private resolveReferencedEvent(content: string): NostrEvent | undefined {
    const uris = extractNostrUris(content);
    for (const uri of uris) {
      const referenced = this.decodeNostrUri(uri);
      if (!referenced?.id) continue;
      const event = this.resolveEvent?.(referenced.id);
      if (!event) {
        this.onMissingReference?.(referenced.id);
        continue;
      }
      return event;
    }
    return undefined;
  }

  private decodeNostrUri(uri: string) {
    if (!uri) return null;
    try {
      const parsed = nip19.decode(uri);
      if (parsed.type === "nevent" && parsed.data?.id) {
        return parsed.data as { id: string };
      }
    } catch {
      return null;
    }
    return null;
  }
}
