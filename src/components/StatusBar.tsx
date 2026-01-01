import type { Dispatch, SetStateAction } from "react";
import type { RelayWorkerStatus } from "../workers/relayWorker.handlers";

type StatusBarProps = {
  connected: boolean;
  managedRelays: string[];
  relayStatus: RelayWorkerStatus | null;
  isOfflineMode: boolean;
  isRelayModalOpen: boolean;
  setIsRelayModalOpen: Dispatch<SetStateAction<boolean>>;
  isManualRefreshing: boolean;
  triggerManualRefresh: () => Promise<void>;
};

export const StatusBar = ({
  connected,
  managedRelays,
  relayStatus,
  isOfflineMode,
  isRelayModalOpen,
  setIsRelayModalOpen,
  isManualRefreshing,
  triggerManualRefresh
}: StatusBarProps) => {
  const relayEventStats = relayStatus?.stats?.total;
  const relayEventLabel = relayEventStats
    ? `${relayEventStats.eventCount} (${relayEventStats.dropCount} dropped)`
    : "waiting…";
  const sleepingCount = relayStatus?.sleepingRelays?.length ?? 0;

  return (
    <div className="status-box">
      <div className="status-chip">
        <span>{connected ? "Online" : "Offline"}</span>
        <button
          type="button"
          className="relay-pill"
          aria-expanded={isRelayModalOpen}
          onClick={() => setIsRelayModalOpen((prev) => !prev)}
        >
          Relays: {managedRelays.length}
        </button>
        <span className="relay-health">Events: {relayEventLabel}</span>
        <button type="button" onClick={triggerManualRefresh} disabled={isManualRefreshing}>
          {isManualRefreshing ? "Refreshing..." : "Refresh"}
        </button>
      </div>
      {sleepingCount ? (
        <div className="status-note">
          Sleeping relays: {sleepingCount} (cooldown active)
        </div>
      ) : null}
      {isOfflineMode ? (
        <div className="status-note status-note-offline">
          Showing cached entries while relays reconnect.
        </div>
      ) : null}
      {relayEventStats?.dropCount ? (
        <div className="status-alert">
          Worker skipped {relayEventStats.dropCount} repeated events to keep the feed sane.
        </div>
      ) : (
        <div className="status-alert status-alert-muted">
          Rate limiting is quiet—no suspicious bursts right now.
        </div>
      )}
    </div>
  );
};
