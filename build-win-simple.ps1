# Simple build script that handles the winCodeSign extraction errors
Write-Host "Starting Windows build..."

# Kill processes
Get-Process | Where-Object {$_.ProcessName -like '*electron*' -or $_.ProcessName -like '*Time Tracker*'} | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# Clean dist
if (Test-Path "dist") {
    Remove-Item -Path "dist" -Recurse -Force -ErrorAction SilentlyContinue
}

# Clear cache
$cachePath = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign"
if (Test-Path $cachePath) {
    Remove-Item -Path $cachePath -Recurse -Force -ErrorAction SilentlyContinue
}

# Set environment variable and build
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
Write-Host "Building (code signing disabled)..."
npx electron-builder --win 2>&1 | ForEach-Object {
    # Filter out the winCodeSign extraction errors - they're just macOS files we don't need
    if ($_ -notmatch "Cannot create symbolic link.*darwin") {
        Write-Host $_
    }
}



