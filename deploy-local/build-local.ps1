param([switch]$SkipFrontend)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeRoot = Join-Path $projectRoot 'runtime'
$frontendRoot = Join-Path $projectRoot 'sub2api/frontend'
$backendRoot = Join-Path $projectRoot 'sub2api/backend'
$kernelRoot = Join-Path $projectRoot 'vm2api/api-kernel'
$binaryPath = Join-Path $runtimeRoot 'bin/es2api.exe'
$kernelPath = Join-Path $runtimeRoot 'vm2/bin/kin-api-kernel'
$savedEnv = @{}
foreach ($name in @('GOOS', 'GOARCH', 'CGO_ENABLED', 'GOMAXPROCS')) {
  $savedEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
function Invoke-Checked([string]$File, [string[]]$Arguments) {
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$File failed with exit code $LASTEXITCODE" }
}
try {
  New-Item -ItemType Directory -Force -Path (Split-Path $binaryPath), (Split-Path $kernelPath) | Out-Null
  if (Test-Path -LiteralPath $binaryPath) {
    $running = Get-Process -Name es2api -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $binaryPath }
    if ($running) { throw 'Stop this local stack with node deploy-local/local.mjs stop before rebuilding its binary.' }
    Copy-Item -LiteralPath $binaryPath -Destination ($binaryPath + '.previous-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  }
  if (-not $SkipFrontend) {
    Push-Location $frontendRoot
    try {
      if (-not (Test-Path -LiteralPath 'node_modules/.bin/vite.cmd')) {
        Invoke-Checked 'npm.cmd' @('exec', '--yes', '--package=pnpm@10.34.8', '--', 'pnpm', 'install', '--frozen-lockfile')
      }
      Invoke-Checked 'npm.cmd' @('exec', '--yes', '--package=pnpm@10.34.8', '--', 'pnpm', 'run', 'build')
    } finally { Pop-Location }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $backendRoot 'internal/web/dist/index.html'))) {
    throw 'Embedded frontend is missing. Build again without -SkipFrontend.'
  }
  $env:GOMAXPROCS = '2'
  $env:CGO_ENABLED = '0'
  $env:GOOS = 'windows'
  $env:GOARCH = 'amd64'
  Push-Location $backendRoot
  try {
    Invoke-Checked 'go.exe' @('build', '-p', '2', '-tags', 'embed,timetzdata', '-trimpath', '-ldflags=-s -w -X main.BuildType=source', '-o', $binaryPath, './cmd/server')
  } finally { Pop-Location }
  $env:GOOS = 'linux'
  Push-Location $kernelRoot
  try {
    Invoke-Checked 'go.exe' @('build', '-p', '2', '-buildvcs=false', '-trimpath', '-ldflags=-s -w', '-o', $kernelPath, './cmd/kin-api-kernel')
  } finally { Pop-Location }
  Invoke-Checked 'node.exe' @((Join-Path $projectRoot 'vm2api/scripts/fetch-payload.mjs'), '--dest', (Join-Path $runtimeRoot 'vm2'))
  Copy-Item -LiteralPath (Join-Path $projectRoot 'vm2api/docker') -Destination (Join-Path $runtimeRoot 'vm2') -Recurse -Force
  foreach ($file in @($binaryPath, $kernelPath)) {
    $item = Get-Item -LiteralPath $file
    [PSCustomObject]@{ Path = $file; Bytes = $item.Length; SHA256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash } | ConvertTo-Json -Compress
  }
} finally {
  foreach ($name in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnv[$name], 'Process') }
}
