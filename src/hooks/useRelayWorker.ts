import { useCallback, useEffect, useRef } from "react";
import type { Filter } from "nostr-tools";
import type { NostrEvent } from "../types/events";
import type { RelayWorkerHandlers } from "../workers/relayWorker.handlers";

export function useRelayWorker(
  relays: string[],
  handlers: RelayWorkerHandlers,
  baseFilters: Filter[],
  extraFilters?: Filter[]
) {
  const workerRef = useRef<Worker>();
  const handlerRef = useRef(handlers);

  useEffect(() => {
    handlerRef.current = handlers;
  }, [handlers]);

  useEffect(() => {
    const worker = new Worker(new URL("../workers/relayWorker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;

    const listener = (event: MessageEvent) => {
      const payload = event.data as { type: string } & Record<string, unknown>;
      switch (payload.type) {
        case "event":
          handlerRef.current.onEvent?.(payload.event as NostrEvent);
          break;
        case "deletions":
          handlerRef.current.onDeletion?.(payload.ids as string[]);
          break;
        case "fetched":
          handlerRef.current.onEvent?.(payload.event as NostrEvent);
          break;
        case "status":
          handlerRef.current.onStatus?.({
            relays: payload.relays as string[],
            connected: Boolean(payload.connected),
            stats: payload.stats as Record<string, { eventCount: number; dropCount: number }>,
            sleepingRelays: payload.sleepingRelays as string[] | undefined
          });
          break;
        case "error":
          handlerRef.current.onError?.(payload.message as string);
          break;
        case "nccDiscovery":
          handlerRef.current.onDiscovery?.(payload.event as NostrEvent);
          break;
        default:
      }
    };

    worker.addEventListener("message", listener);
    worker.postMessage({ type: "init", relays });

    return () => {
      worker.removeEventListener("message", listener);
      worker.postMessage({ type: "terminate" });
      worker.terminate();
    };
  }, []);

  useEffect(() => {
    workerRef.current?.postMessage({ type: "updateRelays", relays });
  }, [relays]);

  useEffect(() => {
    if (!workerRef.current) return;
    workerRef.current.postMessage({ type: "updateBaseFilters", filters: baseFilters ?? [] });
  }, [baseFilters]);

  useEffect(() => {
    if (!workerRef.current) return;
    workerRef.current.postMessage({ type: "updateFilters", filters: extraFilters ?? [] });
  }, [extraFilters]);

  const fetchEvent = useCallback((id: string) => {
    workerRef.current?.postMessage({ type: "fetch", id });
  }, []);

  return { fetchEvent };
}
