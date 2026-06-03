@echo off
cd /d "%~dp0"
if not exist ".venv" (
    echo Creating virtual environment...
    python -m venv .venv
)
call .venv\Scripts\activate.bat
pip install -r requirements.txt -q
if not exist "data\ktms.db" (
    echo Initializing database...
    python init_db.py
)
echo Starting KTMS...
streamlit run app\Home.py --server.port 8501
