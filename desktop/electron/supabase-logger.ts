import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { app, net } from "electron";
import * as fs from "fs";
import * as path from "path";
import WebSocket from "ws";

const SUPABASE_URL = "https://oyfsjrywxxfndcwjyopi.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im95ZnNqcnl3eHhmbmRjd2p5b3BpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5MDU5MTIsImV4cCI6MjA5MzQ4MTkxMn0.kaJmzXFiPNu84RtMFW2TM6w5MpRLCYGvD8qzlSLSNJw";

let supabase: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (!supabase) {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      realtime: {
        transport: WebSocket as any,
      },
    });
  }

  return supabase;
}

interface PendingViolation {
  id: string;
  session_id: string;
  event_type: string;
  severity: string;
  message?: string;
  metadata: Record<string, unknown>;
  occurred_at: string;
  retryCount: number;
}

let pendingViolations: PendingViolation[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let networkCheckTimer: NodeJS.Timeout | null = null;
let wasOnline = true;
let isFlushingViolations = false;
let isFlushingVideos = false;
let violationFlushQueued = false;
let videoFlushQueued = false;

const BATCH_FLUSH_INTERVAL_MS = 60_000;
const NETWORK_POLL_INTERVAL_MS = 5_000;
const BATCH_SIZE = 20;
const MAX_RETRY_COUNT = 50;
const MAX_BATCH_QUEUE_BEFORE_EAGER_FLUSH = 25;

function shouldFlushUrgently(violation: PendingViolation): boolean {
  if (violation.severity === "critical") {
    return true;
  }

  return [
    "exam_cancelled",
    "exam_auto_submit",
    "multi_monitor_blocked",
    "multi_monitor_connected",
    "vm_detected",
  ].includes(violation.event_type);
}

function getQueueDir(): string {
  const dir = path.join(app.getPath("userData"), "secureexam-queue");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getViolationQueuePath(): string {
  return path.join(getQueueDir(), "pending-violations.json");
}

function getVideoQueueDir(): string {
  const dir = path.join(getQueueDir(), "pending-videos");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function countPendingVideos(): number {
  try {
    return fs.readdirSync(getVideoQueueDir()).filter((file) => file.endsWith(".webm")).length;
  } catch {
    return 0;
  }
}

export function initSupabaseLogger(): void {
  loadQueueFromDisk();

  flushTimer = setInterval(() => {
    void flushViolationQueue();
    void flushVideoQueue();
  }, BATCH_FLUSH_INTERVAL_MS);

  networkCheckTimer = setInterval(() => {
    const isOnline = net.isOnline();
    if (!wasOnline && isOnline) {
      console.log("[SupabaseLogger] Back online, flushing queues");
      void flushViolationQueue();
      void flushVideoQueue();
    }
    wasOnline = isOnline;
  }, NETWORK_POLL_INTERVAL_MS);

  void flushViolationQueue();
  void flushVideoQueue();
  void testSupabaseConnection();

  console.log("[SupabaseLogger] Initialized");
}

export function shutdownSupabaseLogger(): void {
  if (flushTimer) clearInterval(flushTimer);
  if (networkCheckTimer) clearInterval(networkCheckTimer);
  flushTimer = null;
  networkCheckTimer = null;
  saveQueueToDisk();
  console.log("[SupabaseLogger] Shutdown (queue saved)");
}

export async function drainSupabaseQueues(): Promise<{
  pendingViolations: number;
  pendingVideos: number;
}> {
  await flushViolationQueue();
  await flushVideoQueue();

  return {
    pendingViolations: pendingViolations.length,
    pendingVideos: countPendingVideos(),
  };
}

async function testSupabaseConnection(): Promise<void> {
  try {
    const { error } = await getSupabase().from("exam_sessions").select("id").limit(1);
    if (error) {
      console.error("[SupabaseLogger] Connection test failed:", error.message);
      return;
    }

    console.log("[SupabaseLogger] Connection test OK");
  } catch (err: any) {
    console.error("[SupabaseLogger] Connection test network error:", err.message);
  }
}

export async function logSessionStart(payload: {
  session_id: string;
  user_id: string;
  user_email?: string;
  user_name?: string;
}): Promise<void> {
  try {
    const { error } = await getSupabase().from("exam_sessions").upsert(
      {
        session_id: payload.session_id,
        user_id: payload.user_id,
        user_email: payload.user_email || null,
        user_name: payload.user_name || null,
        status: "active",
        started_at: new Date().toISOString(),
        total_violations: 0,
        tab_switch_count: 0,
        is_cancelled: false,
      },
      { onConflict: "session_id" }
    );

    if (error) {
      console.error("[SupabaseLogger] logSessionStart error:", error.message);
      return;
    }

    console.log("[SupabaseLogger] Session start logged:", payload.session_id);
  } catch (err: any) {
    console.error("[SupabaseLogger] logSessionStart network error:", err.message);
  }
}

export async function logSessionEnd(
  sessionId: string,
  status: "completed" | "cancelled",
  cancelReason?: string,
  tabSwitchCount?: number
): Promise<void> {
  await flushViolationQueue();
  await flushVideoQueue();

  try {
    const update: Record<string, unknown> = {
      status,
      ended_at: new Date().toISOString(),
      is_cancelled: status === "cancelled",
    };

    if (cancelReason) update.cancel_reason = cancelReason;
    if (tabSwitchCount !== undefined) update.tab_switch_count = tabSwitchCount;

    const { error } = await getSupabase()
      .from("exam_sessions")
      .update(update)
      .eq("session_id", sessionId);

    if (error) {
      console.error("[SupabaseLogger] logSessionEnd error:", error.message);
    }
  } catch (err: any) {
    console.error("[SupabaseLogger] logSessionEnd network error:", err.message);
  }
}

export async function logExamSubmission(sessionId: string): Promise<void> {
  try {
    const { error } = await getSupabase().from("exam_violations").insert({
      session_id: sessionId,
      event_type: "exam_submitted",
      severity: "low",
      message: "Thi sinh da nop bai thi",
      metadata: { submitted_at: new Date().toISOString() },
      occurred_at: new Date().toISOString(),
    });

    if (error) {
      console.error("[SupabaseLogger] logExamSubmission error:", error.message);
      return;
    }

    console.log("[SupabaseLogger] Exam submission logged:", sessionId);
  } catch (err: any) {
    console.error("[SupabaseLogger] logExamSubmission network error:", err.message);
  }
}

export function logViolation(violation: {
  id?: string;
  session_id: string;
  event_type: string;
  severity: string;
  message?: string;
  metadata?: Record<string, unknown>;
}): void {
  const entry: PendingViolation = {
    id: violation.id ?? crypto.randomUUID(),
    session_id: violation.session_id,
    event_type: violation.event_type,
    severity: violation.severity,
    message: violation.message,
    metadata: violation.metadata || {},
    occurred_at: new Date().toISOString(),
    retryCount: 0,
  };

  pendingViolations.push(entry);
  saveQueueToDisk();

  if (shouldFlushUrgently(entry) || pendingViolations.length >= MAX_BATCH_QUEUE_BEFORE_EAGER_FLUSH) {
    void flushViolationQueue();
  }
}

export async function updateSessionViolationCount(
  sessionId: string,
  totalViolations: number,
  tabSwitchCount?: number
): Promise<void> {
  try {
    const update: Record<string, unknown> = { total_violations: totalViolations };
    if (tabSwitchCount !== undefined) update.tab_switch_count = tabSwitchCount;

    await getSupabase().from("exam_sessions").update(update).eq("session_id", sessionId);
  } catch {
    // Non-critical, will sync on next attempt.
  }
}

async function flushViolationQueue(): Promise<void> {
  if (pendingViolations.length === 0) return;
  if (isFlushingViolations) {
    violationFlushQueued = true;
    return;
  }

  isFlushingViolations = true;
  violationFlushQueued = false;

  try {
    const batch = pendingViolations.splice(0);
    const failedItems: PendingViolation[] = [];

    for (let i = 0; i < batch.length; i += BATCH_SIZE) {
      const chunk = batch.slice(i, i + BATCH_SIZE);
      const rows = chunk.map((v) => ({
        id: v.id,
        session_id: v.session_id,
        event_type: v.event_type,
        severity: v.severity,
        message: v.message || null,
        metadata: v.metadata,
        occurred_at: v.occurred_at,
      }));

      try {
        const { error } = await getSupabase().from("exam_violations").upsert(rows, {
          onConflict: "id",
          ignoreDuplicates: true,
        });

        if (error) {
          console.error("[SupabaseLogger] Flush batch error:", error.message);
          await flushChunkIndividually(chunk, failedItems);
        }
      } catch (err: any) {
        console.error("[SupabaseLogger] Flush batch network error:", err.message);
        await flushChunkIndividually(chunk, failedItems);
      }
    }

    if (failedItems.length > 0) {
      pendingViolations.unshift(...failedItems);
    }
  } finally {
    saveQueueToDisk();
    isFlushingViolations = false;
  }

  if (violationFlushQueued && pendingViolations.length > 0) {
    violationFlushQueued = false;
    void flushViolationQueue();
  }
}

async function flushChunkIndividually(
  chunk: PendingViolation[],
  failedItems: PendingViolation[]
): Promise<void> {
  for (const item of chunk) {
    const row = {
      id: item.id,
      session_id: item.session_id,
      event_type: item.event_type,
      severity: item.severity,
      message: item.message || null,
      metadata: item.metadata,
      occurred_at: item.occurred_at,
    };

    try {
      const { error } = await getSupabase().from("exam_violations").insert(row);
      if (!error || isDuplicateKeyError(error)) {
        continue;
      }

      console.error("[SupabaseLogger] Flush row error:", error.message);
      item.retryCount++;
      if (item.retryCount < MAX_RETRY_COUNT) {
        failedItems.push(item);
      }
    } catch (err: any) {
      console.error("[SupabaseLogger] Flush row network error:", err.message);
      item.retryCount++;
      if (item.retryCount < MAX_RETRY_COUNT) {
        failedItems.push(item);
      }
    }
  }
}

export function queueVideoUpload(
  sessionId: string,
  violationId: string,
  videoBuffer: Buffer
): void {
  const filename = `${sessionId}_${violationId}_${Date.now()}.webm`;
  const filepath = path.join(getVideoQueueDir(), filename);
  const metaPath = filepath + ".meta.json";

  fs.writeFileSync(filepath, videoBuffer);
  fs.writeFileSync(
    metaPath,
    JSON.stringify({ sessionId, violationId, filename, createdAt: new Date().toISOString() })
  );

  console.log(`[SupabaseLogger] Video queued: ${filename} (${videoBuffer.length} bytes)`);
  void flushVideoQueue();
}

async function uploadSingleVideo(filepath: string, metaPath: string): Promise<boolean> {
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    const videoData = fs.readFileSync(filepath);
    const storagePath = `${meta.sessionId}/${meta.filename}`;

    const { error: uploadError } = await getSupabase()
      .storage.from("violation-videos")
      .upload(storagePath, videoData, {
        contentType: "video/webm",
        upsert: true,
      });

    if (uploadError) {
      console.error("[SupabaseLogger] Video upload error:", uploadError.message);
      return false;
    }

    const { data: urlData } = getSupabase()
      .storage.from("violation-videos")
      .getPublicUrl(storagePath);

    if (urlData?.publicUrl) {
      const { data: updatedRow, error: updateError } = await getSupabase()
        .from("exam_violations")
        .update({ video_url: urlData.publicUrl })
        .eq("id", meta.violationId)
        .select("id")
        .maybeSingle();

      if (updateError) {
        console.error("[SupabaseLogger] Video URL update error:", updateError.message);
        return false;
      }

      if (!updatedRow) {
        console.warn("[SupabaseLogger] Violation row not ready for video URL update:", meta.violationId);
        return false;
      }
    }

    try {
      fs.unlinkSync(filepath);
      fs.unlinkSync(metaPath);
    } catch {
      // Ignore cleanup failures.
    }

    console.log(`[SupabaseLogger] Video uploaded: ${storagePath}`);
    return true;
  } catch (err: any) {
    console.error("[SupabaseLogger] Video upload network error:", err.message);
    return false;
  }
}

async function flushVideoQueue(): Promise<void> {
  if (isFlushingVideos) {
    videoFlushQueued = true;
    return;
  }

  isFlushingVideos = true;
  videoFlushQueued = false;
  await flushViolationQueue();

  try {
    const files = fs.readdirSync(getVideoQueueDir()).filter((file) => file.endsWith(".webm"));
    for (const file of files) {
      const filepath = path.join(getVideoQueueDir(), file);
      const metaPath = filepath + ".meta.json";

      if (!fs.existsSync(metaPath)) {
        try {
          fs.unlinkSync(filepath);
        } catch {
          // Ignore cleanup failures.
        }
        continue;
      }

      await uploadSingleVideo(filepath, metaPath);
    }
  } catch {
    // Directory may not exist yet.
  } finally {
    isFlushingVideos = false;
  }

  if (videoFlushQueued && countPendingVideos() > 0) {
    videoFlushQueued = false;
    void flushVideoQueue();
  }
}

function saveQueueToDisk(): void {
  try {
    fs.writeFileSync(getViolationQueuePath(), JSON.stringify(pendingViolations));
  } catch (err: any) {
    console.error("[SupabaseLogger] Failed to save queue:", err.message);
  }
}

function loadQueueFromDisk(): void {
  try {
    const data = fs.readFileSync(getViolationQueuePath(), "utf-8");
    const loaded = JSON.parse(data);
    if (Array.isArray(loaded) && loaded.length > 0) {
      pendingViolations = loaded;
      console.log(`[SupabaseLogger] Recovered ${loaded.length} pending violations from disk`);
    }
  } catch {
    pendingViolations = [];
  }
}

function isDuplicateKeyError(error: { code?: string; message?: string } | null | undefined): boolean {
  return error?.code === "23505" || (error?.message || "").includes("duplicate key value");
}
