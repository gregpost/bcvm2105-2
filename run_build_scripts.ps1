# script_name: run_build_scripts.ps1
# Windows PowerShell build & deploy utility

$SkipBuild = $false
$NoYals = $false

# Parameter parsing
foreach ($arg in $args) {
    if ($arg -eq "--no-build" -or $arg -eq "-nb") {
        $SkipBuild = $true
    }
    if ($arg -eq "--no-yals" -or $arg -eq "-ny") {
        $NoYals = $true
    }
}

if ($SkipBuild -eq $false) {
    Write-Host ">>> Performing git pull..." -ForegroundColor Cyan
    git pull

    # Construct Node command
    $buildCmd = "npx tsx run_build_scripts.ts --arm"
    if ($NoYals) {
        $buildCmd += " --no-yals"
        Write-Host ">>> Building BCVM & ASN modules for ARM..." -ForegroundColor Yellow
    } else {
        Write-Host ">>> Building BCVM, YALS & ASN modules for ARM..." -ForegroundColor Cyan
    }

    Write-Host ">>> Executing build command: $buildCmd" -ForegroundColor Gray
    Invoke-Expression $buildCmd
} else {
    Write-Host ">>> Skipped build and git pull (--no-build). Deploying existing binary." -ForegroundColor Yellow
}

# SSH deployment configuration
$binaryPath = ""
if (Test-Path "build\bcvm\yav_client_arm") {
    $binaryPath = "build\bcvm\yav_client_arm"
} elseif (Test-Path "cpp_system\bcvm\yav_client_arm") {
    $binaryPath = "cpp_system\bcvm\yav_client_arm"
} elseif (Test-Path "build\bcvm\yav_client") {
    $binaryPath = "build\bcvm\yav_client"
} elseif (Test-Path "cpp_system\bcvm\yav_client") {
    $binaryPath = "cpp_system\bcvm\yav_client"
}

if (-not (Test-Path $binaryPath)) {
    Write-Host "Error: yav_client executable not found at $binaryPath! Please build it first." -ForegroundColor Red
    Exit 1
}

Write-Host ">>> Configuring Windows network interface (IP 192.168.17.233)..." -ForegroundColor Cyan
Write-Host "Note: To configure network adapter IPs on Windows, PowerShell must run as Administrator." -ForegroundColor Yellow

try {
    Write-Host "Checking for active Network Adapters..." -ForegroundColor Gray
    $adapter = Get-NetAdapter | Where-Object { $_.Status -eq "Up" } | Select-Object -First 1
    if ($adapter) {
        Write-Host "Active adapter found: $($adapter.Name)" -ForegroundColor Gray
    }
} catch {
    Write-Host "Windows NetIP commands warning: run powershell under administrator account to change network settings." -ForegroundColor Yellow
}

Write-Host ">>> Securely deploying yav_client to BCVM ($binaryPath -> root@192.168.17.246:/home)..." -ForegroundColor Green
scp $binaryPath root@192.168.17.246:/home

Write-Host ">>> Done." -ForegroundColor Green
