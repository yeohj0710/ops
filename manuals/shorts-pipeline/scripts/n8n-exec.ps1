# Run one n8n workflow headlessly, without the editor UI.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File n8n-exec.ps1 -Id mxrYb3maJS31gEYC
#
# Why this exists (260909). P2 normally clicks Execute workflow in the n8n editor, but that
# screen needs a signed-in session. This instance has an owner account, so any browser without
# the session cookie lands on the sign-in page. When the agent's Chrome extension is not
# connected, there is no signed-in browser at all and P2 would stall.
#
# This runs the same workflow through the n8n CLI with the env start-n8n.ps1 sets. Two ports
# must differ from the running server or the CLI refuses to start:
#   N8N_PORT              5678 -> 5688
#   N8N_RUNNERS_BROKER_PORT  5679 -> 5690
#
# The CLI exits when the workflow hits a Wait node (KIE polling) and prints status "waiting".
# That is NOT a failure. The running server picks the execution up at waitTill and finishes it.
# Watch the DB for success/error instead of trusting the CLI exit.
#
# ASCII only. Windows PowerShell 5 reads a BOM-less .ps1 as ANSI, so Korean paths are read
# from config\local-paths.json, never written as literals here.
param([Parameter(Mandatory=$true)][string]$Id)
$ErrorActionPreference = "Stop"
$Root = "C:\dev\n8n-youtube-shorts-automation"
$BinaryFolder = Join-Path $Root "binary-data"
$RenderFolder = Join-Path $Root "renders"
$DefaultFilesFolder = Join-Path $env:USERPROFILE ".n8n-files"
$LocalPaths = (Get-Content -LiteralPath (Join-Path $Root "config\local-paths.json") -Encoding UTF8 -Raw) | ConvertFrom-Json
$CardDropFolder = $LocalPaths.cardDropFolder
$FallbackFfmpeg = "C:\Users\hjyeo\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1-full_build\bin\ffmpeg.exe"
$FfmpegCommand = Get-Command ffmpeg -ErrorAction SilentlyContinue
if ($FfmpegCommand) { $Ffmpeg = $FfmpegCommand.Source } elseif (Test-Path -LiteralPath $FallbackFfmpeg) { $Ffmpeg = $FallbackFfmpeg } else { throw "ffmpeg not found" }

$env:N8N_USER_FOLDER = $Root
$env:N8N_HOST = "localhost"
$env:N8N_PORT = "5678"
$env:N8N_PROTOCOL = "http"
$env:WEBHOOK_URL = "http://localhost:5678/"
$env:N8N_DEFAULT_BINARY_DATA_MODE = "filesystem"
$env:N8N_BINARY_DATA_STORAGE_PATH = $BinaryFolder
$env:N8N_RESTRICT_FILE_ACCESS_TO = "$DefaultFilesFolder;$RenderFolder;$Root;$CardDropFolder"
$env:NODE_FUNCTION_ALLOW_BUILTIN = "crypto,child_process,fs,path"
$env:NODE_FUNCTION_ALLOW_EXTERNAL = ""
$env:FFMPEG_PATH = $Ffmpeg
$env:LOCAL_RENDER_DIR = $RenderFolder
$env:LOCAL_RENDER_SCRIPT = (Join-Path $Root "scripts\render-static-card.mjs")

$env:N8N_RUNNERS_BROKER_PORT = "5690"
$env:N8N_PORT = "5688"
Set-Location $Root
& "$Root\node_modules\.bin\n8n.cmd" execute --id $Id
exit $LASTEXITCODE
