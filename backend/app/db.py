from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import get_settings


class Base(DeclarativeBase):
    pass


def make_engine(url: str | None = None):
    db_url = url or get_settings().database_url
    options = {"connect_args": {"check_same_thread": False}} if db_url.startswith("sqlite") else {}
    return create_engine(db_url, **options)


engine = make_engine()
SessionLocal = sessionmaker(engine, expire_on_commit=False)


def get_db():
    with SessionLocal() as session:
        yield session
