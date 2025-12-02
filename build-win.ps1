# Build script for Windows
Write-Host "Starting Windows build process..."

# Clean up processes
Write-Host "Cleaning up processes..."
Get-Process | Where-Object {
    $_.ProcessName -like '*electron*' -or 
    $_.ProcessName -like '*Time Tracker*' -or
    $_.MainWindowTitle -like '*Time Tracker*'
} | Stop-Process -Force -ErrorAction SilentlyContinue

Start-Sleep -Seconds 2

# Clean dist folder
if (Test-Path "dist") {
    Write-Host "Cleaning dist folder..."
    try {
        Remove-Item -Path "dist" -Recurse -Force -ErrorAction Stop
        Write-Host "Dist folder removed successfully"
    } catch {
        Write-Host "Warning: Could not fully remove dist folder. Build will use release folder instead."
    }
}

# Clear electron-builder cache completely to prevent code signing tool download
Write-Host "Clearing electron-builder cache..."
$cachePath = "$env:LOCALAPPDATA\electron-builder\Cache"
if (Test-Path "$cachePath\winCodeSign") {
    # Try to remove the entire winCodeSign directory
    try {
        Get-ChildItem -Path "$cachePath\winCodeSign" -Recurse -Force | ForEach-Object {
            $_.Attributes = 'Normal'
            Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
        }
        Remove-Item -Path "$cachePath\winCodeSign" -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "winCodeSign cache cleared"
    } catch {
        Write-Host "Warning: Could not fully clear winCodeSign cache, but continuing..."
    }
}

# Set environment variables to disable code signing
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
$env:WIN_CSC_LINK = ""
$env:WIN_CSC_KEY_PASSWORD = ""

Write-Host "Code signing disabled via environment variables"
Write-Host "CSC_IDENTITY_AUTO_DISCOVERY = $env:CSC_IDENTITY_AUTO_DISCOVERY"

# Run electron-builder using cmd.exe to ensure environment variable is set
Write-Host "Building application (code signing disabled)..."
cmd /c "set CSC_IDENTITY_AUTO_DISCOVERY=false && npx electron-builder --win"

if ($LASTEXITCODE -eq 0) {
    Write-Host "Build completed successfully!"
} else {
    Write-Host "Build failed with exit code: $LASTEXITCODE"
    exit $LASTEXITCODE
}
