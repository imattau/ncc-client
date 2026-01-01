import type { NostrEvent } from "../types/events";

export interface RelayWorkerStatus {
  relays: string[];
  connected: boolean;
  stats?: Record<string, { eventCount: number }>;
}

export interface RelayWorkerHandlers {
  onEvent?: (event: NostrEvent) => void;
  onDeletion?: (ids: string[]) => void;
  onStatus?: (status: RelayWorkerStatus) => void;
  onError?: (message: string) => void;
  onDiscovery?: (event: NostrEvent) => void;
}
