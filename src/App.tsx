import {
  ChangeEvent,
  FormEvent,
  KeyboardEvent,
  SyntheticEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import QRCode from "qrcode";
import { BunkerSigner, createNostrConnectURI, parseBunkerInput } from "nostr-tools/nip46";
import { useNccClient } from "./hooks/useNccClient";
import { useNcc02Discovery } from "./hooks/useNcc02Discovery";
import { appErrorManager } from "./utils/errorManager";
import { publishEvent, getRelayPool } from "./services/nccClient";
import type { Attachment, NostrEvent } from "./types/events";
import { DEFAULT_RELAYS } from "./config/relays";
import { Filter, finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import type { Event as NostrToolsEvent } from "nostr-tools";
import { AuthManager, type AuthSession } from "./services/authManager";
import { RelayManager } from "./services/relayManager";
import { UserManager, type Profile } from "./services/userManager";
import { PostRenderer } from "./renderers/postRenderer";
import { useRelayWorker } from "./hooks/useRelayWorker";
import { extractHashtags } from "./utils/hashtags";
import { PlaylistPlayer } from "./components/PlaylistPlayer";
import { MediaManager } from "./utils/mediaManager";
import { LinkPreview } from "./components/LinkPreview";
import SearchPanel from "./components/SearchPanel";
import { SearchManager } from "./services/searchManager";
import type { SearchEntry } from "./types/search";
import { useInView } from "./hooks/useInView";
import { NostrService, setSleepingRelays } from "./services/nostrService";
import {
  classifyNccDiscoveryEvent,
  INITIAL_NCC_STATS,
  type NccDiscoveryStats,
  type NccDiscoveryType
} from "./utils/nccDiscovery";
import { readCachedEvents } from "./utils/eventCache";
import type { RelayWorkerStatus } from "./workers/relayWorker.handlers";
import { StatusBar } from "./components/StatusBar";

const canonicalizePubkey = (value?: string | null) => {
  if (!value) return null;
  const normalized = NostrService.parsePubkeyFromInput(value);
  if (normalized) return normalized;
  if (/^[0-9a-f]{64}$/i.test(value)) {
    return value.toLowerCase();
  }
  return null;
};

const describeMediaError = (error: MediaError | null | undefined) => {
  if (!error) return "Unknown media error";
  if (error.message) {
    return `${error.message} (code ${error.code ?? "unknown"})`;
  }
  return `Media error code ${error.code ?? "unknown"}`;
};

const FOLLOWING_AUTHORS = ["@alice", "@nate", "@lena"];
const USER_PRIVATE_KEY = generateSecretKey();
const USER_PUBLIC_KEY = getPublicKey(USER_PRIVATE_KEY);
const COLUMN_FILL_TARGET = 200;
const LOCAL_STORAGE_CACHE_DEFAULT = 100;
const INDEXED_DB_CACHE_DEFAULT = 500;
const CACHED_EVENTS_KEY = "ncc-client-cached-events";

const SERVICE_ID = "ncc-client-demo";

const formatAgo = (timestamp: number) => {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "moments ago";
  if (diff < 3_600_000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3600000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
};

const CONTENT_PREVIEW_LENGTH = 220;
const PENDING_FLUSH_CHUNK = 40;
const PULL_THRESHOLD = 80;
const MAX_PULL_DISTANCE = 120;

const kindLabel = (event: NostrEvent) => {
  if (event.isServiceRecord) return `Service · kind ${event.kind}`;
  if (event.isArticle) return "Article · kind 30023";
  if (event.kind === 1) return "Note · kind 1";
  return `Kind ${event.kind}`;
};

const authManager = new AuthManager();
const AUTH_SECRET_KEY = authManager.getSecretKey();
const AUTH_PUBLIC_KEY = authManager.getPublicKey();

const formatAuthorDisplay = (author: string) => {
  if (!author) return "unknown";
  if (author.startsWith("npub") && author.length > 15) {
    return `${author.slice(0, 10)}…`;
  }
  if (author.length > 12 && !author.startsWith("@")) {
    return `${author.slice(0, 6)}…${author.slice(-4)}`;
  }
  return author;
};

const formatShortPubkey = (pubkey: string) => {
  if (pubkey.startsWith("npub")) {
    return formatAuthorDisplay(pubkey);
  }
  if (!pubkey) return "unknown";
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-6)}`;
};

const mapNostrToolsEvent = (event: NostrToolsEvent): NostrEvent => ({
  id: event.id,
  kind: event.kind,
  author: event.pubkey,
  content: event.content,
  created_at: event.created_at * 1000,
  tags: event.tags,
  relays: [],
  isArticle: event.kind === 30023,
  isServiceRecord: event.kind === 30059
});

const TWO_WEEKS_SECONDS = 14 * 24 * 60 * 60;
const BASE_KIND_FILTERS: Filter[] = [
  { kinds: [1], limit: 60 },
  { kinds: [30023], limit: 40 },
  { kinds: [0], limit: 80 }
];
const REACTION_FILTER: Filter = { kinds: [6, 7], limit: 100 };
const SERVICE_RECORD_FILTER: Filter = { kinds: [30058, 30059, 30060, 30061], limit: 50 };
const buildDefaultBaseFilters = (includeReactions: boolean, includeServiceRecords: boolean): Filter[] => {
  const filters = [...BASE_KIND_FILTERS];
  if (includeReactions) {
    filters.push(REACTION_FILTER);
  }
  if (includeServiceRecords) {
    filters.push(SERVICE_RECORD_FILTER);
  }
  return filters;
};
// Helper ensures public filters remain active for the global feed, even when signed in.
const buildFollowingBaseFilters = (
  followingAuthorsHex: string[],
  includeReactions: boolean,
  includeServiceRecords: boolean
): Filter[] => {
  const filters = buildDefaultBaseFilters(includeReactions, includeServiceRecords);
  if (!followingAuthorsHex.length) {
    return filters;
  }
  filters.push({
    authors: followingAuthorsHex,
    kinds: [0, 1, 30023],
    since: Math.floor(Date.now() / 1000) - TWO_WEEKS_SECONDS,
    limit: 200
  });
  return filters;
};
const INITIAL_BASE_FILTERS = buildDefaultBaseFilters(true, true);

const failedImageCache = new Set<string>();
const failedVideoCache = new Set<string>();
const failedAvatarCache = new Set<string>();

const CACHE_BATCH_SIZE = 80;
const PREFETCH_CACHE_LIMIT = 3;
const PREFETCH_THRESHOLD = 200;
const FEED_INCREMENT = 20;

const STAT_KEY_MAP: Record<NccDiscoveryType, keyof NccDiscoveryStats> = {
  serviceRecord: "serviceRecords",
  locator: "locators",
  attestation: "attestations",
  revocation: "revocations"
};

type QrStateStatus = "idle" | "waiting" | "connected" | "error";

type QrState = {
  uri: string | null;
  dataUrl: string | null;
  status: QrStateStatus;
  secret: string | null;
};

const INITIAL_QR_STATE: QrState = {
  uri: null,
  dataUrl: null,
  status: "idle",
  secret: null
};

type TimelineFilterId = "following" | "articles" | "serviceRecords" | "locators" | "conventions";

const FILTER_DEFINITIONS: { id: TimelineFilterId; label: string }[] = [
  { id: "following", label: "Following" },
  { id: "articles", label: "Articles" },
  { id: "serviceRecords", label: "Service Records" },
  { id: "locators", label: "NCC-05 Locators" },
  { id: "conventions", label: "Conventions" }
];

const MAX_EVENTS_IN_MEMORY = 320;
const MAX_INCOMING_QUEUE = 200;
const MAX_HISTORIC_RELAYS = 3;
const MAX_TAGS_PER_EVENT = 12;
const TAG_WHITELIST = new Set(["e", "p", "#", "a", "r", "t"]);

const clampEvents = (list: NostrEvent[]) => list.slice(0, MAX_EVENTS_IN_MEMORY);

const sanitizeEventForMemory = (event: NostrEvent): NostrEvent => {
  const { attachments, tags, relays, ...rest } = event;
  const trimmedTags =
    tags
      ?.filter((tag) => Array.isArray(tag) && typeof tag[0] === "string" && TAG_WHITELIST.has(tag[0]))
      .slice(0, MAX_TAGS_PER_EVENT) ?? undefined;
  return {
    ...rest,
    attachments: attachments?.slice(0, 1),
    tags: trimmedTags,
    relays: relays?.slice(0, MAX_HISTORIC_RELAYS)
  };
};

const App = () => {
  const { connected, refresh } = useNccClient();
  const { service: discovery, status: discoveryStatus, error: discoveryError } = useNcc02Discovery(
    USER_PUBLIC_KEY,
    SERVICE_ID
  );
  const userManagerRef = useRef<UserManager>();
  if (!userManagerRef.current) {
    userManagerRef.current = new UserManager({
      baseFollowing: FOLLOWING_AUTHORS,
      profileCacheSize: 512
    });
  }
  const userManager = userManagerRef.current;
  const relayManagerRef = useRef<RelayManager>();
  if (!relayManagerRef.current) {
    relayManagerRef.current = new RelayManager(DEFAULT_RELAYS, { ncc05SecretKey: AUTH_SECRET_KEY });
  }
  const relayManager = relayManagerRef.current;
  const [managedRelays, setManagedRelays] = useState<string[]>(() => relayManager.getRelays());
  const [includeReactions, setIncludeReactions] = useState(true);
  const [includeServiceRecords, setIncludeServiceRecords] = useState(true);
  const [localCacheLimit, setLocalCacheLimit] = useState(LOCAL_STORAGE_CACHE_DEFAULT);
  const [indexedDbCacheLimit, setIndexedDbCacheLimit] = useState(INDEXED_DB_CACHE_DEFAULT);
  const [isLoadingMoreCache, setIsLoadingMoreCache] = useState(false);
  const [hasMoreCacheEvents, setHasMoreCacheEvents] = useState(true);
  const cacheLoadedRef = useRef(0);
  const hasMoreCacheEventsRef = useRef(true);
  const isLoadingCacheRef = useRef(false);
  const globalSentinelRef = useRef<HTMLDivElement>(null);
  const [events, setEvents] = useState<NostrEvent[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(CACHED_EVENTS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const eventsById = useMemo(() => {
    const map = new Map<string, NostrEvent>();
    events.forEach((event) => map.set(event.id, event));
    return map;
  }, [events]);
  const eventsByIdRef = useRef(eventsById);
  eventsByIdRef.current = eventsById;

  const [mutedAuthors, setMutedAuthors] = useState<string[]>(() => userManager.getMutedAuthors());
  const [likedEvents, setLikedEvents] = useState<string[]>([]);
  const [repostedEvents, setRepostedEvents] = useState<string[]>([]);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [draft, setDraft] = useState({ content: "", type: "note" });
  const [attachedFile, setAttachedFile] = useState<File | null>(null);
  const [globalLimit, setGlobalLimit] = useState(20);
  const [pendingEvents, setPendingEvents] = useState<NostrEvent[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Profile>>(() => userManager.getProfiles());
  const [nccStats, setNccStats] = useState<NccDiscoveryStats>(() => ({ ...INITIAL_NCC_STATS }));
  const nccDiscoverySeenRef = useRef<Set<string>>(new Set());
  const deletedEventIdsRef = useRef<Set<string>>(new Set());
  const [expandedPosts, setExpandedPosts] = useState<Set<string>>(new Set());
  const [pullDistance, setPullDistance] = useState(0);
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const profileChipRef = useRef<HTMLButtonElement>(null);
  const signInMenuRef = useRef<HTMLDivElement>(null);
  const profileModalRef = useRef<HTMLDivElement>(null);
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);
  const [isSignInMenuOpen, setIsSignInMenuOpen] = useState(false);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [bunkerInput, setBunkerInput] = useState("");
  const [bunkerStatus, setBunkerStatus] = useState<string | null>(null);
  const [nsecInput, setNsecInput] = useState("");
  const [qrState, setQrState] = useState<QrState>(INITIAL_QR_STATE);
  const signerRef = useRef<BunkerSigner | null>(null);
  const [activeHashtag, setActiveHashtag] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [userFollowing, setUserFollowing] = useState<string[]>(() => userManager.getFollowingList());
  const [userFollowers, setUserFollowers] = useState<string[]>(() => userManager.getFollowersList());
  const [isRelayModalOpen, setIsRelayModalOpen] = useState(false);
  const relayModalRef = useRef<HTMLDivElement>(null);
  const [relayInput, setRelayInput] = useState("");
  const [relayMessage, setRelayMessage] = useState<{ type: "info" | "error"; text: string } | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchManagerRef = useRef<SearchManager>();
  const [relayStatus, setRelayStatus] = useState<RelayWorkerStatus | null>(null);
  const [isOfflineMode, setIsOfflineMode] = useState(false);
  const MEDIA_BLOCK_KEY = "ncc-blocked-media-hosts";
  const [blockedMediaHosts, setBlockedMediaHosts] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const stored = window.localStorage.getItem(MEDIA_BLOCK_KEY);
      if (!stored) return new Set();
      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.filter((item) => typeof item === "string"));
    } catch {
      return new Set();
    }
  });
  const blockedMediaHostsRef = useRef<Set<string>>(blockedMediaHosts);
  const [activeFilters, setActiveFilters] = useState<TimelineFilterId[]>([]);
  const [focusedEventId, setFocusedEventId] = useState<string | null>(null);
  const focusedEvent = focusedEventId ? eventsById.get(focusedEventId) ?? null : null;
  if (!searchManagerRef.current) {
    searchManagerRef.current = new SearchManager();
  }
  const remoteSearchCacheRef = useRef({
    profiles: new Set<string>(),
    events: new Set<string>(),
    hashtags: new Set<string>(),
    keywords: new Set<string>()
  });
  const fetchedProfilesRef = useRef<Set<string>>(new Set());
  const processedKind0Ref = useRef<Set<string>>(new Set());
  const cacheFlushTimeoutRef = useRef<number | null>(null);
  const cacheWorkerRef = useRef<Worker | null>(null);
  const pullStartRef = useRef<number | null>(null);
  const pullTargetRef = useRef<HTMLDivElement | null>(null);
  const pullDistanceRef = useRef<number>(0);
  const manualRefreshRef = useRef(false);
  const incomingEventsRef = useRef<NostrEvent[]>([]);
  const pendingCommitRef = useRef<NostrEvent[]>([]);
  const commitScheduledRef = useRef(false);
  const queueFlushScheduledRef = useRef(false);
  const queueFlushTimeoutRef = useRef<number | null>(null);
  const prefetchedRowsRef = useRef(new Map<number, NostrEvent[]>());
  const prefetchInProgressRef = useRef(new Set<number>());
  const lastScrollYRef = useRef(0);
  const scrollStateRef = useRef({ scrollY: 0, direction: "down" as "up" | "down" });
  const scrollFrameRequestedRef = useRef(false);

  const processIncomingBatch = useCallback(() => {
    queueFlushScheduledRef.current = false;
    if (queueFlushTimeoutRef.current !== null) {
      window.clearTimeout(queueFlushTimeoutRef.current);
      queueFlushTimeoutRef.current = null;
    }
    if (!incomingEventsRef.current.length) return;
    const incomingBatch = incomingEventsRef.current.splice(0, PENDING_FLUSH_CHUNK);
    const filtered = incomingBatch.filter((event) => !deletedEventIdsRef.current.has(event.id));
    if (!filtered.length) {
      if (incomingEventsRef.current.length) {
        queueFlushScheduledRef.current = true;
        queueFlushTimeoutRef.current = window.setTimeout(processIncomingBatch, 50);
      }
      return;
    }
    setPendingEvents((prev) => {
      const seen = new Set(prev.map((existing) => existing.id));
      const deduped = filtered.filter((event) => !seen.has(event.id));
      const merged = [...deduped, ...prev];
      return merged.slice(0, 40);
    });
    if (incomingEventsRef.current.length) {
      queueFlushScheduledRef.current = true;
      queueFlushTimeoutRef.current = window.setTimeout(processIncomingBatch, 50);
    }
  }, []);

  useEffect(() => {
    const worker = new Worker(new URL("./workers/cacheWorker.ts", import.meta.url), { type: "module" });
    cacheWorkerRef.current = worker;
    return () => {
      worker.terminate();
      cacheWorkerRef.current = null;
    };
  }, []);

  const scheduleIncomingFlush = useCallback(() => {
    if (queueFlushScheduledRef.current) return;
    queueFlushScheduledRef.current = true;
    queueFlushTimeoutRef.current = window.setTimeout(processIncomingBatch, 50);
  }, [processIncomingBatch]);

  useEffect(() => {
    queueFlushScheduledRef.current = false;
    return () => {
      if (queueFlushTimeoutRef.current !== null) {
        window.clearTimeout(queueFlushTimeoutRef.current);
        queueFlushTimeoutRef.current = null;
      }
    };
  }, []);
  const authFilters = useMemo<Filter[]>(() => {
    if (!authSession?.pubkey) return [];
    return [
      {
        authors: [authSession.pubkey],
        kinds: [1, 30023],
        limit: 40
      },
      {
        kinds: [3],
        authors: [authSession.pubkey],
        limit: 40
      },
      {
        kinds: [3],
        "#p": [authSession.pubkey],
        limit: 40
      }
    ];
  }, [authSession?.pubkey]);
  const isSignedIn = Boolean(authSession);
  const canonicalAuthPubkey = useMemo(() => {
    if (!authSession?.pubkey) return null;
    const normalized = NostrService.parsePubkeyFromInput(authSession.pubkey);
    return normalized ?? authSession.pubkey.toLowerCase();
  }, [authSession?.pubkey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(CACHED_EVENTS_KEY, JSON.stringify(events.slice(0, localCacheLimit)));
    } catch {
      // ignore persistence failures
    }
    if (!cacheWorkerRef.current) return;
    if (cacheFlushTimeoutRef.current) {
      window.clearTimeout(cacheFlushTimeoutRef.current);
    }
    cacheFlushTimeoutRef.current = window.setTimeout(() => {
      const cacheEntries = clampEvents(events).slice(0, indexedDbCacheLimit);
      cacheWorkerRef.current?.postMessage({
        type: "cache",
        entries: cacheEntries
      });
    }, 400);

    return () => {
      if (cacheFlushTimeoutRef.current) {
        window.clearTimeout(cacheFlushTimeoutRef.current);
        cacheFlushTimeoutRef.current = null;
      }
    };
  }, [events, localCacheLimit, indexedDbCacheLimit]);

  const trimPrefetchCache = useCallback(() => {
    const cache = prefetchedRowsRef.current;
    while (cache.size > PREFETCH_CACHE_LIMIT) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      cache.delete(oldestKey);
    }
  }, []);

  const schedulePrefetchCacheRow = useCallback(
    (offset: number) => {
      if (!hasMoreCacheEventsRef.current || offset >= indexedDbCacheLimit) return;
      const normalizedOffset = Math.max(0, offset);
      if (
        prefetchedRowsRef.current.has(normalizedOffset) ||
        prefetchInProgressRef.current.has(normalizedOffset)
      ) {
        return;
      }
      prefetchInProgressRef.current.add(normalizedOffset);
      void readCachedEvents(CACHE_BATCH_SIZE, normalizedOffset)
        .then((batch) => {
          if (!batch.length) return;
          const sanitized = batch.map((event) => sanitizeEventForMemory(event));
          prefetchedRowsRef.current.set(normalizedOffset, sanitized);
          trimPrefetchCache();
        })
        .finally(() => {
          prefetchInProgressRef.current.delete(normalizedOffset);
        });
    },
    [indexedDbCacheLimit, trimPrefetchCache]
  );

  const loadNextCacheBatch = useCallback(async () => {
    if (typeof window === "undefined") return;
    if (!hasMoreCacheEventsRef.current || isLoadingCacheRef.current) return;
    if (cacheLoadedRef.current >= indexedDbCacheLimit) {
      hasMoreCacheEventsRef.current = false;
      setHasMoreCacheEvents(false);
      return;
    }
    isLoadingCacheRef.current = true;
    setIsLoadingMoreCache(true);
    const offset = cacheLoadedRef.current;
    let batch: NostrEvent[] = [];
    const prefetched = prefetchedRowsRef.current.get(offset);
    if (prefetched) {
      batch = prefetched;
      prefetchedRowsRef.current.delete(offset);
    } else {
      const fetched = await readCachedEvents(CACHE_BATCH_SIZE, offset);
      batch = fetched.map((event) => sanitizeEventForMemory(event));
    }
    cacheLoadedRef.current += batch.length;
    setEvents((prev) => {
      const pool = new Map<string, NostrEvent>();
      prev.forEach((event) => pool.set(event.id, event));
      batch.forEach((event) => pool.set(event.id, event));
      const merged = Array.from(pool.values()).sort((a, b) => b.created_at - a.created_at);
      return clampEvents(merged);
    });
    setGlobalLimit((prev) => Math.min(prev + batch.length, indexedDbCacheLimit));
    void schedulePrefetchCacheRow(cacheLoadedRef.current);
    if (batch.length < CACHE_BATCH_SIZE || cacheLoadedRef.current >= indexedDbCacheLimit) {
      hasMoreCacheEventsRef.current = false;
      setHasMoreCacheEvents(false);
    }
    isLoadingCacheRef.current = false;
    setIsLoadingMoreCache(false);
  }, [indexedDbCacheLimit, setGlobalLimit]);

  useEffect(() => {
    cacheLoadedRef.current = 0;
    hasMoreCacheEventsRef.current = true;
    setHasMoreCacheEvents(true);
    setEvents((prev) => clampEvents(prev.slice(0, indexedDbCacheLimit)));
    void loadNextCacheBatch();
  }, [loadNextCacheBatch, indexedDbCacheLimit]);

  const processScroll = useCallback(() => {
    scrollFrameRequestedRef.current = false;
    const { scrollY, direction } = scrollStateRef.current;
    if (!hasMoreCacheEventsRef.current || isLoadingCacheRef.current) return;
    const nearBottom = window.innerHeight + scrollY >= document.documentElement.scrollHeight - PREFETCH_THRESHOLD;
    if (nearBottom) {
      void loadNextCacheBatch();
      return;
    }
    const prefetchOffset =
      direction === "down"
        ? cacheLoadedRef.current
        : Math.max(cacheLoadedRef.current - CACHE_BATCH_SIZE, 0);
    schedulePrefetchCacheRow(prefetchOffset);
  }, [loadNextCacheBatch, schedulePrefetchCacheRow]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleScroll = () => {
      const scrollY = window.scrollY;
      const direction = scrollY > lastScrollYRef.current ? "down" : "up";
      scrollStateRef.current = { scrollY, direction };
      lastScrollYRef.current = scrollY;
      if (!scrollFrameRequestedRef.current) {
        scrollFrameRequestedRef.current = true;
        window.requestAnimationFrame(processScroll);
      }
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll);
    };
  }, [processScroll]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          if (entry.target === globalSentinelRef.current) {
            void loadNextCacheBatch();
          }
        });
      },
      { rootMargin: "200px" }
    );
    const target = globalSentinelRef.current;
    if (target) {
      observer.observe(target);
    }
    return () => observer.disconnect();
  }, [indexedDbCacheLimit, loadNextCacheBatch]);

  useEffect(() => {
    if (relayStatus?.connected === false) {
      setIsOfflineMode(true);
      if (!events.length) {
        void loadNextCacheBatch();
      }
      return;
    }
    if (isOfflineMode) {
      setIsOfflineMode(false);
    }
  }, [relayStatus?.connected, events.length, isOfflineMode, loadNextCacheBatch]);

  useEffect(() => {
    let mounted = true;
    relayManager.hydrate().then((relays) => {
      if (mounted) {
        setManagedRelays(relays);
      }
    });
    return () => {
      mounted = false;
    };
  }, [relayManager]);

  const updateProfileMetadata = useCallback(
    (pubkey: string, metadata: Omit<Profile, "created_at">, createdAt: number) => {
      const normalized = canonicalizePubkey(pubkey);
      if (!normalized) return;

      const result = userManager.updateProfile(normalized, { ...metadata, created_at: createdAt });
      fetchedProfilesRef.current.add(normalized);

      if (result.updated) {
        console.log(
          "[Profile] Updating",
          normalized,
          metadata.name || metadata.display_name,
          "(created at",
          createdAt,
          ")"
        );
        setProfiles({ ...result.profiles });
      }
    },
    [userManager]
  );

  const handleContactEvent = useCallback(
    (event: NostrEvent) => {
      if (!authSession) return false;
      const result = userManager.processContactEvent(event, authSession.pubkey);
      if (!result.handled) return false;
      if (result.following) {
        setUserFollowing(result.following);
      }
      if (result.followers) {
        setUserFollowers(result.followers);
      }
      return true;
    },
    [authSession, userManager]
  );

  const applyDeletions = useCallback((ids: string[]) => {
    if (!ids.length) return;
    const deleted = deletedEventIdsRef.current;
    const filtered = ids.filter((id) => !deleted.has(id));
    if (!filtered.length) return;
    filtered.forEach((id) => deleted.add(id));
    setEvents((prev) => clampEvents(prev.filter((event) => !filtered.includes(event.id))));
    setPendingEvents((prev) => prev.filter((event) => !filtered.includes(event.id)));
  }, []);

  const cleanupSigner = useCallback(async () => {
    if (!signerRef.current) return;
    try {
      await signerRef.current.close();
    } catch {
      // ignore bail
    }
    signerRef.current = null;
  }, []);

  const handleWorkerEvent = useCallback(
    (event: NostrEvent) => {
      if (event.kind === 0) {
        if (processedKind0Ref.current.has(event.id)) {
          return;
        }
        processedKind0Ref.current.add(event.id);
        try {
          const metadata = JSON.parse(event.content);
          if (metadata && typeof metadata === "object") {
            console.log("[Profile] Received Kind 0 from stream", event.author);
            updateProfileMetadata(event.author, metadata, event.created_at);
          }
        } catch (e) {
          console.error("[Profile] Failed to parse Kind 0 event content", event.id, e);
        }
        return;
      }

      if (event.kind === 3 && handleContactEvent(event)) {
        return;
      }

      if (event.kind === 7 || event.kind === 6) {
        const targetId = event.tags?.find((t) => t[0] === "e")?.[1];
        if (targetId) {
          setEvents((prev) =>
            prev.map((e) => {
              if (e.id !== targetId) return e;
              if (event.kind === 7) return { ...e, likes: (e.likes ?? 0) + 1 };
              if (event.kind === 6) return { ...e, reposts: (e.reposts ?? 0) + 1 };
              return e;
            })
          );
        }
        return;
      }

      if (deletedEventIdsRef.current.has(event.id)) {
        return;
      }

      incomingEventsRef.current.push(sanitizeEventForMemory(event));
      if (incomingEventsRef.current.length > MAX_INCOMING_QUEUE) {
        incomingEventsRef.current.splice(0, incomingEventsRef.current.length - MAX_INCOMING_QUEUE);
      }
      scheduleIncomingFlush();
    },
    [handleContactEvent, scheduleIncomingFlush, updateProfileMetadata]
  );

  const handleWorkerError = useCallback((message: string) => {
    appErrorManager.report({
      message: `Relay worker error: ${message}`,
      severity: "warning",
      source: "relay-worker"
    });
  }, []);

  const handleNccDiscovery = useCallback((event: NostrEvent) => {
    if (nccDiscoverySeenRef.current.has(event.id)) return;
    const type = classifyNccDiscoveryEvent(event);
    if (!type) return;
    nccDiscoverySeenRef.current.add(event.id);
    const statKey = STAT_KEY_MAP[type];
    setNccStats((prev) => ({
      ...prev,
      [statKey]: prev[statKey] + 1
    }));
  }, []);

  const describeMediaError = (error: MediaError | null | undefined) => {
    if (!error) return "Unknown media error";
    return error.message ? `${error.message} (code ${error.code})` : `Media error code ${error.code}`;
  };

  const handleMediaError = useCallback(
    (url: string, mediaType: "video" | "audio" | "playlist", error?: string) => {
      appErrorManager.report({
        message: `Media load failed (${mediaType})`,
        severity: "warning",
        source: "media",
        details: {
          url,
          error
        }
      });
    },
    []
  );

  const openSearchPanel = useCallback(() => {
    setIsSearchOpen(true);
  }, []);

  const closeSearchPanel = useCallback(() => {
    setIsSearchOpen(false);
  }, []);

  const handleSearchResultSelect = useCallback(() => {
    setIsSearchOpen(false);
  }, []);

  const handleAddRelay = useCallback(async () => {
    setRelayMessage(null);
    const result = await relayManager.addRelay(relayInput);
    if (result.success) {
      setManagedRelays(relayManager.getRelays());
      setRelayMessage({ type: "info", text: "Relay added to the pool." });
      setRelayInput("");
    } else {
      setRelayMessage({ type: "error", text: result.reason ?? "Failed to add relay." });
    }
  }, [relayInput, relayManager]);

  const handleRemoveRelay = useCallback(
    (relay: string) => {
      const result = relayManager.removeRelay(relay);
      if (result.success) {
        setManagedRelays(relayManager.getRelays());
        setRelayMessage({ type: "info", text: "Relay removed." });
      } else {
        setRelayMessage({ type: "error", text: result.reason ?? "Relay could not be removed." });
      }
    },
    [relayManager]
  );

  const handlePublishRelayList = useCallback(async () => {
    if (!authSession) {
      setRelayMessage({ type: "error", text: "Sign in to publish relays to the network." });
      return;
    }

    setRelayMessage({ type: "info", text: "Publishing relay list..." });

    try {
      const relays = relayManager.getRelays();
      const tags = relays.map((url) => ["r", url]);
      
      let event: NostrToolsEvent;
      const baseEvent = {
        kind: 10002,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: ""
      };

      if (authSession.method === "nsec" && authSession.details?.secretHex) {
        const secretKey = authManager.hexToBytes(authSession.details.secretHex);
        event = finalizeEvent(baseEvent, secretKey);
      } else if (signerRef.current) {
        event = await signerRef.current.signEvent(baseEvent);
      } else if (window.nostr?.signEvent) {
        event = (await window.nostr.signEvent(baseEvent)) as NostrToolsEvent;
      } else {
        throw new Error("No signing method available.");
      }

      await publishEvent(event);
      setRelayMessage({ type: "info", text: "Relay list saved to network!" });
    } catch (error) {
      setRelayMessage({ type: "error", text: `Failed to publish: ${(error as Error).message}` });
    }
  }, [authSession, relayManager]);

  const handleReply = useCallback(async (parentId: string, content: string) => {
    if (!content.trim() || !authSession) return;

    const parent = eventsById.get(parentId);
    if (!parent) return;

    const rootId = getRootId(parent) || parent.id;
    const tags = [
      ["e", rootId, "", "root"],
      ["p", parent.author]
    ];
    
    if (rootId !== parent.id) {
      tags.push(["e", parent.id, "", "reply"]);
    }

    try {
      const baseEvent = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content
      };

      let signed: NostrToolsEvent;
      if (authSession.method === "nsec" && authSession.details?.secretHex) {
        signed = finalizeEvent(baseEvent, authManager.hexToBytes(authSession.details.secretHex));
      } else if (signerRef.current) {
        signed = await signerRef.current.signEvent(baseEvent);
      } else if (window.nostr?.signEvent) {
        signed = (await window.nostr.signEvent(baseEvent)) as NostrToolsEvent;
      } else {
        throw new Error("No signer available");
      }

      await publishEvent(signed);
      handleWorkerEvent(mapNToolEvent(signed));
    } catch (err) {
      console.error("Reply failed", err);
    }
  }, [authSession, eventsById]);

  useEffect(() => {
    const handleWindowError = (event: ErrorEvent) => {
      appErrorManager.report({
        message: event.message || "Runtime error",
        severity: "warning",
        source: "global",
        details: {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          error: event.error
        }
      });
    };

    const handleRejection = (event: PromiseRejectionEvent) => {
      appErrorManager.report({
        message: event.reason instanceof Error ? event.reason.message : "Unhandled promise rejection",
        severity: "warning",
        source: "global",
        details: event.reason
      });
    };

    window.addEventListener("error", handleWindowError);
    window.addEventListener("unhandledrejection", handleRejection);
    return () => {
      window.removeEventListener("error", handleWindowError);
      window.removeEventListener("unhandledrejection", handleRejection);
    };
  }, []);

  useEffect(() => {
    if (!isSearchOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setIsSearchOpen(false);
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isSearchOpen]);

  useEffect(() => {
    if (!isSignInMenuOpen) return;
    const handleOutsideClick = (event: MouseEvent) => {
      if (signInMenuRef.current?.contains(event.target as Node)) return;
      if (profileChipRef.current?.contains(event.target as Node)) return;
      setIsSignInMenuOpen(false);
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
    };
  }, [isSignInMenuOpen]);

  useEffect(() => {
    if (!isRelayModalOpen) return;
    const handleClick = (event: MouseEvent) => {
      if (relayModalRef.current?.contains(event.target as Node)) return;
      if (
        profileChipRef.current?.contains(event.target as Node) ||
        signInMenuRef.current?.contains(event.target as Node)
      )
        return;
      setIsRelayModalOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => {
      document.removeEventListener("mousedown", handleClick);
    };
  }, [isRelayModalOpen]);

  useEffect(() => {
    if (!isProfileModalOpen) return;
    const handleOutsideClick = (event: MouseEvent) => {
      if (profileModalRef.current?.contains(event.target as Node)) return;
      if (profileChipRef.current?.contains(event.target as Node)) return;
      setIsProfileModalOpen(false);
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
    };
  }, [isProfileModalOpen]);

  const markAuthenticated = useCallback(
    (session: AuthSession) => {
      setAuthSession(session);
      authManager.persistSession(session);
      setIsSignInMenuOpen(false);
      setSignInError(null);

      // Sync NIP-65 relays
      relayManager.fetchNip65Relays(session.pubkey).then((relays) => {
        if (relays) {
          setManagedRelays(relays);
        }
      });
    },
    [relayManager]
  );

  const handleSignOut = useCallback(async () => {
    await cleanupSigner();
    setAuthSession(null);
    authManager.persistSession(null);
    setIsSignInMenuOpen(false);
    setSignInError(null);
    setQrState(INITIAL_QR_STATE);
    setBunkerStatus(null);
    setBunkerInput("");
    setNsecInput("");
    userManager.resetSocialGraph();
    userManager.resetMuted();
    setUserFollowing(userManager.getFollowingList());
    setUserFollowers(userManager.getFollowersList());
    setMutedAuthors(userManager.getMutedAuthors());
    setIsProfileModalOpen(false);
  }, [cleanupSigner, userManager]);

  const openSignInOptions = useCallback(() => {
    setIsProfileModalOpen(false);
    setIsSignInMenuOpen(true);
  }, []);

  const handleNip07SignIn = useCallback(async () => {
    setSignInError(null);
    if (!window?.nostr?.getPublicKey) {
      setSignInError("No NIP-07 compatible extension found.");
      return;
    }
    try {
      const publicKey = await window.nostr.getPublicKey();
      await cleanupSigner();
      markAuthenticated({
        method: "nip07",
        pubkey: publicKey,
        label: "Browser extension"
      });
    } catch (error) {
      setSignInError(`NIP-07 sign-in failed: ${(error as Error).message}`);
    }
  }, [cleanupSigner, markAuthenticated]);

  const handleStartNostrConnect = useCallback(async () => {
    setSignInError(null);
    const secret =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2);
    const origin = typeof window !== "undefined" ? window.location.origin : "https://nostr.build";
    const uri = createNostrConnectURI({
      clientPubkey: AUTH_PUBLIC_KEY,
      relays: DEFAULT_RELAYS,
      secret,
      perms: ["read", "write"],
      name: "ncc-client",
      url: origin
    });
    setQrState({ uri, dataUrl: null, status: "waiting", secret });
    try {
      const dataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
      setQrState((current) => (current ? { ...current, dataUrl } : current));
    } catch (error) {
      setSignInError(`QR generation failed: ${(error as Error).message}`);
      setQrState((current) => (current ? { ...current, status: "error" } : current));
      return;
    }
    try {
      const signer = await BunkerSigner.fromURI(AUTH_SECRET_KEY, uri, { pool: getRelayPool() });
      await cleanupSigner();
      signerRef.current = signer;
      const publicKey = await signer.getPublicKey();
      markAuthenticated({
        method: "nip46",
        pubkey: publicKey,
        label: "NostrConnect QR"
      });
      setQrState((current) => (current ? { ...current, status: "connected" } : current));
    } catch (error) {
      setSignInError(`QR login failed: ${(error as Error).message}`);
      setQrState((current) => (current ? { ...current, status: "error" } : current));
    }
  }, [cleanupSigner, markAuthenticated]);

  const handleCopyQrUri = useCallback(async () => {
    if (!qrState.uri || !("clipboard" in navigator)) return;
    try {
      await navigator.clipboard.writeText(qrState.uri);
    } catch {
      // ignore copy failures
    }
  }, [qrState.uri]);

  const connectToBunker = useCallback(
    async (
      input: string,
      options: { persistInput?: boolean } = {
        persistInput: true
      }
    ) => {
      setSignInError(null);
      const pointerInput = input.trim();
      if (!pointerInput) {
        setBunkerStatus("Enter a bunker URI or NIP-05 identifier.");
        return;
      }
      setBunkerStatus("Resolving input…");
      try {
        const pointer = await parseBunkerInput(pointerInput);
        if (!pointer) {
          setBunkerStatus("Invalid bunker input.");
          return;
        }
        const signer = BunkerSigner.fromBunker(AUTH_SECRET_KEY, pointer, { pool: getRelayPool() });
        await signer.connect();
        await cleanupSigner();
        signerRef.current = signer;
        const publicKey = await signer.getPublicKey();
        setBunkerStatus("Connected");
        markAuthenticated({
          method: "bunker",
          pubkey: publicKey,
          label: "Bunker",
          details: {
            bunkerInput: pointerInput
          }
        });
        if (options.persistInput) {
          setBunkerInput(pointerInput);
        }
      } catch (error) {
        setBunkerStatus("Connection failed");
        setSignInError(`Bunker login failed: ${(error as Error).message}`);
      }
    },
    [cleanupSigner, markAuthenticated]
  );

  const handleBunkerConnect = useCallback(() => {
    void connectToBunker(bunkerInput);
  }, [bunkerInput, connectToBunker]);

  const handleNsecSignIn = useCallback(
    async (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      setSignInError(null);
      const value = nsecInput.trim();
      if (!value) {
        setSignInError("Paste your nsec1 or hex private key.");
        return;
      }
      const secretHex = authManager.decodeNsec(value);
      if (!secretHex) {
        setSignInError("Use a hex key (64 chars) or bech32 nsec1 key.");
        return;
      }
      try {
        const publicKey = getPublicKey(authManager.hexToBytes(secretHex));
        await cleanupSigner();
        markAuthenticated({
          method: "nsec",
          pubkey: publicKey,
          label: "Private key",
          details: {
            secretHex
          }
        });
        setNsecInput("");
      } catch (error) {
        setSignInError(`Key initialization failed: ${(error as Error).message}`);
      }
    },
    [cleanupSigner, markAuthenticated, nsecInput]
  );

  useEffect(() => {
    const stored = authManager.loadSession();
    if (!stored) return;
    setAuthSession(stored);
    if (stored.details?.bunkerInput) {
      setBunkerInput(stored.details.bunkerInput);
      void connectToBunker(stored.details.bunkerInput, { persistInput: false });
    }
    
    // Refresh relays from network
    relayManager.fetchNip65Relays(stored.pubkey).then((relays) => {
      if (relays) {
        setManagedRelays(relays);
      }
    });
  }, [connectToBunker, relayManager]);

  const handleWorkerDeletion = useCallback((ids: string[]) => {
    applyDeletions(ids);
  }, [applyDeletions]);

  const handleWorkerStatus = useCallback((status: RelayWorkerStatus) => {
    setRelayStatus(status);
  }, []);

  useEffect(() => {
    setSleepingRelays(relayStatus?.sleepingRelays ?? []);
  }, [relayStatus?.sleepingRelays]);

  const followingAuthors = useMemo(
    () => userManager.getEffectiveFollowing(authSession?.pubkey ?? undefined),
    [authSession?.pubkey, userFollowing, userManager]
  );
  const followingAuthorsHex = useMemo(() => {
    const normalized = new Set<string>();
    for (const author of followingAuthors) {
      const canonical = canonicalizePubkey(author);
      if (canonical) {
        normalized.add(canonical);
      }
    }
    return Array.from(normalized);
  }, [followingAuthors]);

  const [baseFiltersToWorker, setBaseFiltersToWorker] = useState<Filter[]>(INITIAL_BASE_FILTERS);
  const computedBaseFilters = useMemo<Filter[]>(() => {
    // Keep the global filter coverage in place (public kinds) and append following-specific filters when signed in.
    if (!isSignedIn || !followingAuthorsHex.length) {
      return buildDefaultBaseFilters(includeReactions, includeServiceRecords);
    }
    return buildFollowingBaseFilters(followingAuthorsHex, includeReactions, includeServiceRecords);
  }, [isSignedIn, followingAuthorsHex, includeReactions, includeServiceRecords]);

  useEffect(() => {
    setBaseFiltersToWorker(computedBaseFilters);
  }, [computedBaseFilters]);

  const extraFiltersToWorker = useMemo(() => {
    const filters = [...authFilters];
    if (activeThreadId) {
      filters.push({
        kinds: [1],
        "#e": [activeThreadId],
        limit: 50
      });
    }
    return filters;
  }, [authFilters, activeThreadId]);

  const openThread = useCallback((eventId: string) => {
    setActiveThreadId(eventId);
    // Proactively fetch the event and its replies
    NostrService.fetchEvent(eventId).then((event) => {
      if (event) {
        handleWorkerEvent(mapNToolEvent(event));
      }
    });
  }, []);

  const closeThread = () => setActiveThreadId(null);

  const getParentId = (event: NostrEvent) => {
    // Find the 'reply' e tag or just the first one
    const eTags = event.tags?.filter((t) => t[0] === "e") || [];
    const replyTag = eTags.find((t) => t[3] === "reply") || eTags[eTags.length - 1];
    return replyTag?.[1];
  };

  const getRootId = (event: NostrEvent) => {
    const eTags = event.tags?.filter((t) => t[0] === "e") || [];
    const rootTag = eTags.find((t) => t[3] === "root") || eTags[0];
    return rootTag?.[1];
  };

  const mapNToolEvent = (e: NostrToolsEvent): NostrEvent => ({
    id: e.id,
    kind: e.kind,
    author: e.pubkey,
    content: e.content,
    created_at: e.created_at * 1000,
    tags: e.tags,
    relays: [],
    isArticle: e.kind === 30023,
    isServiceRecord: e.kind === 30059
  });

  const { fetchEvent: requestReferencedEvent } = useRelayWorker(
    managedRelays,
    {
      onEvent: handleWorkerEvent,
      onDeletion: handleWorkerDeletion,
      onStatus: handleWorkerStatus,
      onError: handleWorkerError,
      onDiscovery: handleNccDiscovery
    },
    baseFiltersToWorker,
    extraFiltersToWorker
  );

  const fetchReferencedEvent = useCallback(
    (eventId: string) => {
      requestReferencedEvent(eventId);
    },
    [requestReferencedEvent]
  );

  const postRenderer = useMemo(
    () =>
      new PostRenderer({
        previewLength: CONTENT_PREVIEW_LENGTH,
        resolveEvent: (id) => eventsByIdRef.current.get(id),
        onMissingReference: fetchReferencedEvent
      }),
    [fetchReferencedEvent]
  );

  const matchesActiveHashtag = useCallback(
    (event: NostrEvent) => {
      if (!activeHashtag) return true;
      return extractHashtags(event.content).includes(activeHashtag);
    },
    [activeHashtag]
  );

  const matchesFilterForEvent = useCallback(
    (event: NostrEvent, filterId: TimelineFilterId) => {
      switch (filterId) {
        case "following":
          return followingAuthorsHex.includes(event.author);
        case "articles":
          return event.isArticle || event.kind === 30023;
        case "serviceRecords":
          return event.kind === 30059;
        case "locators":
          return event.kind === 30058;
        case "conventions":
          return event.kind === 0;
        default:
          return false;
      }
    },
    [followingAuthorsHex]
  );

  const toggleFilter = useCallback((filterId: TimelineFilterId) => {
    setActiveFilters((prev) => {
      if (prev.includes(filterId)) {
        return prev.filter((id) => id !== filterId);
      }
      return [...prev, filterId];
    });
  }, []);

  const openFocusedEvent = useCallback((eventId: string) => {
    setFocusedEventId(eventId);
  }, []);

  const closeFocusedEvent = useCallback(() => {
    setFocusedEventId(null);
  }, []);

  useEffect(() => {
    if (!focusedEvent) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeFocusedEvent();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
    };
  }, [focusedEvent, closeFocusedEvent]);

  const scheduleEventCommit = useCallback(
    (incoming: NostrEvent[]) => {
      if (!incoming.length) return;
      pendingCommitRef.current.push(...incoming);
      if (commitScheduledRef.current) return;
      commitScheduledRef.current = true;

      requestAnimationFrame(() => {
        const batch = [...pendingCommitRef.current];
        pendingCommitRef.current = [];
        commitScheduledRef.current = false;

        if (batch.length === 0) return;

        setEvents((prev) => {
          const seen = new Set(prev.map((event) => event.id));
          const uniqueBatch = [];
          const batchSeen = new Set();
          for (const event of batch) {
            if (!batchSeen.has(event.id)) {
              batchSeen.add(event.id);
              uniqueBatch.push(event);
            }
          }
          const deduped = uniqueBatch.filter((event) => !seen.has(event.id));
          const merged = [...deduped, ...prev];
          return clampEvents(merged);
        });
      });
    },
    []
  );

  const flushPendingEvents = useCallback(
    (count?: number, predicate?: (event: NostrEvent) => boolean) => {
      if (!pendingEvents.length) return 0;
      const takeCount = typeof count === "number" ? Math.min(count, pendingEvents.length) : pendingEvents.length;
      const matches = predicate ?? (() => true);
      const toTake: NostrEvent[] = [];
      const remaining: NostrEvent[] = [];
      for (const event of pendingEvents) {
        if (toTake.length < takeCount && matches(event)) {
          toTake.push(event);
        } else {
          remaining.push(event);
        }
      }
      if (!toTake.length) return 0;
      scheduleEventCommit(toTake);
      setPendingEvents(remaining);
      return toTake.length;
    },
    [pendingEvents, scheduleEventCommit]
  );

  const baseGlobalEvents = useMemo(() => {
    const pool = [...events]
      .filter((event) => !mutedAuthors.includes(event.author))
      .sort((a, b) => b.created_at - a.created_at);

    return pool.filter(matchesActiveHashtag);
  }, [events, mutedAuthors, matchesActiveHashtag]);

  const filteredGlobalEvents = useMemo(() => {
    if (!activeFilters.length) {
      return baseGlobalEvents;
    }
    return baseGlobalEvents.filter((event) =>
      activeFilters.some((filterId) => matchesFilterForEvent(event, filterId))
    );
  }, [activeFilters, baseGlobalEvents, matchesFilterForEvent]);

  const globalDisplay = filteredGlobalEvents.slice(0, globalLimit);
  const showGlobalSkeleton = globalDisplay.length < 3;

  useEffect(() => {
    if (!pendingEvents.length || events.length >= COLUMN_FILL_TARGET) return;
    flushPendingEvents(COLUMN_FILL_TARGET - events.length);
  }, [pendingEvents.length, events.length, flushPendingEvents]);

  const flushNewPosts = (
    requested = PENDING_FLUSH_CHUNK,
    predicate?: (event: NostrEvent) => boolean
  ) => {
    if (!pendingEvents.length) return;
    const available = predicate ? pendingEvents.filter(predicate).length : pendingEvents.length;
    if (!available) return;
    const flushCount = Math.min(Math.max(requested, 1), PENDING_FLUSH_CHUNK, available);
    flushPendingEvents(flushCount, predicate);
  };

  const toggleExpansion = (eventId: string) => {
    setExpandedPosts((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) {
        next.delete(eventId);
      } else {
        next.add(eventId);
      }
      return next;
    });
  };

  const getProfileForAuthor = useCallback(
    (author: string) => {
      const normalized = canonicalizePubkey(author) ?? author;
      return profiles[normalized];
    },
    [profiles]
  );

  const getAuthorLabel = useCallback(
    (author: string) => {
      const profile = getProfileForAuthor(author);
      const displayKey = canonicalizePubkey(author) ?? author;
      return profile?.display_name ?? profile?.name ?? formatAuthorDisplay(displayKey);
    },
    [getProfileForAuthor]
  );

  useEffect(() => {
    searchManagerRef.current?.updateEvents(events);
  }, [events]);

  useEffect(() => {
    searchManagerRef.current?.updateProfiles(profiles);
  }, [profiles]);

  const [isSearchLoading, setIsSearchLoading] = useState(false);

  const searchResults = useMemo<SearchEntry[]>(() => {
    return searchManagerRef.current?.search(searchQuery, getAuthorLabel) ?? [];
  }, [searchQuery, getAuthorLabel]);

  const pendingProfileRequestsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      setIsSearchLoading(false);
      return;
    }
    const timer = window.setTimeout(async () => {
      const pubkeyHex = NostrService.parsePubkeyFromInput(trimmed);
      const needsProfile = Boolean(pubkeyHex && !remoteSearchCacheRef.current.profiles.has(pubkeyHex));
      const eventId = NostrService.isEventIdQuery(trimmed);
      const needsEvent = Boolean(eventId && !remoteSearchCacheRef.current.events.has(eventId));
      const isHashtag = trimmed.startsWith("#");
      const normalizedKeyword = trimmed.toLowerCase();
      const needsHashtag = isHashtag && !remoteSearchCacheRef.current.hashtags.has(normalizedKeyword);
      const needsKeyword =
        !isHashtag &&
        !pubkeyHex &&
        !eventId &&
        trimmed.length > 2 &&
        !remoteSearchCacheRef.current.keywords.has(normalizedKeyword);

      if (!needsProfile && !needsEvent && !needsHashtag && !needsKeyword) {
        setIsSearchLoading(false);
        return;
      }

      setIsSearchLoading(true);
      try {
        if (needsProfile && pubkeyHex) {
          remoteSearchCacheRef.current.profiles.add(pubkeyHex);
          const remoteProfile = await NostrService.fetchProfile(pubkeyHex, managedRelays);
          if (remoteProfile?.metadata) {
            updateProfileMetadata(pubkeyHex, remoteProfile.metadata, remoteProfile.created_at);
          }
        }
        if (needsEvent && eventId) {
          remoteSearchCacheRef.current.events.add(eventId);
          const remoteEvent = await NostrService.fetchEvent(eventId);
          if (remoteEvent) {
            const sanitizedEvent = sanitizeEventForMemory(mapNostrToolsEvent(remoteEvent));
            setEvents((prev) => {
              if (prev.some((existing) => existing.id === sanitizedEvent.id)) return prev;
              return clampEvents([sanitizedEvent, ...prev]);
            });
          }
        }
        if (needsHashtag) {
          remoteSearchCacheRef.current.hashtags.add(normalizedKeyword);
          const remoteEvents = await NostrService.fetchHashtag(normalizedKeyword);
          if (remoteEvents.length) {
            setEvents((prev) => {
              const deduped = [...prev];
              for (const remoteEvent of remoteEvents) {
                const sanitizedEvent = sanitizeEventForMemory(mapNostrToolsEvent(remoteEvent));
                if (deduped.some((existing) => existing.id === sanitizedEvent.id)) continue;
                deduped.unshift(sanitizedEvent);
              }
              return clampEvents(deduped);
            });
          }
        }
        if (needsKeyword) {
          remoteSearchCacheRef.current.keywords.add(normalizedKeyword);
          const remoteEvents = await NostrService.fetchKeyword(normalizedKeyword);
          if (remoteEvents.length) {
            setEvents((prev) => {
              const deduped = [...prev];
              for (const remoteEvent of remoteEvents) {
                const sanitizedEvent = sanitizeEventForMemory(mapNostrToolsEvent(remoteEvent));
                if (deduped.some((existing) => existing.id === sanitizedEvent.id)) continue;
                deduped.unshift(sanitizedEvent);
              }
              return clampEvents(deduped);
            });
          }
        }
      } finally {
        setIsSearchLoading(false);
      }
    }, 450);
    return () => {
      clearTimeout(timer);
    };
  }, [searchQuery, updateProfileMetadata]);

  useEffect(() => {
    pullDistanceRef.current = pullDistance;
  }, [pullDistance]);

  useEffect(() => {
    manualRefreshRef.current = isManualRefreshing;
  }, [isManualRefreshing]);

  const triggerManualRefresh = useCallback(async () => {
    if (manualRefreshRef.current) return;
    setIsManualRefreshing(true);
    setEvents([]);
    setManagedRelays((prev) => [...prev]);
    try {
      await refresh();
    } finally {
      setIsManualRefreshing(false);
    }
  }, [refresh]);

  useEffect(() => {
    if (!events.length) return;
    const queue: string[] = [];
    for (const event of events) {
      const normalized = canonicalizePubkey(event.author);
      if (!normalized) continue;
      const existingProfile = profiles[normalized];
      if (
        existingProfile &&
        (existingProfile.name || existingProfile.display_name || existingProfile.picture)
      ) {
        fetchedProfilesRef.current.add(normalized);
        continue;
      }
      if (fetchedProfilesRef.current.has(normalized)) continue;
      if (pendingProfileRequestsRef.current.has(normalized)) continue;
      pendingProfileRequestsRef.current.add(normalized);
      queue.push(normalized);
      if (queue.length >= 12) break;
    }
    if (!queue.length) return;
    let cancelled = false;
    const fetchProfiles = async () => {
      for (const pubkey of queue) {
        if (cancelled) break;
        try {
                      const remoteProfile = await NostrService.fetchProfile(pubkey, managedRelays);
                      if (remoteProfile?.metadata) {
                        updateProfileMetadata(pubkey, remoteProfile.metadata, remoteProfile.created_at);
                      }        } finally {
          pendingProfileRequestsRef.current.delete(pubkey);
        }
      }
    };
    void fetchProfiles();
    return () => {
      cancelled = true;
    };
  }, [events, profiles, updateProfileMetadata]);

  useEffect(() => {
    if (!canonicalAuthPubkey) return;
    const syncProfile = async () => {
      const remoteProfile = await NostrService.fetchProfile(canonicalAuthPubkey, managedRelays);
      if (remoteProfile?.metadata) {
        updateProfileMetadata(canonicalAuthPubkey, remoteProfile.metadata, remoteProfile.created_at);
      }
    };
    void syncProfile();
    refresh();
  }, [canonicalAuthPubkey, refresh, updateProfileMetadata]);

  const renderSkeletonCards = useCallback((prefix: string) => (
    <div className="timeline-skeleton">
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={`${prefix}-${index}`} className="timeline-skeleton-card">
          <span className="skeleton-line long" />
          <span className="skeleton-line medium" />
          <span className="skeleton-line short" />
        </div>
      ))}
    </div>
  ), []);

  const renderAuthorPill = (event: NostrEvent) => {
    const normalizedAuthor = canonicalizePubkey(event.author) ?? event.author;
    const profile = profiles[normalizedAuthor];
    const displayName = getAuthorLabel(event.author);
    const initials = normalizedAuthor.charAt(0).toUpperCase();
    const parentId = getParentId(event);
    const parentEvent = parentId ? eventsById.get(parentId) : null;

    if (profile?.picture) {
      // avoid redundant logs to keep console quieter
    }

    return (
      <div className="author-row">
        <span className="author-pill" title={`${displayName} (${event.author})`}>
          <span className="author-avatar">
            {profile?.picture ? (
              <AvatarImage src={profile.picture} alt={displayName} />
            ) : (
              <span>{initials}</span>
            )}
          </span>
          <span className="author-name">{displayName}</span>
        </span>
        {parentEvent && (
          <span className="reply-badge" onClick={(e) => { e.stopPropagation(); openThread(parentId!); }}>
            Replying to {getAuthorLabel(parentEvent.author)}
          </span>
        )}
      </div>
    );
  };

  const renderEventContent = (event: NostrEvent) => {
    const isExpanded = expandedPosts.has(event.id);
    const {
      previewText,
      needsPreview,
      usesMarkdown,
      sanitizedHtml,
      hashtags,
      links,
      naddrReferences,
      embeddedEvent
    } = postRenderer.render(event, isExpanded);
    const uniqueHashtags = Array.from(new Set(hashtags));

    const uniqueLinks = Array.from(new Set(links.filter(Boolean)));
    const inlineImageLink = uniqueLinks.find((link) => MediaManager.getMediaType(link) === "image");
    const shouldInlineImage = inlineImageLink && !event.attachments?.length;
    const inlineImagePreview = shouldInlineImage
      ? renderAttachments([
          {
            url: inlineImageLink,
            type: "image",
            description: "Inline link preview"
          }
        ])
      : null;
    const filteredLinks = shouldInlineImage
      ? uniqueLinks.filter((link) => link !== inlineImageLink)
      : uniqueLinks;
    const maxPreviewLinks = isExpanded ? 3 : 1;
    const previewLinks = filteredLinks.slice(0, maxPreviewLinks);

    return (
      <div className="content-block">
        {inlineImagePreview}
        {usesMarkdown && isExpanded && sanitizedHtml ? (
          <div className="content-html" dangerouslySetInnerHTML={{ __html: sanitizedHtml }} />
        ) : (
          <p className="content-text" aria-expanded={isExpanded}>
            {previewText}
          </p>
        )}
        {needsPreview && (
          <button type="button" className="more-link" onClick={() => toggleExpansion(event.id)}>
            {isExpanded ? "Less" : "More"}
          </button>
        )}
    {hashtags.length > 0 && (
      <div className="hashtag-row">
        {uniqueHashtags.map((tag) => (
          <button
            key={`${event.id}-${tag}`}
            type="button"
            className={`hashtag ${activeHashtag === tag ? "active" : ""}`}
                onClick={() => setActiveHashtag(tag)}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
        {previewLinks.length > 0 && (
          <div className="link-preview-grid">
            {previewLinks.map((link) => (
              <LinkPreview key={`${event.id}-${link}`} url={link} />
            ))}
          </div>
        )}
        {naddrReferences.length > 0 && (
          <div className="naddr-row">
            {naddrReferences.map((reference) => (
              <article key={`${event.id}-${reference.uri}`} className="naddr-card">
                <div className="naddr-header">
                  <span className="naddr-kind">nostr:naddr</span>
                  <span className="naddr-relays">{reference.relays?.[0] ?? "no relay"}</span>
                </div>
                <p>
                  kind {reference.kind} · {reference.identifier}
                </p>
                <a href={reference.uri} className="naddr-link" rel="noreferrer" target="_blank">
                  Open naddr
                </a>
              </article>
            ))}
          </div>
        )}
        {embeddedEvent && renderEmbeddedCard(embeddedEvent)}
      </div>
    );
  };

  const getReferencedEvent = (event: NostrEvent) => {
    const refId = event.tags?.find((tag) => tag[0] === "e")?.[1];
    if (!refId) return null;
    return eventsById.get(refId) ?? null;
  };

  const renderEmbeddedCard = (referenced: NostrEvent) => {
    if (!referenced) return null;
    return (
      <article className="embedded-card">
        <div className="stat-pills">
          {renderAuthorPill(referenced)}
        </div>
        {renderEventContent(referenced)}
        {renderAttachments(referenced.attachments)}
        <div className="meta">
          <span>{formatAgo(referenced.created_at)}</span>
          <span title={referenced.relays?.[0] ?? "relay unknown"}>
            {referenced.relays?.[0] ?? "relay unknown"}
          </span>
        </div>
      </article>
    );
  });

  const renderEmbeddedEvent = (event: NostrEvent) => {
    const referenced = getReferencedEvent(event);
    if (!referenced) return null;
    return renderEmbeddedCard(referenced);
  };

  const renderAttachments = (attachments?: Attachment[]) => {
    if (!attachments?.length) return null;
    const attachment = attachments[0];
    if (!attachment) return null;
    const key = `${attachment.url ?? "attach"}-0`;
    const mediaType = MediaManager.getMediaType(attachment.url ?? "", attachment.type);
    return (
      <div className="attachment-preview">
        {mediaType === "image" && attachment.url ? (
          <LazyImage
            key={key}
            url={attachment.url}
            alt={attachment.description ?? "attachment"}
            className="attachment-item"
          />
        ) : attachment.url && mediaType === "audio" ? (
          <LazyAudio
            key={key}
            url={attachment.url}
            onError={(error) => handleMediaError(attachment.url ?? "unknown", "audio", error)}
          />
        ) : attachment.url && mediaType === "playlist" ? (
          <LazyPlaylistPlayer
            key={key}
            url={attachment.url}
            onError={(error) => handleMediaError(attachment.url ?? "unknown", "playlist", error)}
          />
        ) : attachment.url && mediaType === "video" ? (
          <LazyVideo
            key={key}
            url={attachment.url}
            onError={(error) => handleMediaError(attachment.url ?? "unknown", "video", error)}
          />
        ) : (
          <a className="attachment-file" href={attachment.url ?? "#"} target="_blank" rel="noreferrer">
            {attachment.description ?? attachment.url ?? "Download asset"}
          </a>
        )}
      </div>
    );
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0] ?? null;
    setAttachedFile(file);
  };

  const handlePublish = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft.content.trim()) return;

    const nowMs = Date.now();
    const kind = draft.type === "article" ? 30023 : 1;
    const attachments = attachedFile
      ? [
          {
            url: URL.createObjectURL(attachedFile),
            type: attachedFile.type.startsWith("image") ? ("image" as const) : ("file" as const),
            description: attachedFile.name
          }
        ]
      : undefined;

    const relayPayload = finalizeEvent(
      {
        kind,
        created_at: Math.floor(nowMs / 1000),
        tags: [],
        content: draft.content
      },
      USER_PRIVATE_KEY
    );

    const newEvent: NostrEvent = {
      id: relayPayload.id,
      kind,
      author: "@you",
      content: relayPayload.content,
      created_at: nowMs,
      relays: managedRelays,
      isArticle: draft.type === "article",
      attachments
    };

    const sanitizedNewEvent = sanitizeEventForMemory(newEvent);
    setEvents((prev) => [sanitizedNewEvent, ...prev]);
    setDraft({ content: "", type: draft.type });
    setAttachedFile(null);
    try {
      await publishEvent(relayPayload);
    } catch (publishError) {
      appErrorManager.report({
        message: "Failed to publish event to relays",
        severity: "error",
        source: "publishEvent",
        details: publishError
      });
    }
  };

  const handleAction = (type: "like" | "repost" | "mute", eventId: string, author?: string) => {
    if (type === "like") {
      setLikedEvents((prev) =>
        prev.includes(eventId) ? prev.filter((id) => id !== eventId) : [...prev, eventId]
      );
    }

    if (type === "repost") {
      setRepostedEvents((prev) =>
        prev.includes(eventId) ? prev.filter((id) => id !== eventId) : [...prev, eventId]
      );
    }

    if (type === "mute" && author) {
      userManager.toggleMute(author);
      setMutedAuthors(userManager.getMutedAuthors());
    }
  };

  const handleShare = async (event: NostrEvent) => {
    const shareUrl = `https://nostr.build/events/${event.id}`;
    const payload = {
      title: `nostr • ${kindLabel(event)}`,
      text: event.content,
      url: shareUrl
    };

    if (navigator.share) {
      await navigator.share(payload);
      return;
    }

    if ("clipboard" in navigator) {
      await navigator.clipboard.writeText(shareUrl);
    }
  };

  const renderActions = (event: NostrEvent) => {
    const isLiked = likedEvents.includes(event.id);
    const isReposted = repostedEvents.includes(event.id);
    const totalLikes = (event.likes ?? 0) + (isLiked ? 1 : 0);
    const totalReposts = (event.reposts ?? 0) + (isReposted ? 1 : 0);
    
    const commentCount = Array.from(eventsById.values()).filter(
      (e) => e.kind === 1 && e.tags?.some((t) => t[0] === "e" && t[1] === event.id)
    ).length;

    return (
      <div className="actions">
        <button
          type="button"
          className={isLiked ? "active-like" : ""}
          onClick={(mouseEvent) => {
            mouseEvent.stopPropagation();
            handleAction("like", event.id);
          }}
          title={isLiked ? "Unlike" : "Like"}
        >
          <svg viewBox="0 0 24 24" fill={isLiked ? "currentColor" : "none"} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" />
          </svg>
          <span>{totalLikes > 0 ? totalLikes : ""}</span>
        </button>
        <button
          type="button"
          className={isReposted ? "active-repost" : ""}
          onClick={(mouseEvent) => {
            mouseEvent.stopPropagation();
            handleAction("repost", event.id);
          }}
          title={isReposted ? "Undo Repost" : "Repost"}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 00-3.7-3.7 48.678 48.678 0 00-7.324 0 4.006 4.006 0 00-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3l-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 003.7 3.7 48.656 48.656 0 007.324 0 4.006 4.006 0 003.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3l-3 3" />
          </svg>
          <span>{totalReposts > 0 ? totalReposts : ""}</span>
        </button>
        <button
          type="button"
          onClick={(mouseEvent) => {
            mouseEvent.stopPropagation();
            openThread(event.id);
          }}
          title="Comments"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 20.25c4.97 0 9-3.694 9-8.25s-4.03-8.25-9-8.25S3 7.444 3 12c0 2.104.859 4.023 2.273 5.48.432.447.74 1.04.586 1.641a4.483 4.483 0 01-.923 1.785c-.442.483.037 1.08.63.843a12.903 12.903 0 002.232-.971c.555-.299 1.207-.199 1.71.169a10.703 10.703 0 001.582.802z" />
          </svg>
          <span>{commentCount > 0 ? commentCount : ""}</span>
        </button>
        <button
          type="button"
          onClick={(mouseEvent) => {
            mouseEvent.stopPropagation();
            handleShare(event);
          }}
          title="Share"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z" />
          </svg>
        </button>
        <button
          type="button"
          onClick={(mouseEvent) => {
            mouseEvent.stopPropagation();
            handleAction("mute", event.id, event.author);
          }}
          title="Mute Author"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18M9 9l-6 6m0-6l6 6m12-12l-6 6m0-6l6 6" />
          </svg>
        </button>
    </div>
  );
};

  type PostCardProps = {
    event: NostrEvent;
    onCardClick?: (eventId: string) => void;
    isFocused?: boolean;
  };

  const PostCard = memo(({ event, onCardClick, isFocused = false }: PostCardProps) => {
    const replyCount = Array.from(eventsById.values()).filter(
      (item) => item.kind === 1 && item.tags?.some((t) => t[0] === "e" && t[1] === event.id)
    ).length;

    const firstHashtag = event.tags?.find((tag) => tag[0] === "#" && tag[1])?.[1];
    const mediaPreview = renderAttachments(event.attachments);
    const handleKeyDown = (keyboardEvent: KeyboardEvent<HTMLElement>) => {
      if (!onCardClick) return;
      if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") {
        keyboardEvent.preventDefault();
        onCardClick(event.id);
      }
    };

    return (
      <article
        className={`timeline-card ${isFocused ? "is-focused-card" : ""}`}
        role={onCardClick ? "button" : undefined}
        tabIndex={onCardClick ? 0 : undefined}
        onClick={() => onCardClick?.(event.id)}
        onKeyDown={handleKeyDown}
      >
        {mediaPreview}
        <div className="timeline-card-body">
          <div className="stat-pills">
            {renderAuthorPill(event)}
            {replyCount > 0 && (
              <span className="stat-pill badge-pill" aria-label={`${replyCount} replies`}>
                {replyCount} replies
              </span>
            )}
            {firstHashtag && <span className="stat-pill badge-pill">#{firstHashtag}</span>}
            {event.isArticle && <span className="stat-pill badge-pill longform">Long-form</span>}
          </div>
          {renderEventContent(event)}
          {event.kind === 1059 && renderEmbeddedEvent(event)}
        </div>
        <div className="timeline-card-footer">
          <div className="meta">
            <span title={`Posted ${formatAgo(event.created_at)}`}>{formatAgo(event.created_at)}</span>
            <span title={event.relays?.join(" · ") ?? "relay unknown"}>
              {event.relays?.join(" · ") ?? "relay unknown"}
            </span>
          </div>
          {renderActions(event)}
        </div>
      </article>
    );
  };

  useEffect(() => {
    const timelines = Array.from(document.querySelectorAll<HTMLDivElement>(".timeline"));
    if (!timelines.length) return undefined;

    const handleMove = (event: TouchEvent) => {
      if (manualRefreshRef.current) return;
      if (pullStartRef.current === null) return;
      const node = pullTargetRef.current;
      if (!node || node.scrollTop > 1) {
        setPullDistance(0);
        return;
      }
      const diff = event.touches[0].clientY - pullStartRef.current;
      if (diff <= 0) {
        setPullDistance(0);
        return;
      }
      event.preventDefault();
      setPullDistance(Math.min(diff, MAX_PULL_DISTANCE));
    };

    const handleEnd = () => {
      const held = pullDistanceRef.current;
      pullStartRef.current = null;
      pullTargetRef.current = null;
      setPullDistance(0);
      if (held >= PULL_THRESHOLD) {
        void triggerManualRefresh();
      }
    };

    const listeners = timelines.map((node) => {
      const start = (event: TouchEvent) => {
        if (manualRefreshRef.current) return;
        if (node.scrollTop > 1) return;
        pullStartRef.current = event.touches[0].clientY;
        pullTargetRef.current = node;
        setPullDistance(0);
      };
      node.addEventListener("touchstart", start, { passive: true });
      node.addEventListener("touchmove", handleMove, { passive: false });
      node.addEventListener("touchend", handleEnd);
      node.addEventListener("touchcancel", handleEnd);
      return { node, start };
    });

    return () => {
      listeners.forEach(({ node, start }) => {
        node.removeEventListener("touchstart", start);
        node.removeEventListener("touchmove", handleMove);
        node.removeEventListener("touchend", handleEnd);
        node.removeEventListener("touchcancel", handleEnd);
      });
    };
  }, [triggerManualRefresh]);
  const profileMetadata = canonicalAuthPubkey ? profiles[canonicalAuthPubkey] : undefined;
  const profileDisplayName =
    profileMetadata?.display_name ?? profileMetadata?.name ?? formatAuthorDisplay(authSession?.pubkey ?? "unknown");
  const profileAvatarInitial = (authSession?.pubkey?.charAt(0) ?? "U").toUpperCase();
  const followingCount = followingAuthors.length;
  const followerCount = userFollowers.length;
  const pullIndicatorVisible = isManualRefreshing || pullDistance > 0;
  const pullIndicatorHeight = isManualRefreshing ? 48 : pullDistance;
  const pullRefreshMessage = isManualRefreshing
    ? "Refreshing timeline…"
    : pullDistance >= PULL_THRESHOLD
    ? "Release to refresh"
    : "Pull down to refresh";

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-left">
          <button
            type="button"
            className="hamburger"
            aria-label="Open navigation"
            onClick={() => setIsDrawerOpen(true)}
          >
            <span />
            <span />
            <span />
          </button>
          <button
            type="button"
            className="profile-chip"
            ref={profileChipRef}
            aria-label={isSignedIn ? "Open profile" : "Sign in"}
            aria-expanded={isSignedIn ? isProfileModalOpen : isSignInMenuOpen}
            onClick={() => {
              if (isSignedIn) {
                setIsProfileModalOpen((prev) => !prev);
                setIsSignInMenuOpen(false);
                return;
              }
              setIsSignInMenuOpen((prev) => !prev);
            }}
          >
            {isSignedIn ? (
              <div className="profile-chip-content">
                <span className="profile-chip-avatar">
                  {profileMetadata?.picture ? (
                    <img src={profileMetadata.picture} alt={profileDisplayName} />
                  ) : (
                    <span>{profileAvatarInitial}</span>
                  )}
                </span>
                <div className="profile-chip-text">
                  <span>{profileDisplayName}</span>
                  <small>{formatShortPubkey(authSession?.pubkey ?? "")}</small>
                </div>
              </div>
            ) : (
              <>
                <span>Sign in</span>
                <small>tap to authenticate</small>
              </>
            )}
          </button>
          <button
            type="button"
            className="search-button"
            onClick={openSearchPanel}
            aria-label="Open search"
          >
            <svg viewBox="0 0 24 24" role="presentation">
              <circle cx="11" cy="11" r="6" />
              <line x1="16.5" y1="16.5" x2="22" y2="22" />
            </svg>
            <span className="sr-only">Open search</span>
          </button>
        </div>
      </header>

      <div
        className={`pull-refresh ${pullIndicatorVisible ? "active" : ""}`}
        style={{ height: `${pullIndicatorHeight}px` }}
      >
        <span className="pull-refresh-message">{pullRefreshMessage}</span>
      </div>

      <SearchPanel
        open={isSearchOpen}
        query={searchQuery}
        results={searchResults}
        onQueryChange={setSearchQuery}
        onClose={closeSearchPanel}
        onResultClick={handleSearchResultSelect}
        loading={isSearchLoading}
      />

      {isSignInMenuOpen && (
        <div className="sign-in-popover" ref={signInMenuRef}>
          <div className="sign-in-section">
            <div className="sign-in-section-header">
              <h4>Sign in options</h4>
              <p className="sign-in-helper">Unlock Following + Articles by authenticating with your preferred wallet.</p>
            </div>
            <div className="sign-in-actions">
              <button type="button" className="primary" onClick={handleNip07SignIn}>
                Browser extension (NIP-07)
              </button>
              <button type="button" className="secondary" onClick={handleStartNostrConnect}>
                Show QR (NIP-46)
              </button>
            </div>
            <div className={`qr-preview qr-${qrState.status}`}>
              {qrState.dataUrl ? (
                <img src={qrState.dataUrl} alt="NostrConnect QR code" />
              ) : (
                <span className="qr-placeholder">Generate a QR code to await a bunker.</span>
              )}
              {qrState.uri && (
                <div className="qr-info">
                  <span className="qr-status">
                    {qrState.status === "waiting" ? "Awaiting connection" : qrState.status === "connected" ? "Connected" : "Ready"}
                  </span>
                  <button type="button" className="ghost-pill" onClick={handleCopyQrUri}>
                    Copy URI
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="sign-in-section">
            <h4>Bunker / NIP-05</h4>
            <input
              type="text"
              value={bunkerInput}
              onChange={(event) => setBunkerInput(event.target.value)}
              placeholder="bunker://... or nostr@domain"
            />
            <button type="button" className="primary" onClick={handleBunkerConnect}>
              Connect to bunker
            </button>
            {bunkerStatus && <p className="sign-in-helper">{bunkerStatus}</p>}
          </div>
          <form className="sign-in-section" onSubmit={handleNsecSignIn}>
            <h4>Paste nsec key</h4>
            <textarea
              value={nsecInput}
              onChange={(event) => setNsecInput(event.target.value)}
              placeholder="nsec1… or 64-character hex"
            />
            <p className="sign-in-helper warning">
              Warning: pasting private keys is sensitive. Only do this in a locked environment.
            </p>
            <button type="submit" className="secondary">
              Use private key
            </button>
          </form>
          {signInError && <p className="sign-in-error">{signInError}</p>}
          {isSignedIn && (
            <button type="button" className="sign-out-button" onClick={handleSignOut}>
              Sign out
            </button>
          )}
        </div>
      )}

      {isSignedIn && isProfileModalOpen && (
        <>
          <div className="profile-modal-overlay" onClick={() => setIsProfileModalOpen(false)} />
          <aside className="profile-modal" ref={profileModalRef}>
            <header className="profile-modal-header">
              <div className="profile-modal-badge">
                <span className="profile-avatar">
                  {profileMetadata?.picture ? (
                    <img src={profileMetadata.picture} alt={profileDisplayName} loading="lazy" />
                  ) : (
                    <span>{profileAvatarInitial}</span>
                  )}
                </span>
                <div>
                  <strong>{profileDisplayName}</strong>
                  <small>{authSession?.label ?? "Signed in"}</small>
                </div>
              </div>
              <button
                type="button"
                className="ghost-pill"
                onClick={() => setIsProfileModalOpen(false)}
                aria-label="Close profile"
              >
                Close
              </button>
            </header>
            <div className="profile-modal-body">
              {profileMetadata?.about && <p className="profile-about">{profileMetadata.about}</p>}
              <dl className="profile-stats">
                <div>
                  <dt>Following</dt>
                  <dd>{followingCount}</dd>
                </div>
                <div>
                  <dt>Followers</dt>
                  <dd>{followerCount}</dd>
                </div>
                <div>
                  <dt>Pubkey</dt>
                  <dd title={authSession?.pubkey ?? "unknown"}>
                    {formatShortPubkey(authSession?.pubkey ?? "")}
                  </dd>
                </div>
              </dl>
              {profileMetadata?.nip05 && (
                <p className="profile-nip05">
                  NIP-05: <strong>{profileMetadata.nip05}</strong>
                </p>
              )}
            </div>
            <div className="profile-modal-actions">
              <button type="button" className="primary" onClick={handleSignOut}>
                Sign out
              </button>
              <button type="button" className="secondary" onClick={openSignInOptions}>
                Sign in options
              </button>
            </div>
          </aside>
        </>
      )}

      {isRelayModalOpen && (
        <>
          <div className="relay-modal-overlay" onClick={() => setIsRelayModalOpen(false)} />
          <aside className="relay-modal" ref={relayModalRef}>
            <header className="relay-modal-header">
              <div>
                <h4>Relay management</h4>
                <p className="relay-modal-helper">Keep the relays you trust or add new endpoints.</p>
              </div>
              <button type="button" className="ghost-pill" onClick={() => setIsRelayModalOpen(false)}>
                Close
              </button>
            </header>
            <div className="relay-modal-body">
              <div className="relay-modal-input-row">
                <input
                  type="text"
                  value={relayInput}
                  onChange={(event) => {
                    setRelayInput(event.target.value);
                    if (relayMessage) setRelayMessage(null);
                  }}
                  placeholder="wss://relay.example.com"
                />
                <button type="button" className="primary" onClick={handleAddRelay}>
                  Add
                </button>
              </div>
              {relayMessage && (
                <p className={`relay-modal-message ${relayMessage.type}`}>{relayMessage.text}</p>
              )}
              {isSignedIn && (
                <button 
                  type="button" 
                  className="secondary" 
                  style={{ marginBottom: '0.5rem' }}
                  onClick={handlePublishRelayList}
                >
                  Save to network (NIP-65)
                </button>
              )}
              <div className="relay-list">
                {managedRelays.map((relay) => (
                  <div className="relay-row" key={relay}>
                    <span>{relay}</span>
                    <button type="button" className="ghost-pill" onClick={() => handleRemoveRelay(relay)}>
                      Remove
                    </button>
                  </div>
                ))}
              </div>
              <div className="relay-modal-stats">
                <div className="relay-stat">
                  <strong>{nccStats.serviceRecords}</strong>
                  <span>Service records</span>
                </div>
                <div className="relay-stat">
                  <strong>{nccStats.locators}</strong>
                  <span>NCC-05 locators</span>
                </div>
                <div className="relay-stat">
                  <strong>{nccStats.attestations}</strong>
                  <span>Attestations</span>
                </div>
                <div className="relay-stat">
                  <strong>{nccStats.revocations}</strong>
                  <span>Revocations</span>
                </div>
              </div>
            </div>
          </aside>
        </>
      )}

      {activeHashtag && (
        <div className="hashtag-filter">
          <span>
            Filtering by <strong>{activeHashtag}</strong>
          </span>
          <button type="button" className="ghost-pill" onClick={() => setActiveHashtag(null)}>
            Clear
          </button>
        </div>
      )}

      <div className="app-main-layout">
        {isDrawerOpen && <div className="sidebar-overlay" onClick={() => setIsDrawerOpen(false)} />}
        <aside className={`sidebar ${isDrawerOpen ? "open" : ""}`}>
          <div className="sidebar-content">
            <div className="sidebar-header">
              <h3>Dashboard</h3>
              <button type="button" className="close-sidebar" onClick={() => setIsDrawerOpen(false)}>
                ✕
              </button>
            </div>
            <StatusBar
              connected={connected}
              managedRelays={managedRelays}
              relayStatus={relayStatus}
              isOfflineMode={isOfflineMode}
              isRelayModalOpen={isRelayModalOpen}
              setIsRelayModalOpen={setIsRelayModalOpen}
              isManualRefreshing={isManualRefreshing}
              triggerManualRefresh={triggerManualRefresh}
            />
            <section className="filter-panel">
              <div className="filter-panel__toggles">
                <label>
                  <input
                    type="checkbox"
                    checked={includeReactions}
                    onChange={() => setIncludeReactions((prev) => !prev)}
                  />
                  Load Reactions
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={includeServiceRecords}
                    onChange={() => setIncludeServiceRecords((prev) => !prev)}
                  />
                  Load NCC Service Records
                </label>
              </div>
              <div className="filter-panel__cache">
                <label>
                  Local cache limit: {localCacheLimit}
                  <input
                    type="range"
                    min={20}
                    max={200}
                    step={10}
                    value={localCacheLimit}
                    onChange={(event) => setLocalCacheLimit(Number(event.target.value))}
                  />
                </label>
                <label>
                  IndexedDB cache limit: {indexedDbCacheLimit}
                  <input
                    type="range"
                    min={100}
                    max={500}
                    step={50}
                    value={indexedDbCacheLimit}
                    onChange={(event) => setIndexedDbCacheLimit(Number(event.target.value))}
                  />
                </label>
              </div>
              <div className="filter-panel__status">
                {isLoadingMoreCache
                  ? "Loading more cached posts…"
                  : hasMoreCacheEvents
                  ? "Scroll to load more cached posts"
                  : "Cached posts exhausted"}
              </div>
            </section>
            <div className="post-composer-section">
              <h4>New post</h4>
              <form onSubmit={handlePublish} className="post-form sidebar-form">
                <textarea
                  placeholder="Share a note or a longer thought..."
                  value={draft.content}
                  onChange={(event) => setDraft((prev) => ({ ...prev, content: event.target.value }))}
                />
                <div className="form-row">
                  <select
                    value={draft.type}
                    onChange={(event) => setDraft((prev) => ({ ...prev, type: event.target.value }))}
                  >
                    <option value="note">Note (kind 1)</option>
                    <option value="article">Article (kind 30023)</option>
                  </select>
                  <input type="file" onChange={handleFileChange} />
                </div>
                {attachedFile && (
                  <div className="upload-preview">
                    Attached: {attachedFile.name} · {(attachedFile.size / 1024).toFixed(1)} KB
                  </div>
                )}
                <button type="submit">Publish</button>
              </form>
            </div>
            <div className="sidebar-service-panel">
              <h4>NCC-02 discovery</h4>
              <div className="service-meta">
                <span>status: <strong>{discoveryStatus}</strong></span>
                <span>
                  endpoint:{" "}
                  <strong>{discovery?.endpoint ?? "private service"}</strong>
                </span>
                <span>owner: {discovery?.pubkey ? formatShortPubkey(discovery.pubkey) : "unknown"}</span>
              </div>
              {discoveryError && <p className="service-error">Resolver error: {discoveryError}</p>}
            </div>
            <div className="sidebar-section">
              <h4>Active Relays</h4>
              <ul className="relay-mini-list">
                {managedRelays.slice(0, 5).map((relay) => (
                  <li key={relay} title={relay}>{relay}</li>
                ))}
                {managedRelays.length > 5 && <li className="more-relays">+{managedRelays.length - 5} more</li>}
              </ul>
            </div>
          </div>
        </aside>

        <div className="layout-grid" data-full-global={!isSignedIn}>
          <section className="column active-column">
            <div className="column-header">
              <div>
                <h2>All • Global Mirror</h2>
                <div className="filter-pills" role="list">
                  {FILTER_DEFINITIONS.map((filter) => {
                    const isActive = activeFilters.includes(filter.id);
                    return (
                      <button
                        key={filter.id}
                        type="button"
                        className={`filter-pill ${isActive ? "is-active" : ""}`}
                        onClick={() => toggleFilter(filter.id)}
                        aria-pressed={isActive}
                      >
                        {filter.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="timeline">
              {globalDisplay.map((event) => (
                <PostCard key={event.id} event={event} onCardClick={openFocusedEvent} />
              ))}
              {showGlobalSkeleton && renderSkeletonCards("global")}
              {filteredGlobalEvents.length > globalLimit && (
                <button type="button" className="load-more" onClick={() => setGlobalLimit((prev) => prev + 20)}>
                  Load more
                </button>
              )}
              <div ref={globalSentinelRef} className="feed-sentinel" aria-hidden="true" />
            </div>
          </section>

          {focusedEvent && (
            <div className="card-focus-overlay" onClick={closeFocusedEvent}>
              <div
                className="card-focus-modal"
                role="dialog"
                aria-modal="true"
                aria-label="Focused post"
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  className="card-focus-close"
                  onClick={closeFocusedEvent}
                  aria-label="Close focused post"
                >
                  ✕
                </button>
                <PostCard event={focusedEvent} isFocused />
              </div>
            </div>
          )}

          {activeThreadId && (
            <ThreadPanel
              eventId={activeThreadId}
              onClose={closeThread}
              eventsById={eventsById}
              renderAuthorPill={renderAuthorPill}
              renderEventContent={renderEventContent}
              renderAttachments={renderAttachments}
              renderActions={renderActions}
              formatAgo={formatAgo}
              onReply={handleReply}
              isSignedIn={isSignedIn}
            />
          )}
        </div>
      </div>
    </div>
  );
};

const ThreadPanel = ({
  eventId,
  onClose,
  eventsById,
  renderAuthorPill,
  renderEventContent,
  renderAttachments,
  renderActions,
  formatAgo,
  onReply,
  isSignedIn
}: {
  eventId: string;
  onClose: () => void;
  eventsById: Map<string, NostrEvent>;
  renderAuthorPill: (e: NostrEvent) => JSX.Element;
  renderEventContent: (e: NostrEvent) => JSX.Element;
  renderAttachments: (a?: Attachment[]) => JSX.Element | null;
  renderActions: (e: NostrEvent) => JSX.Element;
  formatAgo: (t: number) => string;
  onReply: (parentId: string, content: string) => Promise<void>;
  isSignedIn: boolean;
}) => {
  const [replyContent, setReplyContent] = useState("");
  const rootEvent = eventsById.get(eventId);
  
  const replies = useMemo(() => {
    return Array.from(eventsById.values())
      .filter((e) => e.tags?.some((t) => t[0] === "e" && t[1] === eventId))
      .sort((a, b) => a.created_at - b.created_at);
  }, [eventsById, eventId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!replyContent.trim()) return;
    await onReply(eventId, replyContent);
    setReplyContent("");
  };

  return (
    <aside className="thread-panel">
      <header className="thread-header">
        <h3>Conversation</h3>
        <button type="button" className="close-thread" onClick={onClose}>✕</button>
      </header>
      <div className="thread-content">
        {!rootEvent ? (
          <div className="thread-loading">Loading post...</div>
        ) : (
          <>
            <article className="thread-root-card">
              <div className="stat-pills">
                {renderAuthorPill(rootEvent)}
              </div>
              {renderEventContent(rootEvent)}
              {renderAttachments(rootEvent.attachments)}
              <div className="meta">
                <span>{formatAgo(rootEvent.created_at)}</span>
              </div>
              {renderActions(rootEvent)}
            </article>

            <div className="replies-section">
              <h4>Replies</h4>
              {replies.length === 0 ? (
                <p className="no-replies">No replies yet.</p>
              ) : (
                <div className="replies-list">
                  {replies.map((reply) => (
                    <article key={reply.id} className="reply-card">
                      <div className="stat-pills">
                        {renderAuthorPill(reply)}
                      </div>
                      {renderEventContent(reply)}
                      {renderAttachments(reply.attachments)}
                      <div className="meta">
                        <span>{formatAgo(reply.created_at)}</span>
                      </div>
                      {renderActions(reply)}
                    </article>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {isSignedIn && (
        <footer className="thread-footer">
          <form onSubmit={handleSubmit} className="reply-form">
            <textarea
              placeholder="Write a reply..."
              value={replyContent}
              onChange={(e) => setReplyContent(e.target.value)}
            />
            <button type="submit" disabled={!replyContent.trim()}>Reply</button>
          </form>
        </footer>
      )}
    </aside>
  );
};

export default App;

type LazyMediaProps = {
  url: string;
  onError?: MediaErrorHandler;
};

type MediaErrorHandler = (message?: string) => void;

const LazyVideo = ({ url, onError }: LazyMediaProps) => {
  const [ref, visible] = useInView<HTMLDivElement>();
  const [failed, setFailed] = useState(() => failedVideoCache.has(url));

  useEffect(() => {
    setFailed(failedVideoCache.has(url));
  }, [url]);

  return (
    <div ref={ref} className="attachment-video">
      {visible && !failed ? (
        <video
          src={url}
          className="attachment-item"
          controls
          preload="metadata"
          playsInline
          muted
          onError={(event) => {
            const message = describeMediaError((event.target as HTMLMediaElement)?.error ?? null);
            if (url) {
              failedVideoCache.add(url);
            }
            setFailed(true);
            onError?.(message);
          }}
        />
      ) : (
        <div className="attachment-media-placeholder" />
      )}
    </div>
  );
};

const AvatarImage = ({ src, alt }: { src?: string; alt?: string }) => {
  const [failed, setFailed] = useState(() => !src || failedAvatarCache.has(src));

  useEffect(() => {
    setFailed(!src || (src ? failedAvatarCache.has(src) : true));
  }, [src]);

  if (!src || failed) {
    return null;
  }

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => {
        if (src) {
          failedAvatarCache.add(src);
        }
        setFailed(true);
      }}
    />
  );
};

const LazyAudio = ({ url, onError }: LazyMediaProps) => {
  const [ref, visible] = useInView<HTMLDivElement>();
  return (
    <div ref={ref} className="attachment-audio">
      {visible ? (
        <audio
          src={url}
          controls
          preload="metadata"
          onError={(event) => onError?.(describeMediaError((event.target as HTMLMediaElement)?.error ?? null))}
        >
          Your browser cannot play this audio.
        </audio>
      ) : (
        <div className="attachment-media-placeholder" />
      )}
    </div>
  );
};

const LazyPlaylistPlayer = ({ url, onError }: LazyMediaProps) => {
  const [ref, visible] = useInView<HTMLDivElement>();
  return (
    <div ref={ref} className="attachment-video">
      {visible ? (
        <PlaylistPlayer src={url} onError={(error) => onError?.(error)} />
      ) : (
        <div className="attachment-media-placeholder" />
      )}
    </div>
  );
};

const LazyImage = ({ url, alt, className }: { url: string; alt?: string; className?: string }) => {
  const [ref, visible] = useInView<HTMLDivElement>();
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(() => failedImageCache.has(url));

  useEffect(() => {
    if (!url) return;
    setLoaded(false);
    setFailed(failedImageCache.has(url));
  }, [url]);

  const handleError = () => {
    if (url) {
      failedImageCache.add(url);
    }
    setFailed(true);
  };

  const placeholderClass = `attachment-media-placeholder ${loaded && !failed ? "is-hidden" : ""}`;

  return (
    <div ref={ref} className="attachment-image-container">
      <div className={placeholderClass} aria-hidden="true" />
      {visible && !failed && url && (
        <img
          src={url}
          alt={alt}
          loading="lazy"
          className={`${className ?? ""} ${loaded ? "is-loaded" : ""}`}
          onLoad={() => setLoaded(true)}
          onError={handleError}
        />
      )}
    </div>
  );
};
