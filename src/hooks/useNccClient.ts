import { useCallback, useEffect, useState } from "react";
import { DEFAULT_RELAYS } from "../config/relays";
import { fetchRelayList, initNccClient } from "../services/nccClient";
import { appErrorManager } from "../utils/errorManager";

export interface NccClientStatus {
  connected: boolean;
  relays: string[];
  error?: string;
}

export function useNccClient() {
  const [status, setStatus] = useState<NccClientStatus>({ connected: false, relays: DEFAULT_RELAYS });

  const refresh = useCallback(async () => {
    try {
      await initNccClient();
      const relays = await fetchRelayList();
      setStatus({ connected: true, relays: relays ?? DEFAULT_RELAYS });
    } catch (error) {
      const message = (error as Error).message ?? "unknown";
      appErrorManager.report({
        message: `ncc client bootstrap failed: ${message}`,
        source: "ncc client",
        severity: "warning",
        details: error
      });
      setStatus({ connected: false, relays: DEFAULT_RELAYS, error: message });
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { ...status, refresh };
}
