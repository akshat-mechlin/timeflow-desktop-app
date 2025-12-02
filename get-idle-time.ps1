Add-Type @"
using System;
using System.Runtime.InteropServices;
public class LastInput {
    [DllImport("user32.dll")]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    [DllImport("kernel32.dll")]
    public static extern uint GetTickCount();
    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO {
        public uint cbSize;
        public uint dwTime;
    }
}
"@
$lastInput = New-Object LastInput+LASTINPUTINFO
$lastInput.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($lastInput)
[LastInput]::GetLastInputInfo([ref]$lastInput)
$tickCount = [LastInput]::GetTickCount()
$idleTime = ($tickCount - $lastInput.dwTime) / 1000
Write-Output $idleTime



