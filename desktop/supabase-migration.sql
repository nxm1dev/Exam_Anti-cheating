-- ============================================================
-- SecureExam – Supabase Schema Migration
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ============================================================

-- 1. Create exam_sessions table
CREATE TABLE IF NOT EXISTS exam_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  user_email TEXT,
  user_name TEXT,
  status TEXT DEFAULT 'active',
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  total_violations INT DEFAULT 0,
  tab_switch_count INT DEFAULT 0,
  is_cancelled BOOLEAN DEFAULT FALSE,
  cancel_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Create exam_violations table
CREATE TABLE IF NOT EXISTS exam_violations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT,
  metadata JSONB DEFAULT '{}',
  video_url TEXT,
  occurred_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_violations_session ON exam_violations(session_id);
CREATE INDEX IF NOT EXISTS idx_violations_severity ON exam_violations(severity);
CREATE INDEX IF NOT EXISTS idx_violations_occurred ON exam_violations(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON exam_sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON exam_sessions(started_at DESC);

-- 4. Create summary view
CREATE OR REPLACE VIEW exam_summary AS
SELECT 
  s.session_id,
  s.user_name,
  s.user_email,
  s.user_id,
  s.status,
  s.is_cancelled,
  s.cancel_reason,
  s.started_at,
  s.ended_at,
  s.tab_switch_count,
  COUNT(v.id) AS total_violations,
  COUNT(CASE WHEN v.severity = 'critical' THEN 1 END) AS critical_count,
  COUNT(CASE WHEN v.severity = 'high' THEN 1 END) AS high_count,
  COUNT(CASE WHEN v.severity = 'medium' THEN 1 END) AS medium_count,
  COUNT(CASE WHEN v.severity = 'low' THEN 1 END) AS low_count
FROM exam_sessions s
LEFT JOIN exam_violations v ON v.session_id = s.session_id
GROUP BY s.id;

-- 5. Enable Row Level Security (allow anon read/write for exam logging)
ALTER TABLE exam_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_violations ENABLE ROW LEVEL SECURITY;

-- Allow anon key to insert and read (needed for desktop app)
DROP POLICY IF EXISTS "Allow anon insert sessions" ON exam_sessions;
CREATE POLICY "Allow anon insert sessions" ON exam_sessions
  FOR INSERT TO anon WITH CHECK (true);
DROP POLICY IF EXISTS "Allow anon read sessions" ON exam_sessions;
CREATE POLICY "Allow anon read sessions" ON exam_sessions
  FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "Allow anon update sessions" ON exam_sessions;
CREATE POLICY "Allow anon update sessions" ON exam_sessions
  FOR UPDATE TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow anon insert violations" ON exam_violations;
CREATE POLICY "Allow anon insert violations" ON exam_violations
  FOR INSERT TO anon WITH CHECK (true);
DROP POLICY IF EXISTS "Allow anon read violations" ON exam_violations;
CREATE POLICY "Allow anon read violations" ON exam_violations
  FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "Allow anon update violations" ON exam_violations;
CREATE POLICY "Allow anon update violations" ON exam_violations
  FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- Also allow authenticated role (safety net if client auth changes)
DROP POLICY IF EXISTS "Allow authenticated insert sessions" ON exam_sessions;
CREATE POLICY "Allow authenticated insert sessions" ON exam_sessions
  FOR INSERT TO authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "Allow authenticated read sessions" ON exam_sessions;
CREATE POLICY "Allow authenticated read sessions" ON exam_sessions
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Allow authenticated update sessions" ON exam_sessions;
CREATE POLICY "Allow authenticated update sessions" ON exam_sessions
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow authenticated insert violations" ON exam_violations;
CREATE POLICY "Allow authenticated insert violations" ON exam_violations
  FOR INSERT TO authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "Allow authenticated read violations" ON exam_violations;
CREATE POLICY "Allow authenticated read violations" ON exam_violations
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Allow authenticated update violations" ON exam_violations;
CREATE POLICY "Allow authenticated update violations" ON exam_violations
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- 6. Create storage bucket for violation videos
INSERT INTO storage.buckets (id, name, public)
VALUES ('violation-videos', 'violation-videos', true)
ON CONFLICT (id) DO NOTHING;

-- Allow anon upload/read for violation videos
DROP POLICY IF EXISTS "Allow anon upload violation videos" ON storage.objects;
CREATE POLICY "Allow anon upload violation videos" ON storage.objects
  FOR INSERT TO anon WITH CHECK (bucket_id = 'violation-videos');
DROP POLICY IF EXISTS "Allow anon read violation videos" ON storage.objects;
CREATE POLICY "Allow anon read violation videos" ON storage.objects
  FOR SELECT TO anon USING (bucket_id = 'violation-videos');
