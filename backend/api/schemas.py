"""
backend/api/schemas.py
──────────────────────
Pydantic schemas for request/response validation across all routes.
"""

import uuid
from datetime import datetime
from typing import Any

from pydantic import AliasChoices, BaseModel, EmailStr, Field


# ──────────────────────────────────────────
# User schemas
# ──────────────────────────────────────────

class UserCreate(BaseModel):
    email: EmailStr
    full_name: str
    role: str = "candidate"


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    full_name: str
    role: str
    face_embedding: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class FaceEmbeddingUpdate(BaseModel):
    """Used when registering a candidate's reference face."""
    face_embedding: str  # base64-encoded numpy array


# ──────────────────────────────────────────
# Session schemas
# ──────────────────────────────────────────

class SessionCreate(BaseModel):
    user_id: uuid.UUID
    exam_url: str


class SessionOut(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    exam_url: str
    status: str
    started_at: datetime
    ended_at: datetime | None
    total_violations: int
    critical_count: int
    high_count: int
    medium_count: int
    low_count: int

    model_config = {"from_attributes": True}


class SessionEnd(BaseModel):
    status: str = "completed"  # completed | terminated | cancelled
    # Optional client-side violation counts (fallback if batch logging failed)
    total_violations: int | None = None
    critical_count: int | None = None
    high_count: int | None = None
    medium_count: int | None = None
    low_count: int | None = None


# ──────────────────────────────────────────
# Violation schemas
# ──────────────────────────────────────────

class ViolationCreate(BaseModel):
    session_id: uuid.UUID
    user_id: uuid.UUID
    event_type: str
    severity: str = "medium"  # low | medium | high | critical
    event_metadata: dict[str, Any] = Field(
        default_factory=dict,
        validation_alias=AliasChoices("event_metadata", "metadata"),
    )


class ViolationOut(BaseModel):
    id: uuid.UUID
    session_id: uuid.UUID
    user_id: uuid.UUID
    event_type: str
    severity: str
    event_metadata: dict[str, Any]
    occurred_at: datetime

    model_config = {"from_attributes": True}


# ──────────────────────────────────────────
# Report schemas
# ──────────────────────────────────────────

class ViolationSummary(BaseModel):
    event_type: str
    count: int
    severity: str


class ReportOut(BaseModel):
    session_id: uuid.UUID
    user_id: uuid.UUID
    status: str
    started_at: datetime
    ended_at: datetime | None
    total_violations: int
    violations_by_severity: dict[str, int]
    violations_by_type: list[ViolationSummary]
    timeline: list[ViolationOut]
