"""
backend/services/report_service.py
────────────────────────────────────
Generates post-session reports from violation data.
"""

import logging
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from api.schemas import ReportOut, ViolationOut, ViolationSummary
from models.session import Session
from services.session_service import SessionService
from services.violation_service import ViolationService

log = logging.getLogger(__name__)


class ReportService:

    def __init__(self):
        self._session_svc = SessionService()
        self._violation_svc = ViolationService()

    async def generate(
        self, db: AsyncSession, session_id: uuid.UUID
    ) -> ReportOut | None:
        """Build a full report for a given session."""
        session: Session | None = await self._session_svc.get(db, session_id)
        if not session:
            return None

        try:
            violations = await self._violation_svc.list_by_session(db, session_id)
            severity_counts = await self._violation_svc.count_by_severity(db, session_id)
            type_counts = await self._violation_svc.count_by_type(db, session_id)
        except Exception as exc:
            log.error("Failed to query violations for session %s: %s", session_id, exc)
            violations = []
            severity_counts = {}
            type_counts = []

        try:
            timeline = [ViolationOut.model_validate(v) for v in violations]
        except Exception as exc:
            log.error("Failed to serialize violations for session %s: %s", session_id, exc)
            timeline = []

        return ReportOut(
            session_id=session.id,
            user_id=session.user_id,
            status=session.status,
            started_at=session.started_at,
            ended_at=session.ended_at,
            total_violations=session.total_violations or len(violations),
            violations_by_severity=severity_counts,
            violations_by_type=[
                ViolationSummary(
                    event_type=t["event_type"],
                    count=t["count"],
                    severity=t["severity"],
                )
                for t in type_counts
            ],
            timeline=timeline,
        )
