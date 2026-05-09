import { useCallback, useRef, useState } from "react";
import { shouldPersistViolation } from "../lib/violationPolicy";

const api = (window as any).electronAPI;

export interface ViolationEvent {
  id: string;
  eventType: string;
  severity: string;
  message?: string;
  metadata: Record<string, unknown>;
  timestamp: Date;
}

interface Options {
  sessionId: string;
  userId: string;
  batchIntervalMs?: number;
}

export function useViolations({ sessionId, userId }: Options) {
  const [violations, setViolations] = useState<ViolationEvent[]>([]);
  const pendingRef = useRef<ViolationEvent[]>([]);

  const addViolation = useCallback(
    (
      eventType: string,
      severity: string,
      metadata: Record<string, unknown> = {},
      message?: string,
      violationId?: string
    ) => {
      if (!shouldPersistViolation(eventType, severity, metadata)) {
        return;
      }

      const event: ViolationEvent = {
        id: violationId ?? crypto.randomUUID(),
        eventType,
        severity,
        message,
        metadata,
        timestamp: new Date(),
      };

      setViolations((previous) => [event, ...previous].slice(0, 200));
      pendingRef.current.push(event);
    },
    []
  );

  const flushViolations = useCallback(async () => {
    if (!pendingRef.current.length) {
      return;
    }

    const batch = pendingRef.current.splice(0);
    try {
      await api.logViolationsBatch(
        batch.map((violation) => ({
          id: violation.id,
          session_id: sessionId,
          user_id: userId,
          event_type: violation.eventType,
          severity: violation.severity,
          message: violation.message,
          metadata: violation.metadata,
        }))
      );
    } catch {
      pendingRef.current.unshift(...batch);
      console.warn("[useViolations] Batch send failed, will retry");
    }
  }, [sessionId, userId]);

  return { violations, addViolation, flushViolations };
}
