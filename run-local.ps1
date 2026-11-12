# FIRA — Local Development Server (PowerShell Launcher)
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "  🚀 Starting FIRA Locally (100% Offline - Zero Cloud Dependency)" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host ""

Set-Location $PSScriptRoot

# 1. Verify database exists
if (-not (Test-Path "api\data\fdrates.db")) {
    Write-Host "[1/3] Database not found. Seeding initial SQLite database..." -ForegroundColor Yellow
    Push-Location api
    npm run seed
    Pop-Location
    Write-Host "  ✓ Database created at api\data\fdrates.db" -ForegroundColor Green
} else {
    Write-Host "[1/3] SQLite database ready (api\data\fdrates.db)" -ForegroundColor Green
}

# 2. Launch browser in 3 seconds
Write-Host "[2/3] Launching web browser for http://localhost:5173 ..." -ForegroundColor Yellow
Start-Process -NoNewWindow powershell -ArgumentList "-Command", "Start-Sleep -Seconds 3; Start-Process 'http://localhost:5173'"

# 3. Start API and UI concurrently
Write-Host "[3/3] Starting Express API (port 4000) and Vite UI (port 5173)..." -ForegroundColor Yellow
Write-Host ""
Write-Host "======================================================================" -ForegroundColor Green
Write-Host "  Web UI:   http://localhost:5173" -ForegroundColor White
Write-Host "  API Base: http://localhost:4000/api/v1/" -ForegroundColor White
Write-Host "  Health:   http://localhost:4000/health" -ForegroundColor White
Write-Host ""
Write-Host "  Demo Login:" -ForegroundColor White
Write-Host "    Email:    demo@fdrates.in  (or demo@fira.in)" -ForegroundColor White
Write-Host "    Password: demo123!" -ForegroundColor White
Write-Host ""
Write-Host "  Press Ctrl+C to stop both servers." -ForegroundColor Gray
Write-Host "======================================================================" -ForegroundColor Green
Write-Host ""

npm run dev
