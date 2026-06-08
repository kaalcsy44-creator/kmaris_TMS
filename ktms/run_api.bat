@echo off
cd /d "%~dp0"
if not exist ".venv" (
    echo Creating virtual environment...
    python -m venv .venv
)
call .venv\Scripts\activate.bat
pip install -r requirements.txt -q
echo Starting KTMS Tracking API on http://0.0.0.0:8000 ...
echo Health check: http://localhost:8000/health
uvicorn api:app --host 0.0.0.0 --port 8000 --reload
