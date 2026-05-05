/**
 * electron/supabase-logger.ts
 * ────────────────────────────
 * Real-time violation logger to Supabase with offline resilience.
 *
 * Features:
 *   - Rolling send: immediate + batch flush every 10s
 *   - Offline queue: violations saved to disk, auto-flush on reconnect
 *   - Crash recovery: pending queue read on startup
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { app, net } from "electron";
import * as fs from "fs";
import * as path from "path";

// ── Supabase Config ───────────────────────────────────────────────────

const SUPABASE_URL = "https://oyfsjrywxxfndcwjyopi.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im95ZnNqcnl3eHhmbmRjd2p5b3BpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5MDU5MTIsImV4cCI6MjA5MzQ4MTkxMn0.kaJmzXFiPNu84RtMFW2TM6w5MpRLCYGvD8qzlSLSNJw";

let supabase: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (!supabase) {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return supabase;
}

// ── Queue Paths ───────────────────────────────────────────────────────

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

// ── Pending Violation Queue ───────────────────────────────────────────

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

/**
 * Initialize the logger: load pending queue from disk and start timers.
 */
export function initSupabaseLogger(): void {
  // Load any crash-recovery queue
  loadQueueFromDisk();

  // Periodic flush every 10s
  flushTimer = setInterval(() => {
    void flushViolationQueue();
  }, 10_000);

  // Network state polling every 5s
  networkCheckTimer = setInterval(() => {
    const isOnline = net.isOnline();
    if (!wasOnline && isOnline) {
      console.log("[SupabaseLogger] Back online – flushing queues");
      void flushViolationQueue();
      void flushVideoQueue();
    }
    wasOnline = isOnline;
  }, 5_000);

  // Attempt initial flush
  void flushViolationQueue();
  void flushVideoQueue();

  // Test Supabase connectivity
  void testSupabaseConnection();

  console.log("[SupabaseLogger] Initialized");
}

/**
 * Test Supabase connectivity at startup — helps diagnose config issues.
 */
async function testSupabaseConnection(): Promise<void> {
  try {
    const { data, error } = await getSupabase()
      .from("exam_sessions")
      .select("id")
      .limit(1);

    if (error) {
      console.error("[SupabaseLogger] ❌ Connection test FAILED:", error.message);
      console.error("[SupabaseLogger]   Hint: Check that tables exist and RLS policies are set.");
    } else {
      console.log("[SupabaseLogger] ✅ Connection test OK (exam_sessions reachable)");
    }
  } catch (err: any) {
    console.error("[SupabaseLogger] ❌ Connection test FAILED (network):", err.message);
  }
}

/**
 * Shutdown: save pending to disk, clear timers.
 */
export function shutdownSupabaseLogger(): void {
  if (flushTimer) clearInterval(flushTimer);
  if (networkCheckTimer) clearInterval(networkCheckTimer);
  flushTimer = null;
  networkCheckTimer = null;
  saveQueueToDisk();
  console.log("[SupabaseLogger] Shutdown (queue saved)");
}

// ── Session Logging ───────────────────────────────────────────────────

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
    } else {
      console.log("[SupabaseLogger] Session start logged:", payload.session_id);
    }
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
  // Final flush before closing
  await flushViolationQueue();

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

/**
 * Log an explicit "exam submitted" event to exam_violations.
 * This ensures Supabase always has a record when a candidate submits.
 */
export async function logExamSubmission(sessionId: string): Promise<void> {
  try {
    const { error } = await getSupabase().from("exam_violations").insert({
      session_id: sessionId,
      event_type: "exam_submitted",
      severity: "low",
      message: "Thí sinh đã nộp bài thi",
      metadata: { submitted_at: new Date().toISOString() },
      occurred_at: new Date().toISOString(),
    });

    if (error) {
      console.error("[SupabaseLogger] logExamSubmission error:", error.message);
    } else {
      console.log("[SupabaseLogger] Exam submission logged:", sessionId);
    }
  } catch (err: any) {
    console.error("[SupabaseLogger] logExamSubmission network error:", err.message);
  }
}

// ── Violation Logging ─────────────────────────────────────────────────

/**
 * Log a single violation. Sends immediately if online, otherwise queues.
 */
