param([Parameter(Mandatory=$true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'daily.mjs'
try {
  $jobProcess = Start-Process -FilePath $NodePath -ArgumentList @(('"' + $scriptPath + '"'), '--scheduled') -WorkingDirectory (Split-Path $PSScriptRoot -Parent) -WindowStyle Hidden -PassThru -Wait
  exit $jobProcess.ExitCode
} catch { Write-Error $_; exit 1 }
