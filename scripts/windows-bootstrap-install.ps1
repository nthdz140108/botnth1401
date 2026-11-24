param(
  [switch]$Unattended,
  [switch]$SkipDoctor
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Force TLS 1.2 + TLS 1.1 + TLS 1.0 for Windows Server 2012 / 2012 R2 (.NET 4.5+)
try {
  $tls12 = [Enum]::ToObject([Net.SecurityProtocolType], 3072)
  $tls11 = [Enum]::ToObject([Net.SecurityProtocolType], 768)
  $tls10 = [Enum]::ToObject([Net.SecurityProtocolType], 192)
  [Net.ServicePointManager]::SecurityProtocol = $tls12 -bor $tls11 -bor $tls10
} catch {
  Write-Warning "Khong the ep TLS 1.2 tu dong: $($_.Exception.Message)"
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $RepoRoot

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "   HHH_MYBOT - ONE-CLICK INSTALLER (WINDOWS SERVER 2012 R2+)    " -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "[INFO] Thu muc Repo : $RepoRoot"

if (-not [Environment]::Is64BitOperatingSystem) {
  throw "He thong yeu cau Windows 64-bit (x64)."
}

$osVer = [Environment]::OSVersion.Version
Write-Host "[INFO] Phien ban OS : Windows NT $($osVer.Major).$($osVer.Minor) (x64)"
if (($osVer.Major -lt 6) -or ($osVer.Major -eq 6 -and $osVer.Minor -lt 2)) {
  throw "Yeu cau toi thieu Windows Server 2012 / Windows 8 x64 (NT 6.2+)."
}

# Bypass Node.js 20 Windows >= 10 check & skip Python/binary checks in youtube-dl-exec on Windows Server 2012 / 2012 R2
$env:NODE_SKIP_PLATFORM_CHECK = "1"
$env:YOUTUBE_DL_SKIP_PYTHON_CHECK = "1"
$env:YOUTUBE_DL_SKIP_DOWNLOAD = "1"
$env:MYBOT_RESOURCE_PROFILE = "lean"
$env:PROJECT_ROOT = $RepoRoot

# Create sandboxed runtime & bot directories inside repo (zero external disk leaks)
$dirs = @(
  ".runtime\bin",
  ".runtime\temp",
  ".runtime\temp\.leases",
  ".runtime\pm2",
  ".runtime\backups",
  ".runtime\disk-cleanup",
  "mybot\credentials",
  "mybot\bots",
  "mybot\configs",
  "mybot\instances",
  "mybot\state",
  "mybot\logs",
  "logs",
  "assets\temp",
  "assets\data",
  "assets\json-data",
  "video"
)
foreach ($rel in $dirs) {
  $full = Join-Path $RepoRoot $rel
  if (-not (Test-Path $full)) {
    New-Item -ItemType Directory -Path $full -Force | Out-Null
  }
}

$RuntimeBin = Join-Path $RepoRoot ".runtime\bin"
$RuntimeTemp = Join-Path $RepoRoot ".runtime\temp"
$PortableNodeDir = Join-Path $RuntimeBin "node"
$env:TEMP = $RuntimeTemp
$env:TMP = $RuntimeTemp
$env:PM2_HOME = Join-Path $RepoRoot ".runtime\pm2"

function Download-FileFast {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Destination
  )
  $wc = New-Object System.Net.WebClient
  try {
    $wc.Headers.Add("User-Agent", "HHH-MyBot-Bootstrap/3.0")
    $wc.DownloadFile($Url, $Destination)
  } finally {
    $wc.Dispose()
  }
}

function Extract-ZipCompatible {
  param(
    [Parameter(Mandatory = $true)][string]$ZipPath,
    [Parameter(Mandatory = $true)][string]$DestinationDir
  )
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  if (Test-Path $DestinationDir) {
    Remove-Item -Path $DestinationDir -Recurse -Force
  }
  [System.IO.Compression.ZipFile]::ExtractToDirectory($ZipPath, $DestinationDir)
}

# 1. Check & install VC++ 2015-2022 Redistributable x64 (required by Sharp / Canvas / TensorFlow native addons)
$vcRuntimeDll = Join-Path $env:SystemRoot "System32\vcruntime140.dll"
if (-not (Test-Path $vcRuntimeDll)) {
  Write-Host "[1/6] Dang tai va cai dat Microsoft VC++ 2015-2022 Redistributable (x64)..." -ForegroundColor Yellow
  $vcExe = Join-Path $RuntimeTemp "vc_redist.x64.exe"
  try {
    Download-FileFast -Url "https://aka.ms/vs/17/release/vc_redist.x64.exe" -Destination $vcExe
    $proc = Start-Process -FilePath $vcExe -ArgumentList "/install", "/quiet", "/norestart" -Wait -PassThru
    if ($proc.ExitCode -notin @(0, 1638, 3010)) {
      Write-Warning "VC++ Redistributable tra ma $($proc.ExitCode) (co the can quyen Administrator)."
    } else {
      Write-Host "      -> Cai dat VC++ Redistributable thanh cong." -ForegroundColor Green
    }
  } finally {
    if (Test-Path $vcExe) { Remove-Item $vcExe -Force -ErrorAction SilentlyContinue }
  }
} else {
  Write-Host "[1/6] VC++ Redistributable x64 da san sang." -ForegroundColor Green
}

# 2. Check or download Portable Node.js v20.18.3 LTS x64
$nodeExe = $null
$portableNodeExe = Join-Path $PortableNodeDir "node.exe"
if (Test-Path $portableNodeExe) {
  $nodeExe = $portableNodeExe
} else {
  $sysNode = Get-Command node -ErrorAction SilentlyContinue
  if ($sysNode) {
    try {
      $verRaw = & $sysNode.Source -v 2>$null
      if ($verRaw -match "^v(\d+)\.") {
        $major = [int]$Matches[1]
        if ($major -ge 20) {
          $nodeExe = $sysNode.Source
        }
      }
    } catch {}
  }
}

if (-not $nodeExe) {
  $nodeVersion = "v20.18.3"
  $nodeZipUrl = "https://nodejs.org/dist/$nodeVersion/node-$nodeVersion-win-x64.zip"
  $nodeZipPath = Join-Path $RuntimeTemp "node-$nodeVersion-win-x64.zip"
  $extractTmp = Join-Path $RuntimeTemp "node-extract"
  Write-Host "[2/6] Dang tai Node.js $nodeVersion LTS Portable (tuong thich Win Server 2012 R2)..." -ForegroundColor Yellow
  try {
    Download-FileFast -Url $nodeZipUrl -Destination $nodeZipPath
    Extract-ZipCompatible -ZipPath $nodeZipPath -DestinationDir $extractTmp
    $innerFolder = Join-Path $extractTmp "node-$nodeVersion-win-x64"
    if (Test-Path $PortableNodeDir) { Remove-Item $PortableNodeDir -Recurse -Force }
    Move-Item -Path $innerFolder -Destination $PortableNodeDir -Force
    $nodeExe = $portableNodeExe
    Write-Host "      -> Da cai Node.js Portable tai $PortableNodeDir" -ForegroundColor Green
  } finally {
    if (Test-Path $nodeZipPath) { Remove-Item $nodeZipPath -Force -ErrorAction SilentlyContinue }
    if (Test-Path $extractTmp) { Remove-Item $extractTmp -Recurse -Force -ErrorAction SilentlyContinue }
  }
} else {
  Write-Host "[2/6] Node.js san sang: $nodeExe" -ForegroundColor Green
}

$nodeBinFolder = Split-Path -Parent $nodeExe
$env:PATH = "$PortableNodeDir;$RuntimeBin;$nodeBinFolder;$env:PATH"

# 3. Check or download Portable FFmpeg + FFprobe
$env:WER_DONT_SHOW_UI = "1"
try {
  $win32Def = @'
using System;
using System.Runtime.InteropServices;
public static class Win32Native {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetErrorMode(uint uMode);
}
'@
  Add-Type -TypeDefinition $win32Def -ErrorAction SilentlyContinue
  [Win32Native]::SetErrorMode(3) | Out-Null
} catch {}

function Test-MediaBinaryWorks {
  param([string]$FilePath)
  if ([string]::IsNullOrWhiteSpace($FilePath)) { return $false }
  if (-not (Test-Path -LiteralPath $FilePath)) { return $false }
  try {
    $pinfo = New-Object System.Diagnostics.ProcessStartInfo
    $pinfo.FileName = $FilePath
    $pinfo.Arguments = "-version"
    $pinfo.UseShellExecute = $false
    $pinfo.CreateNoWindow = $true
    $pinfo.RedirectStandardOutput = $true
    $pinfo.RedirectStandardError = $true
    $proc = [System.Diagnostics.Process]::Start($pinfo)
    $finished = $proc.WaitForExit(6000)
    if (-not $finished) {
      try { $proc.Kill() } catch {}
      return $false
    }
    return ($proc.ExitCode -eq 0)
  } catch {
    return $false
  }
}

$ffmpegBin = Join-Path $RuntimeBin "ffmpeg.exe"
$ffprobeBin = Join-Path $RuntimeBin "ffprobe.exe"
$hasFfmpeg = (Test-MediaBinaryWorks $ffmpegBin) -and (Test-MediaBinaryWorks $ffprobeBin)
if (-not $hasFfmpeg) {
  $sysFfmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
  $sysFfprobe = Get-Command ffprobe -ErrorAction SilentlyContinue
  $sysFfmpegPath = if ($sysFfmpeg) { $sysFfmpeg.Source } else { $null }
  $sysFfprobePath = if ($sysFfprobe) { $sysFfprobe.Source } else { $null }
  if ($sysFfmpegPath -and $sysFfprobePath) {
    if ((Test-MediaBinaryWorks $sysFfmpegPath) -and (Test-MediaBinaryWorks $sysFfprobePath)) {
      $hasFfmpeg = $true
    }
  }
}

if (-not $hasFfmpeg) {
  Write-Host "[3/6] Dang tai FFmpeg + FFprobe Portable tuong thich..." -ForegroundColor Yellow
  $ffZip = Join-Path $RuntimeTemp "ffmpeg-win64.zip"
  $ffExtract = Join-Path $RuntimeTemp "ffmpeg-extract"
  $ffmpegBak = "$ffmpegBin.bak"
  $ffprobeBak = "$ffprobeBin.bak"
  if (Test-Path $ffmpegBin) { Move-Item -Path $ffmpegBin -Destination $ffmpegBak -Force -ErrorAction SilentlyContinue }
  if (Test-Path $ffprobeBin) { Move-Item -Path $ffprobeBin -Destination $ffprobeBak -Force -ErrorAction SilentlyContinue }

  $urls = if ($osVer.Major -lt 10) {
    # Windows Server 2012 R2 (NT 6.2/6.3): uu tien Gyan Essentials ho tro Windows 7/8.1/2012 R2
    @(
      "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
      "https://github.com/GyanD/codexffmpeg/releases/download/7.1/ffmpeg-7.1-essentials_build.zip",
      "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
    )
  } else {
    @(
      "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
      "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
    )
  }

  $installedOk = $false
  foreach ($url in $urls) {
    try {
      if (Test-Path $ffZip) { Remove-Item $ffZip -Force -ErrorAction SilentlyContinue }
      if (Test-Path $ffExtract) { Remove-Item $ffExtract -Recurse -Force -ErrorAction SilentlyContinue }
      Download-FileFast -Url $url -Destination $ffZip
      Extract-ZipCompatible -ZipPath $ffZip -DestinationDir $ffExtract
      $foundFfmpeg = Get-ChildItem -Path $ffExtract -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
      $foundFfprobe = Get-ChildItem -Path $ffExtract -Recurse -Filter "ffprobe.exe" | Select-Object -First 1
      if ($foundFfmpeg -and $foundFfprobe) {
        Copy-Item -Path $foundFfmpeg.FullName -Destination $ffmpegBin -Force
        Copy-Item -Path $foundFfprobe.FullName -Destination $ffprobeBin -Force
        if ((Test-MediaBinaryWorks $ffmpegBin) -and (Test-MediaBinaryWorks $ffprobeBin)) {
          $installedOk = $true
          Write-Host "      -> Da cai va kiem tra FFmpeg & FFprobe thanh cong tai $RuntimeBin" -ForegroundColor Green
          if (Test-Path $ffmpegBak) { Remove-Item $ffmpegBak -Force -ErrorAction SilentlyContinue }
          if (Test-Path $ffprobeBak) { Remove-Item $ffprobeBak -Force -ErrorAction SilentlyContinue }
          break
        } else {
          Write-Warning "Binary tu $url khong vuot qua kiem tra thuc thi (-version). Thu nguon tiep theo..."
        }
      }
    } catch {
      Write-Warning "Loi khi tai/giai nen tu $($url) - $($_.Exception.Message)"
    }
  }

  if (-not $installedOk) {
    Write-Warning "Khong the cai dat binary FFmpeg chay duoc. Dang rollback ve ban sao luu (neu co)..."
    if (Test-Path $ffmpegBak) { Move-Item -Path $ffmpegBak -Destination $ffmpegBin -Force -ErrorAction SilentlyContinue }
    if (Test-Path $ffprobeBak) { Move-Item -Path $ffprobeBak -Destination $ffprobeBin -Force -ErrorAction SilentlyContinue }
  }

  if (Test-Path $ffZip) { Remove-Item $ffZip -Force -ErrorAction SilentlyContinue }
  if (Test-Path $ffExtract) { Remove-Item $ffExtract -Recurse -Force -ErrorAction SilentlyContinue }
} else {
  Write-Host "[3/6] FFmpeg & FFprobe da san sang va kiem tra chay tot." -ForegroundColor Green
}


# 4. Check or download Portable yt-dlp.exe (Win 2012 R2 uses 2024.10.22 Python 3.8 build; Win 10+ uses latest)
$ytDlpBin = Join-Path $RuntimeBin "yt-dlp.exe"
$sysYtDlpCmd = Get-Command yt-dlp -ErrorAction SilentlyContinue
$ytDlpWorks = $false
if (Test-Path $ytDlpBin) {
  $ytDlpWorks = Test-MediaBinaryWorks -ExePath $ytDlpBin -Arguments @("--version")
} elseif ($sysYtDlpCmd -and $sysYtDlpCmd.Source) {
  $ytDlpWorks = Test-MediaBinaryWorks -ExePath $sysYtDlpCmd.Source -Arguments @("--version")
}
if (-not $ytDlpWorks) {
  Write-Host "[4/6] Dang tai yt-dlp.exe Portable tuong thich he dieu hanh..." -ForegroundColor Yellow
  $ytUrl = if ($osVer.Major -lt 10) {
    "https://github.com/yt-dlp/yt-dlp/releases/download/2024.10.22/yt-dlp.exe"
  } else {
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
  }
  Download-FileFast -Url $ytUrl -Destination $ytDlpBin
  Write-Host "      -> Da cai yt-dlp.exe tai $ytDlpBin" -ForegroundColor Green
} else {
  Write-Host "[4/6] yt-dlp da san sang va kiem tra chay tot." -ForegroundColor Green
}

# 5. Seed config.json & .env.local safely without overwriting existing secrets
$configJson = Join-Path $RepoRoot "assets\config.json"
$configExample = Join-Path $RepoRoot "assets\config.example.json"
if ((-not (Test-Path $configJson)) -and (Test-Path $configExample)) {
  Copy-Item -Path $configExample -Destination $configJson -Force
  Write-Host "[INFO] Da khoi tao assets\config.json mac dinh." -ForegroundColor Cyan
}

$serverConfigJson = Join-Path $RepoRoot "assets\json-data\server-config.json"
if (-not (Test-Path $serverConfigJson)) {
  Set-Content -Path $serverConfigJson -Value ('{' + "`r`n" + '  "nameServer": "H H H BOT"' + "`r`n" + '}') -Encoding UTF8
}

$envLocal = Join-Path $RepoRoot ".env.local"
$envExample = Join-Path $RepoRoot ".env.example"
$credNote = Join-Path $RepoRoot ".runtime\dashboard-credentials.txt"

function New-RandomPassword {
  $chars = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  $bytes = New-Object byte[] 20
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $sb = New-Object System.Text.StringBuilder
  foreach ($b in $bytes) {
    [void]$sb.Append($chars[$b % $chars.Length])
  }
  return $sb.ToString()
}

if (-not (Test-Path $envLocal)) {
  $dashPass = New-RandomPassword
  if (Test-Path $envExample) {
    Copy-Item -Path $envExample -Destination $envLocal -Force
  } else {
    Set-Content -Path $envLocal -Value "# HHH_MYBOT Local Environment`r`n" -Encoding UTF8
  }
  Add-Content -Path $envLocal -Value "`r`nDASHBOARD_PORT=4173`r`nDASHBOARD_ADMIN_USERNAME=admin`r`nDASHBOARD_ADMIN_PASSWORD=$dashPass`r`nMYBOT_RESOURCE_PROFILE=lean`r`nLOG_CHAT_MESSAGES=false`r`n" -Encoding UTF8
  Set-Content -Path $credNote -Value "URL: http://localhost:4173`r`nUsername: admin`r`nPassword: $dashPass`r`n(Luu trong .env.local)" -Encoding UTF8
  Write-Host "[INFO] Da khoi tao .env.local va tai khoan Web Dashboard (xem .runtime\dashboard-credentials.txt)." -ForegroundColor Cyan
} else {
  $rawEnv = Get-Content -Path $envLocal -Raw
  $appendLines = @()
  if ($rawEnv -notmatch "(?m)^\s*DASHBOARD_ADMIN_USERNAME\s*=") {
    $appendLines += "DASHBOARD_ADMIN_USERNAME=admin"
  }
  if ($rawEnv -notmatch "(?m)^\s*DASHBOARD_ADMIN_PASSWORD\s*=") {
    $dashPass = New-RandomPassword
    $appendLines += "DASHBOARD_ADMIN_PASSWORD=$dashPass"
    Set-Content -Path $credNote -Value "URL: http://localhost:4173`r`nUsername: admin`r`nPassword: $dashPass`r`n(Luu trong .env.local)" -Encoding UTF8
  }
  if ($appendLines.Count -gt 0) {
    Add-Content -Path $envLocal -Value ("`r`n" + ($appendLines -join "`r`n") + "`r`n") -Encoding UTF8
    Write-Host "[INFO] Da bo sung thong tin dang nhap Dashboard con thieu vao .env.local." -ForegroundColor Cyan
  }
}

# 6. Install npm dependencies (with sandboxed npm cache inside .runtime\temp) & build Dashboard
$npmCmd = Join-Path $nodeBinFolder "npm.cmd"
if (-not (Test-Path $npmCmd)) {
  $sysNpm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($sysNpm) { $npmCmd = $sysNpm.Source } else { $npmCmd = "npm.cmd" }
}

$npmCacheDir = Join-Path $RuntimeTemp "npm-cache"
$env:npm_config_cache = $npmCacheDir

# Clean broken partial node_modules if a previous npm install failed midway
$nodeModulesDir = Join-Path $RepoRoot "node_modules"
$nodeModulesLock = Join-Path $nodeModulesDir ".package-lock.json"
if ((Test-Path $nodeModulesDir) -and (-not (Test-Path $nodeModulesLock))) {
  Write-Host "[INFO] Phat hien node_modules cai do dang tu lan truoc, dang don sach..." -ForegroundColor Yellow
  cmd.exe /c "if exist `"$nodeModulesDir`" rmdir /s /q `"$nodeModulesDir`"" | Out-Null
}

Write-Host "[5/6] Dang cai dat thu vien npm (production runtime)..." -ForegroundColor Yellow
try {
  & $npmCmd install --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    throw "npm install that bai voi ma loi $LASTEXITCODE"
  }

  # Sync portable Win2012-compatible yt-dlp.exe into youtube-dl-exec/bin
  if (Test-Path $ytDlpBin) {
    $ytExecBinDir = Join-Path $nodeModulesDir "youtube-dl-exec\bin"
    if (-not (Test-Path $ytExecBinDir)) {
      New-Item -ItemType Directory -Path $ytExecBinDir -Force | Out-Null
    }
    Copy-Item -Path $ytDlpBin -Destination (Join-Path $ytExecBinDir "yt-dlp.exe") -Force -ErrorAction SilentlyContinue
  }

  # Ensure node-canvas DLLs are compatible with Windows Server 2012 R2 (NT 6.x)
  if ($osVer.Major -lt 10) {
    & $nodeExe -e "import('./src/runtime/win2012-canvas-compat.js').then(m => m.ensureWin2012CanvasCompat({ projectRoot: process.cwd(), force: true }))"
    if ($LASTEXITCODE -ne 0) {
      throw "Cap nhat DLL canvas cho Windows Server 2012 R2 that bai."
    }
  }

  $dashDistIndex = Join-Path $RepoRoot "dashboard\dist\index.html"
  if (-not (Test-Path $dashDistIndex)) {
    Write-Host "[INFO] Dang bien dich Web Dashboard..." -ForegroundColor Yellow
    & $npmCmd --prefix (Join-Path $RepoRoot "dashboard") install --no-audit --no-fund
    & $npmCmd run dashboard:build
    if ($LASTEXITCODE -ne 0) {
      throw "npm run dashboard:build that bai voi ma loi $LASTEXITCODE"
    }
  } else {
    Write-Host "      -> Web Dashboard da san sang tai dashboard\dist." -ForegroundColor Green
  }
} finally {
  if (Test-Path $npmCacheDir) {
    Remove-Item -Path $npmCacheDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

if (-not $SkipDoctor) {
  Write-Host "[6/6] Dang kiem tra suc khoe he thong (doctor)..." -ForegroundColor Yellow
  & $nodeExe (Join-Path $RepoRoot "scripts\doctor.js")
  if ($LASTEXITCODE -ne 0) {
    throw "Kiem tra doctor phat hien loi cau hinh."
  }
}

Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "   CAI DAT HOAN TAT 100%! BAM run.bat DE KHOI DONG BOT NGAY!    " -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
if (Test-Path $credNote) {
  Write-Host "[DASHBOARD] Thong tin dang nhap Web Dashboard luu tai: .runtime\dashboard-credentials.txt" -ForegroundColor Cyan
}
