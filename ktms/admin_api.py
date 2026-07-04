"""K-Maris TMS Admin API — entry point (uvicorn: admin_api:app).

Shared app/helpers/models live in _core.py; HTTP route handlers live in
routers/<domain>.py. Importing each router module registers its @app
routes on the shared app instance. Behavior is identical to the former
single-file admin_api.py — this split is structural only.
"""
from _core import app  # noqa: F401  (uvicorn entry: admin_api:app)

from routers import (  # noqa: F401  (import side effect: registers routes)
    auth,
    dashboard,
    rfq,
    sourcing,
    quotation,
    po,
    documents,
    ar,
    marketing,
    settings,
)
