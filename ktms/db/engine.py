from __future__ import annotations
import os
from pathlib import Path
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase

_root = Path(__file__).resolve().parent.parent
_default_url = f"sqlite:///{_root / 'data' / 'ktms.db'}"
DATABASE_URL = os.getenv("DATABASE_URL", _default_url)

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if "sqlite" in DATABASE_URL else {},
    echo=False,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass


def get_session():
    return SessionLocal()
