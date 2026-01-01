import {
  ChangeEvent,
  FormEvent,
  SyntheticEvent,
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
import {
  fetchRemoteEvent,
  fetchRemoteHashtag,
  fetchRemoteKeyword,
  fetchRemoteProfile,
  isEventIdQuery,
  parsePubkeyFromInput
} from "./services/searchRelay";
import {
  classifyNccDiscoveryEvent,
  INITIAL_NCC_STATS,
  type NccDiscoveryStats,
  type NccDiscoveryType
} from "./utils/nccDiscovery";

const canonicalizePubkey = (value?: string | null) => {
  if (!value) return null;
  const normalized = parsePubkeyFromInput(value);
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
const COLUMN_FILL_TARGET = 20;

const SERVICE_ID = "ncc-client-demo";

const formatAgo = (timestamp: number) => {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "moments ago";
  if (diff < 3_600_000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3600000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
};

const CONTENT_PREVIEW_LENGTH = 220;
const BASELINE_EVENT_TARGET = 60;
const PENDING_FLUSH_CHUNK = 20;
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

const App = () => {
  const { connected, refresh } = useNccClient();
  const { service: discovery, status: discoveryStatus, error: discoveryError } = useNcc02Discovery(
    USER_PUBLIC_KEY,
    SERVICE_ID
  );
  const userManagerRef = useRef<UserManager>();
  if (!userManagerRef.current) {
    userManagerRef.current = new UserManager({ baseFollowing: FOLLOWING_AUTHORS });
  }
  const userManager = userManagerRef.current;
  const relayManagerRef = useRef<RelayManager>();
  if (!relayManagerRef.current) {
    relayManagerRef.current = new RelayManager(DEFAULT_RELAYS, { ncc05SecretKey: AUTH_SECRET_KEY });
  }
  const relayManager = relayManagerRef.current;
  const [managedRelays, setManagedRelays] = useState<string[]>(() => relayManager.getRelays());
  const [events, setEvents] = useState<NostrEvent[]>([]);
  const [mutedAuthors, setMutedAuthors] = useState<string[]>(() => userManager.getMutedAuthors());
  const [likedEvents, setLikedEvents] = useState<string[]>([]);
  const [repostedEvents, setRepostedEvents] = useState<string[]>([]);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [draft, setDraft] = useState({ content: "", type: "note" });
  const [attachedFile, setAttachedFile] = useState<File | null>(null);
  const [followingLimit, setFollowingLimit] = useState(20);
  const [articlesLimit, setArticlesLimit] = useState(20);
  const [globalLimit, setGlobalLimit] = useState(20);
  const [pendingEvents, setPendingEvents] = useState<NostrEvent[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Profile>>(() => userManager.getProfiles());
  const [nccStats, setNccStats] = useState<NccDiscoveryStats>(() => ({ ...INITIAL_NCC_STATS }));
  const nccDiscoverySeenRef = useRef<Set<string>>(new Set());
  const deletedEventIdsRef = useRef<Set<string>>(new Set());
  const [expandedPosts, setExpandedPosts] = useState<Set<string>>(new Set());
  const [activeColumn, setActiveColumn] = useState<"following" | "articles" | "global">("following");
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
  const [userFollowing, setUserFollowing] = useState<string[]>(() => userManager.getFollowingList());
  const [userFollowers, setUserFollowers] = useState<string[]>(() => userManager.getFollowersList());
  const [isRelayModalOpen, setIsRelayModalOpen] = useState(false);
  const relayModalRef = useRef<HTMLDivElement>(null);
  const [relayInput, setRelayInput] = useState("");
  const [relayMessage, setRelayMessage] = useState<{ type: "info" | "error"; text: string } | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isCompactView, setIsCompactView] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(max-width: 960px)").matches;
  });
  const searchManagerRef = useRef<SearchManager>();
  if (!searchManagerRef.current) {
    searchManagerRef.current = new SearchManager();
  }
  const remoteSearchCacheRef = useRef({
    profiles: new Set<string>(),
    events: new Set<string>(),
    hashtags: new Set<string>(),
    keywords: new Set<string>()
  });
  const eventsById = useMemo(() => {
    const map = new Map<string, NostrEvent>();
    events.forEach((event) => map.set(event.id, event));
    return map;
  }, [events]);
  const pullStartRef = useRef<number | null>(null);
  const pullTargetRef = useRef<HTMLDivElement | null>(null);
  const pullDistanceRef = useRef<number>(0);
  const manualRefreshRef = useRef(false);
  const incomingEventsRef = useRef<NostrEvent[]>([]);
  const pendingCommitRef = useRef<NostrEvent[]>([]);
  const commitScheduledRef = useRef(false);
  const queueFlushScheduledRef = useRef(false);
  const queueFlushTimeoutRef = useRef<number | null>(null);
  const columnPrimedRef = useRef({
    following: false,
    articles: false,
    global: false
  });

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
      return merged.slice(0, 400);
    });
    if (incomingEventsRef.current.length) {
      queueFlushScheduledRef.current = true;
      queueFlushTimeoutRef.current = window.setTimeout(processIncomingBatch, 50);
    }
  }, []);

  const scheduleIncomingFlush = useCallback(() => {
    if (queueFlushScheduledRef.current) return;
    queueFlushScheduledRef.current = true;
    queueFlushTimeoutRef.current = window.setTimeout(processIncomingBatch, 50);
  }, [processIncomingBatch]);

  useEffect(() => {
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
    const normalized = parsePubkeyFromInput(authSession.pubkey);
    return normalized ?? authSession.pubkey.toLowerCase();
  }, [authSession?.pubkey]);

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
    (pubkey: string, metadata: Profile) => {
      const normalized = canonicalizePubkey(pubkey);
      if (!normalized) return;
      const nextProfiles = userManager.updateProfile(normalized, metadata);
      setProfiles(nextProfiles);
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
    setEvents((prev) => prev.filter((event) => !filtered.includes(event.id)));
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
        try {
          const metadata = JSON.parse(event.content);
          if (metadata && typeof metadata === "object") {
            updateProfileMetadata(event.author, metadata);
          }
        } catch {
          // ignore
        }
        return;
      }

      if (event.kind === 3 && handleContactEvent(event)) {
        return;
      }

      if (deletedEventIdsRef.current.has(event.id)) {
        return;
      }

      incomingEventsRef.current.push(event);
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
    if (typeof window === "undefined") return;
    const matcher = window.matchMedia("(max-width: 960px)");
    const listener = (event: MediaQueryListEvent) => {
      setIsCompactView(event.matches);
    };
    if (matcher.addEventListener) {
      matcher.addEventListener("change", listener);
    } else {
      matcher.addListener(listener);
    }
    return () => {
      if (matcher.removeEventListener) {
        matcher.removeEventListener("change", listener);
      } else {
        matcher.removeListener(listener);
      }
    };
  }, []);

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
      setActiveColumn("following");
    },
    [setActiveColumn]
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
  }, [connectToBunker]);

  const handleWorkerDeletion = useCallback((ids: string[]) => {
    applyDeletions(ids);
  }, [applyDeletions]);

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

  const feedFilters = useMemo<Filter[]>(() => {
    if (!isSignedIn || !followingAuthorsHex.length) return [];
    return [
      {
        authors: followingAuthorsHex,
        kinds: [1, 30023],
        limit: 40
      }
    ];
  }, [isSignedIn, followingAuthorsHex]);

  const combinedFilters = useMemo(() => [...authFilters, ...feedFilters], [authFilters, feedFilters]);

  const { fetchEvent: requestReferencedEvent } = useRelayWorker(
    managedRelays,
    {
      onEvent: handleWorkerEvent,
      onDeletion: handleWorkerDeletion,
      onError: handleWorkerError,
      onDiscovery: handleNccDiscovery
    },
    combinedFilters
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
        resolveEvent: (id) => eventsById.get(id),
        onMissingReference: fetchReferencedEvent
      }),
    [eventsById, fetchReferencedEvent]
  );

  const matchesActiveHashtag = useCallback(
    (event: NostrEvent) => {
      if (!activeHashtag) return true;
      return extractHashtags(event.content).includes(activeHashtag);
    },
    [activeHashtag]
  );

  const scheduleEventCommit = useCallback(
    (incoming: NostrEvent[]) => {
      if (!incoming.length) return;
      pendingCommitRef.current.push(...incoming);
      if (commitScheduledRef.current) return;
      commitScheduledRef.current = true;
      requestAnimationFrame(() => {
        setEvents((prev) => {
          const seen = new Set(prev.map((event) => event.id));
          const deduped = pendingCommitRef.current.filter((event) => !seen.has(event.id));
          const merged = [...deduped, ...prev];
          return merged.slice(0, 200);
        });
        pendingCommitRef.current = [];
        commitScheduledRef.current = false;
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

  const followingNotes = useMemo(
    () =>
      [...events]
        .filter(
          (event) =>
            followingAuthors.includes(event.author) &&
            !mutedAuthors.includes(event.author) &&
            event.kind === 1 &&
            !event.isArticle &&
            matchesActiveHashtag(event)
        )
        .sort((a, b) => b.created_at - a.created_at),
    [events, mutedAuthors, followingAuthors]
  );

  const articleEvents = useMemo(
    () =>
      events
        .filter(
          (event) =>
            followingAuthors.includes(event.author) &&
            (event.isArticle || event.kind === 30023) &&
            matchesActiveHashtag(event)
        )
        .sort((a, b) => b.created_at - a.created_at),
    [events, followingAuthors, matchesActiveHashtag]
  );

  const globalEvents = useMemo(() => {
    const pool = [...events]
      .filter((event) => !mutedAuthors.includes(event.author))
      .sort((a, b) => b.created_at - a.created_at);

    const withHashtag = pool.filter(matchesActiveHashtag);

    return withHashtag;
  }, [events, mutedAuthors]);

  const followingDisplay = followingNotes.slice(0, followingLimit);
  const articleDisplay = articleEvents.slice(0, articlesLimit);
  const globalDisplay = globalEvents.slice(0, globalLimit);
  const showFollowingSkeleton = followingDisplay.length < 3;
  const showArticleSkeleton = articleDisplay.length < 3;
  const showGlobalSkeleton = globalDisplay.length < 3;

  const isFollowingEvent = useCallback(
    (event: NostrEvent) =>
      followingAuthors.includes(event.author) &&
      !mutedAuthors.includes(event.author) &&
      event.kind === 1 &&
      !event.isArticle,
    [followingAuthors, mutedAuthors]
  );

  const isArticleEvent = useCallback(
    (event: NostrEvent) =>
      followingAuthors.includes(event.author) && (event.isArticle || event.kind === 30023),
    [followingAuthors]
  );

  const followingNewCount = pendingEvents.filter(isFollowingEvent).length;
  const articleNewCount = pendingEvents.filter(isArticleEvent).length;
  const globalNewCount = pendingEvents.length;

  const showFollowingColumn = isSignedIn && (!isCompactView || activeColumn === "following");
  const showArticleColumn = isSignedIn && (!isCompactView || activeColumn === "articles");
  const showGlobalColumn = !isCompactView || activeColumn === "global" || !isSignedIn;
  const MIN_COLUMN_ITEMS = COLUMN_FILL_TARGET;

  useEffect(() => {
    if (!pendingEvents.length) return;
    const actions: Array<{
      count: number;
      predicate?: (event: NostrEvent) => boolean;
      column: "following" | "articles" | "global";
    }> = [];

    if (showFollowingColumn && !columnPrimedRef.current.following) {
      if (followingDisplay.length >= MIN_COLUMN_ITEMS) {
        columnPrimedRef.current.following = true;
      } else {
        actions.push({
          column: "following",
          count: Math.max(MIN_COLUMN_ITEMS - followingDisplay.length, 0),
          predicate: isFollowingEvent
        });
      }
    }

    if (showArticleColumn && !columnPrimedRef.current.articles) {
      if (articleDisplay.length >= MIN_COLUMN_ITEMS) {
        columnPrimedRef.current.articles = true;
      } else {
        actions.push({
          column: "articles",
          count: Math.max(MIN_COLUMN_ITEMS - articleDisplay.length, 0),
          predicate: isArticleEvent
        });
      }
    }

    if (showGlobalColumn && !columnPrimedRef.current.global) {
      if (globalDisplay.length >= MIN_COLUMN_ITEMS) {
        columnPrimedRef.current.global = true;
      } else {
        actions.push({
          column: "global",
          count: Math.max(MIN_COLUMN_ITEMS - globalDisplay.length, 0)
        });
      }
    }

    if (!actions.length) return;

    actions.forEach((action) => {
      const flushed = flushPendingEvents(action.count, action.predicate);
      if (flushed > 0 && action.count > 0) {
        columnPrimedRef.current[action.column] = true;
      }
    });
  }, [
    pendingEvents.length,
    showFollowingColumn,
    showArticleColumn,
    showGlobalColumn,
    followingDisplay.length,
    articleDisplay.length,
    globalDisplay.length,
    isFollowingEvent,
    isArticleEvent,
    flushPendingEvents
  ]);

  useEffect(() => {
    if (events.length >= BASELINE_EVENT_TARGET || !pendingEvents.length) return;
    flushPendingEvents(PENDING_FLUSH_CHUNK);
  }, [events.length, pendingEvents.length]);

  useEffect(() => {
    if (!isSignedIn) {
      setActiveColumn("global");
      setIsProfileModalOpen(false);
    }
  }, [isSignedIn]);

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
      const pubkeyHex = parsePubkeyFromInput(trimmed);
      const needsProfile = Boolean(pubkeyHex && !remoteSearchCacheRef.current.profiles.has(pubkeyHex));
      const eventId = isEventIdQuery(trimmed);
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
          const remoteProfile = await fetchRemoteProfile(pubkeyHex);
          if (remoteProfile?.metadata) {
            updateProfileMetadata(pubkeyHex, remoteProfile.metadata);
          }
        }
        if (needsEvent && eventId) {
          remoteSearchCacheRef.current.events.add(eventId);
          const remoteEvent = await fetchRemoteEvent(eventId);
          if (remoteEvent) {
            setEvents((prev) => {
              if (prev.some((existing) => existing.id === remoteEvent.id)) return prev;
              return [mapNostrToolsEvent(remoteEvent), ...prev].slice(0, 200);
            });
          }
        }
        if (needsHashtag) {
          remoteSearchCacheRef.current.hashtags.add(normalizedKeyword);
          const remoteEvents = await fetchRemoteHashtag(normalizedKeyword);
          if (remoteEvents.length) {
            setEvents((prev) => {
              const deduped = [...prev];
              for (const remoteEvent of remoteEvents) {
                if (deduped.some((existing) => existing.id === remoteEvent.id)) continue;
                deduped.unshift(mapNostrToolsEvent(remoteEvent));
              }
              return deduped.slice(0, 200);
            });
          }
        }
        if (needsKeyword) {
          remoteSearchCacheRef.current.keywords.add(normalizedKeyword);
          const remoteEvents = await fetchRemoteKeyword(normalizedKeyword);
          if (remoteEvents.length) {
            setEvents((prev) => {
              const deduped = [...prev];
              for (const remoteEvent of remoteEvents) {
                if (deduped.some((existing) => existing.id === remoteEvent.id)) continue;
                deduped.unshift(mapNostrToolsEvent(remoteEvent));
              }
              return deduped.slice(0, 200);
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

  const resetColumnPrimed = useCallback(() => {
    columnPrimedRef.current = {
      following: false,
      articles: false,
      global: false
    };
  }, []);

  const triggerManualRefresh = useCallback(async () => {
    if (manualRefreshRef.current) return;
    setIsManualRefreshing(true);
    try {
      resetColumnPrimed();
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
      if (profiles[normalized]) continue;
      if (pendingProfileRequestsRef.current.has(normalized)) continue;
      pendingProfileRequestsRef.current.add(normalized);
      queue.push(normalized);
      if (queue.length >= 6) break;
    }
    if (!queue.length) return;
    let cancelled = false;
    const fetchProfiles = async () => {
      for (const pubkey of queue) {
        if (cancelled) break;
        try {
          const remoteProfile = await fetchRemoteProfile(pubkey);
          if (remoteProfile?.metadata) {
            updateProfileMetadata(pubkey, remoteProfile.metadata);
          }
        } finally {
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
      const remoteProfile = await fetchRemoteProfile(canonicalAuthPubkey);
      if (remoteProfile?.metadata) {
        updateProfileMetadata(canonicalAuthPubkey, remoteProfile.metadata);
      }
    };
    resetColumnPrimed();
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

    return (
      <span className="author-pill" title={`${displayName} (${event.author})`}>
        <span className="author-avatar">
          {profile?.picture ? (
            <img src={profile.picture} alt={displayName} loading="lazy" />
          ) : (
            <span>{initials}</span>
          )}
        </span>
        <span className="author-name">{displayName}</span>
      </span>
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
    const previewLinks = uniqueLinks.slice(0, 3);

    return (
      <div className="content-block">
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
          <span className="stat-pill kind-pill">{kindLabel(referenced)}</span>
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
  };

  const renderEmbeddedEvent = (event: NostrEvent) => {
    const referenced = getReferencedEvent(event);
    if (!referenced) return null;
    return renderEmbeddedCard(referenced);
  };

  const renderAttachments = (attachments?: Attachment[]) => {
    if (!attachments?.length) return null;
    return (
      <div className="attachment-grid">
        {attachments.map((attachment, index) => {
          const key = `${attachment.url ?? "attach"}-${index}`;
          const mediaType = MediaManager.getMediaType(attachment.url ?? "", attachment.type);
          if (mediaType === "image" && attachment.url) {
            return (
              <img
                key={key}
                src={attachment.url}
                alt={attachment.description ?? "attachment"}
                loading="lazy"
                className="attachment-item"
              />
            );
          }

          if (attachment.url && mediaType === "audio") {
            return (
              <LazyAudio
                key={key}
                url={attachment.url}
                onError={(error) => handleMediaError(attachment.url ?? "unknown", "audio", error)}
              />
            );
          }

          if (attachment.url && mediaType === "playlist") {
            return (
              <LazyPlaylistPlayer
                key={key}
                url={attachment.url}
                onError={(error) => handleMediaError(attachment.url ?? "unknown", "playlist", error)}
              />
            );
          }

          if (attachment.url && mediaType === "video") {
            return (
              <LazyVideo
                key={key}
                url={attachment.url}
                onError={(error) => handleMediaError(attachment.url ?? "unknown", "video", error)}
              />
            );
          }

          return (
            <a key={key} href={attachment.url ?? "#"} target="_blank" rel="noreferrer" className="attachment-file">
              {attachment.description ?? attachment.url ?? "Download asset"}
            </a>
          );
        })}
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

    setEvents((prev) => [newEvent, ...prev]);
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
      setLikedEvents((prev) => (prev.includes(eventId) ? prev : [...prev, eventId]));
    }

    if (type === "repost") {
      setRepostedEvents((prev) => (prev.includes(eventId) ? prev : [...prev, eventId]));
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
    const totalLikes = (event.likes ?? 0) + (likedEvents.includes(event.id) ? 1 : 0);
    const totalReposts = (event.reposts ?? 0) + (repostedEvents.includes(event.id) ? 1 : 0);

    return (
      <div className="actions">
        <button
          type="button"
          className={likedEvents.includes(event.id) ? "active" : ""}
          onClick={() => handleAction("like", event.id)}
        >
          ❤️ {totalLikes}
        </button>
        <button
          type="button"
          className={repostedEvents.includes(event.id) ? "active" : ""}
          onClick={() => handleAction("repost", event.id)}
        >
          🔁 {totalReposts}
        </button>
        <button type="button" onClick={() => handleShare(event)}>
          📤 Share
        </button>
        <button type="button" onClick={() => handleAction("mute", event.id, event.author)}>
          🚫 Mute
        </button>
    </div>
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
  }, [showFollowingColumn, showArticleColumn, showGlobalColumn, triggerManualRefresh]);
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
        <div className="status-chip">
          <span>{connected ? "Online" : "Offline"}</span>
          <button
            type="button"
            className="relay-pill"
            aria-expanded={isRelayModalOpen}
            onClick={() => {
              setIsRelayModalOpen((prev) => !prev);
            }}
          >
            Relays: {managedRelays.length}
          </button>
          <button type="button" onClick={refresh}>
            Refresh
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

      {isSignedIn && (
        <div className="column-tabs">
          <button
            type="button"
            className={activeColumn === "following" ? "active" : ""}
            onClick={() => setActiveColumn("following")}
          >
            Following
          </button>
          <button
            type="button"
            className={activeColumn === "articles" ? "active" : ""}
            onClick={() => setActiveColumn("articles")}
          >
            Articles
          </button>
          <button
            type="button"
            className={activeColumn === "global" ? "active" : ""}
            onClick={() => setActiveColumn("global")}
          >
            Global
          </button>
        </div>
      )}

      {isDrawerOpen && (
        <div className="drawer-overlay" onClick={() => setIsDrawerOpen(false)} />
      )}
      <aside className={`drawer ${isDrawerOpen ? "open" : ""}`}>
        <div className="drawer-content">
          <h3>New post</h3>
          <form onSubmit={handlePublish} className="post-form drawer-form">
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
          <div className="drawer-service-panel">
            <h4>NCC-02 relay discovery</h4>
            <p className="service-note">
              Posts are omitted; NCC-02 feeds relay discovery and falls back to NCC-05 locators when no endpoint is
              published.
            </p>
            <div className="service-meta">
              <span>status: <strong>{discoveryStatus}</strong></span>
              <span>
                endpoint:{" "}
                <strong>{discovery?.endpoint ?? "private service - NCC-05 fallback required"}</strong>
              </span>
              <span>fingerprint: <strong>{discovery?.fingerprint ?? "pending"}</strong></span>
              <span>owner: {discovery?.pubkey ?? "unknown"}</span>
            </div>
            {discoveryError && <p className="service-error">Resolver error: {discoveryError}</p>}
          </div>
          <div className="drawer-section">
            <h4>Relay info</h4>
            <ul>
              {DEFAULT_RELAYS.map((relay) => (
                <li key={relay}>{relay}</li>
              ))}
            </ul>
          </div>
        </div>
      </aside>

      <div className="layout-grid" data-full-global={!isSignedIn}>
        {showFollowingColumn && (
          <section className={`column ${activeColumn === "following" ? "active-column" : ""}`}>
            <div className="column-header">
              <div>
                <h2>Recent • Following Notes</h2>
                <span className="chip">Following-only feed</span>
              </div>
              {followingNewCount > 0 && (
                <button
                  type="button"
                  className="new-pill"
                  onClick={() => flushNewPosts(followingNewCount, isFollowingEvent)}
                >
                  {followingNewCount} new
                </button>
              )}
            </div>
            <div className="timeline">
              {followingDisplay.map((event) => (
                <article key={event.id} className="timeline-card">
                  <div className="stat-pills">
                    {renderAuthorPill(event)}
                    <span className="stat-pill kind-pill">{kindLabel(event)}</span>
                  </div>
                  {renderEventContent(event)}
                  {renderAttachments(event.attachments)}
                  {event.kind === 1059 && renderEmbeddedEvent(event)}
                  <div className="meta">
                    <span title={`Posted ${formatAgo(event.created_at)}`}>{formatAgo(event.created_at)}</span>
                    <span title={event.relays?.[0] ?? "relay unknown"}>{event.relays?.[0] ?? "relay unknown"}</span>
                  </div>
                  {renderActions(event)}
                </article>
              ))}
              {showFollowingSkeleton && renderSkeletonCards("following")}
            {followingNotes.length > followingLimit && (
                <button type="button" className="load-more" onClick={() => setFollowingLimit((prev) => prev + 20)}>
                  Load more
                </button>
              )}
            </div>
          </section>
        )}

        {showArticleColumn && (
          <section className={`column ${activeColumn === "articles" ? "active-column" : ""}`}>
            <div className="column-header">
              <div>
                <h2>Articles • Long-form</h2>
              </div>
              <div className="column-header-actions">
                <button type="button" className="ghost-pill">
                  Curated
                </button>
                {articleNewCount > 0 && (
                  <button
                    type="button"
                    className="new-pill"
                    onClick={() => flushNewPosts(articleNewCount, isArticleEvent)}
                  >
                    {articleNewCount} new
                  </button>
                )}
              </div>
            </div>
            <div className="timeline">
              {articleDisplay.map((event) => (
                <article key={event.id} className="timeline-card">
                  <div className="stat-pills">
                    {renderAuthorPill(event)}
                    <span className="stat-pill kind-pill">{kindLabel(event)}</span>
                  </div>
                  {renderEventContent(event)}
                  {renderAttachments(event.attachments)}
                  <div className="meta">
                    <span title={`Posted ${formatAgo(event.created_at)}`}>{formatAgo(event.created_at)}</span>
                    <span title={event.relays?.join(" · ") ?? "relay unknown"}>
                      {event.relays?.join(" · ") ?? "relay unknown"}
                    </span>
                  </div>
                  {renderActions(event)}
                </article>
              ))}
              {showArticleSkeleton && renderSkeletonCards("articles")}
              {articleEvents.length > articlesLimit && (
                <button type="button" className="load-more" onClick={() => setArticlesLimit((prev) => prev + 20)}>
                  Load more
                </button>
              )}
            </div>
          </section>
        )}

        {showGlobalColumn && (
          <section
            className={`column ${activeColumn === "global" ? "active-column" : ""}${
              !isSignedIn ? " full-width-column" : ""
            }`}
          >
            <div className="column-header">
              <div>
                <h2>All • Global Mirror</h2>
              </div>
              <div className="column-header-actions">
                {globalNewCount > 0 && (
                  <button type="button" className="new-pill" onClick={() => flushNewPosts(globalNewCount)}>
                    {globalNewCount} new
                  </button>
                )}
              </div>
            </div>
            <div className="timeline">
              {globalDisplay.map((event) => (
                <article key={event.id} className="timeline-card">
                  <div className="stat-pills">
                    {renderAuthorPill(event)}
                    <span className="stat-pill kind-pill">{kindLabel(event)}</span>
                  </div>
                  {renderEventContent(event)}
                  {renderAttachments(event.attachments)}
                  <div className="meta">
                    <span title={`Posted ${formatAgo(event.created_at)}`}>{formatAgo(event.created_at)}</span>
                    <span title={event.relays?.[0] ?? "relay unknown"}>{event.relays?.[0] ?? "relay unknown"}</span>
                  </div>
                  {renderActions(event)}
                </article>
              ))}
              {showGlobalSkeleton && renderSkeletonCards("global")}
              {globalEvents.length > globalLimit && (
                <button type="button" className="load-more" onClick={() => setGlobalLimit((prev) => prev + 20)}>
                  Load more
                </button>
              )}
            </div>
          </section>
        )}
      </div>

    </div>
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
  return (
    <div ref={ref} className="attachment-video">
      {visible ? (
        <video
          src={url}
          className="attachment-item"
          controls
          preload="metadata"
          playsInline
          muted
          onError={(event) => onError?.(describeMediaError((event.target as HTMLMediaElement)?.error ?? null))}
        />
      ) : (
        <div className="attachment-media-placeholder" />
      )}
    </div>
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
