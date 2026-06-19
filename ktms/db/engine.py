from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

_root = Path(__file__).resolve().parent.parent
_default_sqlite = str(_root / "data" / "ktms.db")


class Base(DeclarativeBase):
    pass


def _db_url() -> str:
    return os.environ.get("DATABASE_URL", f"sqlite:///{_default_sqlite}")


@lru_cache(maxsize=1)
def get_engine():
    url = _db_url()
    if url.startswith("sqlite"):
        Path(_default_sqlite).parent.mkdir(parents=True, exist_ok=True)
        return create_engine(url, connect_args={"check_same_thread": False}, echo=False)

    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql://", 1)
    return create_engine(url, echo=False, pool_pre_ping=True)


@lru_cache(maxsize=1)
def _session_factory():
    return sessionmaker(bind=get_engine(), autoflush=False, autocommit=False)


def get_session():
    return _session_factory()()
