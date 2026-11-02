param(
    [ValidateSet('Init', 'Start', 'Stop', 'Status')]
    [string]$Action = 'Status'
)
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'local.mjs') $Action.ToLowerInvariant()
exit $LASTEXITCODE