export function logViolation(violation: {
  session_id: string;
  event_type: string;
  severity: string;
  message?: string;
  metadata?: Record<string, unknown>;
}): void {
  const entry: PendingViolation = {
    id: crypto.randomUUID(),
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

  // Try to send immediately
  if (net.isOnline()) {
    void flushViolationQueue();
  }
}

/**
 * Update violation count on session record.
 */
export async function updateSessionViolationCount(
  sessionId: string,
  totalViolations: number,
  tabSwitchCount?: number
): Promise<void> {
  try {
    const update: Record<string, unknown> = { total_violations: totalViolations };
    if (tabSwitchCount !== undefined) update.tab_switch_count = tabSwitchCount;

    await getSupabase()
      .from("exam_sessions")
      .update(update)
      .eq("session_id", sessionId);
  } catch {
    // Non-critical, will sync on next flush
  }
}

// ── Flush Queue ───────────────────────────────────────────────────────

async function flushViolationQueue(): Promise<void> {
  if (pendingViolations.length === 0) return;
  if (!net.isOnline()) return;

  const batch = pendingViolations.splice(0);
  const failedItems: PendingViolation[] = [];

  // Send in chunks of 20 to avoid oversized payloads
  const CHUNK_SIZE = 20;
  for (let i = 0; i < batch.length; i += CHUNK_SIZE) {
    const chunk = batch.slice(i, i + CHUNK_SIZE);
    const rows = chunk.map((v) => ({
      session_id: v.session_id,
      event_type: v.event_type,
      severity: v.severity,
      message: v.message || null,
      metadata: v.metadata,
      occurred_at: v.occurred_at,
    }));

    try {
      const { error } = await getSupabase().from("exam_violations").insert(rows);
      if (error) {
        console.error("[SupabaseLogger] Flush error:", error.message);
        // Re-queue with incremented retry
        for (const item of chunk) {
          item.retryCount++;
          if (item.retryCount < 50) {
            failedItems.push(item);
          }
        }
      }
    } catch (err: any) {
      console.error("[SupabaseLogger] Flush network error:", err.message);
      for (const item of chunk) {
        item.retryCount++;
        if (item.retryCount < 50) {
          failedItems.push(item);
        }
      }
    }
  }

  // Put failed items back
  if (failedItems.length > 0) {
    pendingViolations.unshift(...failedItems);
  }

  saveQueueToDisk();
}

// ── Video Queue ───────────────────────────────────────────────────────

/**
 * Queue a video blob for upload. Saves to disk immediately.
 */
export function queueVideoUpload(
  sessionId: string,
  violationId: string,
  videoBuffer: Buffer
): void {
  const filename = `${sessionId}_${violationId}_${Date.now()}.webm`;
  const filepath = path.join(getVideoQueueDir(), filename);

  // Save metadata alongside video
  const metaPath = filepath + ".meta.json";
  fs.writeFileSync(filepath, videoBuffer);
  fs.writeFileSync(
    metaPath,
    JSON.stringify({ sessionId, violationId, filename, createdAt: new Date().toISOString() })
  );

  console.log(`[SupabaseLogger] Video queued: ${filename} (${videoBuffer.length} bytes)`);

  if (net.isOnline()) {
    void uploadSingleVideo(filepath, metaPath);
  }
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

    // Get public URL
    const { data: urlData } = getSupabase()
      .storage.from("violation-videos")
      .getPublicUrl(storagePath);

    // Update violation record with video URL
    if (urlData?.publicUrl) {
      await getSupabase()
        .from("exam_violations")
        .update({ video_url: urlData.publicUrl })
        .eq("session_id", meta.sessionId)
        .eq("id", meta.violationId);
    }

    // Cleanup files on success
    try {
      fs.unlinkSync(filepath);
      fs.unlinkSync(metaPath);
    } catch { /* ignore cleanup errors */ }

    console.log(`[SupabaseLogger] Video uploaded: ${storagePath}`);
    return true;
  } catch (err: any) {
    console.error("[SupabaseLogger] Video upload network error:", err.message);
    return false;
  }
}

async function flushVideoQueue(): Promise<void> {
  if (!net.isOnline()) return;

  const videoDir = getVideoQueueDir();
  let files: string[];
  try {
    files = fs.readdirSync(videoDir).filter((f) => f.endsWith(".webm"));
  } catch {
    return;
  }

  for (const file of files) {
    const filepath = path.join(videoDir, file);
    const metaPath = filepath + ".meta.json";

    if (!fs.existsSync(metaPath)) {
      // Orphan video without metadata – remove
      try { fs.unlinkSync(filepath); } catch { /* ignore */ }
      continue;
    }

    await uploadSingleVideo(filepath, metaPath);
  }
}

// ── Disk Persistence ──────────────────────────────────────────────────

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
    // No existing queue – fresh start
    pendingViolations = [];
  }
}
