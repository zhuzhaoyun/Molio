$ErrorActionPreference = 'Stop'

$project = Split-Path -Parent $PSScriptRoot
Set-Location $project
$tsx = Join-Path $project 'node_modules/.bin/tsx.CMD'

& $tsx scripts/export-narration.ts

$rates = @{
  problem = '+10%'
  definition = '+0%'
  build = '+0%'
  comparison = '+15%'
  molio = '+0%'
  summary = '+20%'
}

foreach ($scene in $rates.Keys) {
  $text = Join-Path $project "public/audio/narration/$scene.txt"
  $media = Join-Path $project "public/audio/voiceover/$scene.mp3"
  edge-tts --voice zh-CN-YunxiNeural --rate $rates[$scene] --file $text --write-media $media
}

& $tsx scripts/generate-tones.ts
