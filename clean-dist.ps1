# Aggressive cleanup script for dist folder
Write-Host "Cleaning dist folder..."

# Kill all Electron and Time Tracker processes
Get-Process | Where-Object {
    $_.ProcessName -like '*electron*' -or 
    $_.ProcessName -like '*Time Tracker*' -or
    $_.MainWindowTitle -like '*Time Tracker*'
} | Stop-Process -Force -ErrorAction SilentlyContinue

Start-Sleep -Seconds 3

# Also kill any processes using files in dist folder
if (Test-Path "dist\win-unpacked\Time Tracker.exe") {
    Get-Process | Where-Object { $_.Path -like "*Time Tracker*" } | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

# Try to remove dist folder with multiple attempts
if (Test-Path "dist") {
    Write-Host "Attempting to remove dist folder..."
    
    # Try normal removal first
    try {
        Remove-Item -Path "dist" -Recurse -Force -ErrorAction Stop
        Write-Host "Dist folder removed successfully"
    } catch {
        Write-Host "Normal removal failed, trying alternative method..."
        
        # Try removing files individually
        Get-ChildItem -Path "dist" -Recurse -Force | ForEach-Object {
            try {
                Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
            } catch {
                # Ignore errors for locked files
            }
        }
        
        # Try removing directories
        Get-ChildItem -Path "dist" -Recurse -Force -Directory | Sort-Object -Property FullName -Descending | ForEach-Object {
            try {
                Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
            } catch {
                # Ignore errors
            }
        }
        
        # Final attempt to remove dist
        Start-Sleep -Seconds 2
        try {
            Remove-Item -Path "dist" -Recurse -Force -ErrorAction SilentlyContinue
            Write-Host "Dist folder removed after cleanup"
        } catch {
            Write-Host "Warning: Could not fully remove dist folder. Some files may be locked."
            Write-Host "Please close all applications and try again, or manually delete the dist folder."
        }
    }
} else {
    Write-Host "Dist folder does not exist"
}

