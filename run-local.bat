@echo off
title FIRA — Local Development Server
echo ======================================================================
echo   🚀 Starting FIRA Locally (100%% Offline - Zero Cloud Dependency)
echo ======================================================================
echo.

cd /d "%~dp0"

:: 1. Verify database exists
if not exist "api\data\fdrates.db" (
    echo [1/3] Database not found. Seeding initial SQLite database...
    cd api
    call npm run seed
    cd ..
    echo   ✓ Database created at api\data\fdrates.db
) else (
    echo [1/3] SQLite database ready (api\data\fdrates.db)
)

:: 2. Launch browser automatically in 3 seconds in background
echo [2/3] Launching web browser for http://localhost:5173 ...
start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:5173"

:: 3. Start API and UI concurrently
echo [3/3] Starting Express API (port 4000) and Vite UI (port 5173)...
echo.
echo ======================================================================
echo   Web UI:   http://localhost:5173
echo   API Base: http://localhost:4000/api/v1/
echo   Health:   http://localhost:4000/health
echo.
echo   Demo Login:
echo     Email:    demo@fdrates.in  (or demo@fira.in)
echo     Password: demo123!
echo.
echo   Press Ctrl+C to stop both servers.
echo ======================================================================
echo.

call npm run dev
