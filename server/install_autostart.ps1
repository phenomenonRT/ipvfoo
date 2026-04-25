# IPvFoo Collector — Autostart installer/uninstaller
# Run once to add the server to Windows Startup (no admin rights needed)

param(
    [switch]$Uninstall
)

$startupFolder = [System.Environment]::GetFolderPath("Startup")
$shortcutPath  = Join-Path $startupFolder "IPvFoo Collector.lnk"
$scriptDir     = Split-Path -Parent $MyInvocation.MyCommand.Definition
$vbsPath       = Join-Path $scriptDir "start_server.vbs"

if ($Uninstall) {
    if (Test-Path $shortcutPath) {
        Remove-Item $shortcutPath -Force
        Write-Host "Autostart removed." -ForegroundColor Yellow
    } else {
        Write-Host "Autostart shortcut not found." -ForegroundColor Gray
    }
    exit 0
}

# Create shortcut
$shell    = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath       = "wscript.exe"
$shortcut.Arguments        = "`"$vbsPath`""
$shortcut.WorkingDirectory = $scriptDir
$shortcut.WindowStyle      = 7        # Minimized (invisible for VBS anyway)
$shortcut.Description      = "IPvFoo Collector Server"
$shortcut.Save()

Write-Host "Autostart installed!" -ForegroundColor Green
Write-Host "Shortcut: $shortcutPath"
Write-Host ""
Write-Host "To remove autostart, run:  .\install_autostart.ps1 -Uninstall"
