import { useEffect, useState } from "react";
import { resolveService } from "../services/ncc02Resolver";
import type { ResolvedService } from "ncc-02-js";

export type Ncc02Status = "idle" | "pending" | "resolved" | "error";

export function useNcc02Discovery(ownerPubkey: string, serviceId: string) {
  const [service, setService] = useState<ResolvedService | null>(null);
  const [status, setStatus] = useState<Ncc02Status>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setStatus("pending");
    setError(null);

    resolveService(ownerPubkey, serviceId)
      .then((resolved) => {
        if (!mounted) return;
        if (resolved) {
          setService(resolved);
          setStatus("resolved");
        } else {
          setStatus("error");
          setError("resolver returned no service info");
        }
      })
      .catch((err) => {
        if (!mounted) return;
        setStatus("error");
        setError(err?.message ?? "unknown resolver error");
      });

    return () => {
      mounted = false;
    };
  }, [ownerPubkey, serviceId]);

  return { service, status, error };
}
