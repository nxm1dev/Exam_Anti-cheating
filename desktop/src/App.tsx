/**
 * src/App.tsx
 * ────────────
 * Root component managing which page is shown.
 * Pages: setup → exam → report
 */

import React, { useState } from "react";
import SetupPage, { ExamConfig } from "./pages/SetupPage";
import ExamPage from "./pages/ExamPage";
import ReportPage from "./pages/ReportPage";
import TestPage from "./pages/TestPage";

type AppPage = "setup" | "exam" | "report" | "test";

interface SessionInfo {
  sessionId: string;
  userId: string;
  referenceEmbeddingB64?: string;
}

export default function App() {
  const [page, setPage] = useState<AppPage>("setup");
  const [session, setSession] = useState<SessionInfo | null>(null);

  const handleExamStart = (info: SessionInfo) => {
    setSession(info);
    setPage("exam");
  };

  const handleExamEnd = () => {
    setPage("report");
  };

  const handleNewExam = () => {
    setSession(null);
    setPage("setup");
  };

  return (
    <>
      {page === "setup" && (
        <SetupPage 
          onExamStart={handleExamStart} 
          onTestMode={() => setPage("test")} 
        />
      )}
      {page === "test" && (
        <TestPage onBack={() => setPage("setup")} />
      )}
      {page === "exam" && session && (
        <ExamPage
          sessionId={session.sessionId}
          userId={session.userId}
          referenceEmbeddingB64={session.referenceEmbeddingB64}
          onExamEnd={handleExamEnd}
        />
      )}
      {page === "report" && session && (
        <ReportPage
          sessionId={session.sessionId}
          onNewExam={handleNewExam}
        />
      )}
    </>
  );
}
