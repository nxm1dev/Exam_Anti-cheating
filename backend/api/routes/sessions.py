"""
backend/api/routes/sessions.py
────────────────────────────────
Exam session lifecycle endpoints.
POST /sessions/          – Start session
GET  /sessions/{id}      – Get session
POST /sessions/{id}/end  – End session
GET  /sessions/user/{id} – List sessions for user
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from api.schemas import SessionCreate, SessionEnd, SessionOut
from core.database import get_db
from services.session_service import SessionService

router = APIRouter(prefix="/sessions", tags=["sessions"])
_service = SessionService()


@router.post("/", response_model=SessionOut, status_code=201)
async def create_session(data: SessionCreate, db: AsyncSession = Depends(get_db)):
    """Start a new exam session."""
    session = await _service.create(db, data)
    return session


@router.get("/user/{user_id}", response_model=list[SessionOut])
async def list_user_sessions(
    user_id: uuid.UUID, db: AsyncSession = Depends(get_db)
):
    return await _service.list_by_user(db, user_id)


@router.get("/{session_id}", response_model=SessionOut)
async def get_session(session_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    session = await _service.get(db, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@router.post("/{session_id}/end", response_model=SessionOut)
async def end_session(
    session_id: uuid.UUID,
    data: SessionEnd,
    db: AsyncSession = Depends(get_db),
):
    """Mark session as ended, update violation counters."""
    session = await _service.end_session(db, session_id, data)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session
