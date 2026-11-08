# Windows PowerShell version of run.sh
param([Parameter(Mandatory = $true)][string]$Footage, [string]$Music)
$ErrorActionPreference = 'Stop'
$tmep = Join-Path $PSScriptRoot '..\..\bin\tmep.js'
function T { node $tmep -p .\my-reel @args; if ($LASTEXITCODE -ne 0) { throw "tmep $args failed" } }

T init
if ($Music) { T import $Footage $Music } else { T import $Footage }
T transcribe v1 --lang auto
if ($Music) { T plan --template reel --target 30 --title "Your hook here" --music a1 }
else { T plan --template reel --target 30 --title "Your hook here" }
T render --preview --frames 6
T edit "delete fillers=true" "captions kinetic"
T render --quality standard
