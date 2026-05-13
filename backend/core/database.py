"""
backend/core/database.py
Async SQLAlchemy engine + session factory.
All DB operations use async/await for non-blocking I/O.
"""

from typing import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from core.config import get_settings

settings = get_settings()

engine_kwargs = {
    "echo": False,
}

if not settings.database_url.startswith("sqlite"):
    engine_kwargs.update(
        {
            "pool_pre_ping": True,
            "pool_size": 10,
            "max_overflow": 20,
        }
    )

engine = create_async_engine(
    settings.database_url,
    connect_args={
        "statement_cache_size": 0,
        "prepared_statement_cache_size": 0
    },
    **engine_kwargs
)

AsyncSessionFactory = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


class Base(DeclarativeBase):
    """Base class for all ORM models."""


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """
    FastAPI dependency - yields an async DB session per request.
    Session is automatically closed after the request.
    """
    async with AsyncSessionFactory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
