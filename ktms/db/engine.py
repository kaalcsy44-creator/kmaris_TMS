from __future__ import annotations
import os
from pathlib import Path
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase

_root = Path(__file__).resolve().parent.parent
_default_sqlite = str(_root / "data" / "ktms.db")

_engine = None
_SessionLocal = None


class Base(DeclarativeBase):
    pass


def _db_url() -> str:
    return os.environ.get("DATABASE_URL", f"sqlite:///{_default_sqlite}")


def get_engine():
    global _engine
    if _engine is None:
        url = _db_url()
        if url.startswith("sqlite"):
            Path(_default_sqlite).parent.mkdir(parents=True, exist_ok=True)
            _engine = create_engine(url, connect_args={"check_same_thread": False}, echo=False)
        else:
            # PostgreSQL — fix Supabase/Heroku-style "postgres://" prefix
            if url.startswith("postgres://"):
                url = url.replace("postgres://", "postgresql://", 1)
            _engine = create_engine(url, echo=False)
    return _engine


def get_session():
    global _SessionLocal
    if _SessionLocal is None:
        _SessionLocal = sessionmaker(bind=get_engine(), autoflush=False, autocommit=False)
    return _SessionLocal()
