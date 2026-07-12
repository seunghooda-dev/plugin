param(
  [Parameter(Mandatory = $false)]
  [string]$InputPath = "",

  [Parameter(Mandatory = $false)]
  [ValidateSet("tiny", "base", "small", "medium", "turbo")]
  [string]$Model = "base",

  [Parameter(Mandatory = $false)]
  [ValidateSet("cpu", "cuda")]
  [string]$Device = "cpu"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$projectRoot = Split-Path -Parent $PSScriptRoot
$evidenceRoot = Join-Path $projectRoot "local-whisper-evidence"
$whisperRoot = Join-Path $env:LOCALAPPDATA "ShortFlowStudio\whisper"
$python = Join-Path $whisperRoot ".venv\Scripts\python.exe"
$modelRoot = Join-Path $whisperRoot "models"
$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$runRoot = Join-Path $evidenceRoot $stamp
$isGeneratedInput = [string]::IsNullOrWhiteSpace($InputPath)

function Write-Evidence {
  param(
    [Parameter(Mandatory = $true)][string]$Status,
    [Parameter(Mandatory = $false)][string]$Transcript = "",
    [Parameter(Mandatory = $false)][string]$ErrorMessage = "",
    [Parameter(Mandatory = $false)][int]$SegmentCount = 0,
    [Parameter(Mandatory = $false)][int]$WordCount = 0,
    [Parameter(Mandatory = $false)][int]$ExpectedMatchCount = -1,
    [Parameter(Mandatory = $false)][string]$SourceName = "n/a"
  )

  New-Item -ItemType Directory -Force -Path $runRoot | Out-Null
  $safeTranscript = ($Transcript -replace "[\r\n]+", " " -replace "\s{2,}", " ").Trim()
  if ($safeTranscript.Length -gt 500) { $safeTranscript = $safeTranscript.Substring(0, 500) }
  $safeError = ($ErrorMessage -replace "[\r\n]+", " " -replace "\s{2,}", " ").Trim()
  if ($safeError.Length -gt 500) { $safeError = $safeError.Substring(0, 500) }
  $expectedMatchLabel = if ($ExpectedMatchCount -ge 0) { "$ExpectedMatchCount/4" } else { "n/a" }

  $lines = @(
    "# ShortFlow Local Whisper Evidence",
    "",
    "- mode: local-offline-stt",
    "- generatedAt: $((Get-Date).ToUniversalTime().ToString('o'))",
    "- status: $Status",
    "- model: $Model",
    "- device: $Device",
    "- sourceName: $SourceName",
    "- segmentCount: $SegmentCount",
    "- wordCount: $WordCount",
    "- expectedKeywordMatches: $expectedMatchLabel",
    "- transcript: $(if ($safeTranscript) { $safeTranscript } else { 'n/a' })",
    "- error: $(if ($safeError) { $safeError } else { 'n/a' })",
    "",
    "Notes:",
    "",
    "- This smoke test does not use an OpenAI API key or a network STT call.",
    "- Raw audio bytes are not embedded in this Markdown evidence.",
    "- The local-whisper-evidence directory is excluded from Git."
  )
  $evidencePath = Join-Path $runRoot "ShortFlow_Local_Whisper_Evidence_$stamp.md"
  $lines | Set-Content -Path $evidencePath -Encoding UTF8
  return $evidencePath
}

function Test-FiniteNumber {
  param([Parameter(Mandatory = $false)]$Value)

  if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { return $false }
  try {
    $number = [System.Convert]::ToDouble($Value, [System.Globalization.CultureInfo]::InvariantCulture)
    return (-not [double]::IsNaN($number)) -and (-not [double]::IsInfinity($number))
  }
  catch {
    return $false
  }
}

function Test-ContainsHangul {
  param([Parameter(Mandatory = $false)][string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
  $hangulPattern = "[$([char]0xAC00)-$([char]0xD7A3)]"
  return [regex]::IsMatch($Value, $hangulPattern)
}

try {
  if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "Local Whisper Python environment is missing: $python"
  }

  New-Item -ItemType Directory -Force -Path $runRoot,$modelRoot | Out-Null

  $source = $InputPath
  if ($isGeneratedInput) {
    Add-Type -AssemblyName System.Speech
    $source = Join-Path $runRoot "shortflow-local-whisper.wav"
    $synthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try {
      $koreanVoice = $synthesizer.GetInstalledVoices() |
        Where-Object { $_.VoiceInfo.Culture.Name -eq "ko-KR" } |
        Select-Object -First 1
      if (-not $koreanVoice) { throw "A Windows ko-KR speech voice is not installed." }
      $synthesizer.SelectVoice($koreanVoice.VoiceInfo.Name)
      $synthesizer.SetOutputToWaveFile($source)
      $speechBase64 = "7IiP7ZSM66Gc7JqwIOyKpO2KnOuUlOyYpCDroZzsu6wg7J6Q66eJIOqygOymneyeheuLiOuLpC4g7ZSE66as66+47Ja0IOyekOuPmSDtjrjsp5HsnYQg7YWM7Iqk7Yq47ZWp64uI64ukLg=="
      $speechText = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($speechBase64))
      $synthesizer.Speak($speechText)
    }
    finally {
      $synthesizer.Dispose()
    }
  }

  $source = (Resolve-Path -LiteralPath $source).Path
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "Whisper input file was not found."
  }

  & $python -m whisper $source `
    --model $Model `
    --model_dir $modelRoot `
    --language ko `
    --task transcribe `
    --device $Device `
    --output_dir $runRoot `
    --output_format all `
    --word_timestamps True `
    --verbose False

  if ($LASTEXITCODE -ne 0) { throw "Whisper exited with code $LASTEXITCODE."
  }

  $baseName = [System.IO.Path]::GetFileNameWithoutExtension($source)
  $txtPath = Join-Path $runRoot "$baseName.txt"
  $srtPath = Join-Path $runRoot "$baseName.srt"
  $jsonPath = Join-Path $runRoot "$baseName.json"

  foreach ($required in @($txtPath, $srtPath, $jsonPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
      throw "A Whisper output file is missing: $([System.IO.Path]::GetFileName($required))"
    }
  }

  $normalizeJsonCode = "import json,pathlib,sys;p=pathlib.Path(sys.argv[1]);data=json.loads(p.read_text(encoding='utf-8'));p.write_text(json.dumps(data,ensure_ascii=False,separators=(',',':')),encoding='utf-8')"
  & $python -c $normalizeJsonCode $jsonPath
  if ($LASTEXITCODE -ne 0) { throw "Whisper JSON UTF-8 normalization failed with code $LASTEXITCODE." }

  $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  foreach ($utf8Output in @($txtPath, $srtPath, $jsonPath)) {
    $utf8Text = [System.IO.File]::ReadAllText($utf8Output, $strictUtf8)
    if ($utf8Text.Contains([char]0xFFFD)) {
      throw "A Whisper output contains a Unicode replacement character."
    }
    [System.IO.File]::WriteAllText($utf8Output, $utf8Text, $utf8NoBom)
  }

  $transcript = ([System.IO.File]::ReadAllText($txtPath, $strictUtf8)).Trim()
  $srt = [System.IO.File]::ReadAllText($srtPath, $strictUtf8)
  $jsonText = [System.IO.File]::ReadAllText($jsonPath, $strictUtf8)
  $json = $jsonText | ConvertFrom-Json
  $segments = @($json.segments | Where-Object { $null -ne $_ })

  if (-not $transcript) { throw "Whisper transcript is empty." }
  if (-not (Test-ContainsHangul $transcript)) { throw "Whisper transcript does not contain valid Hangul text." }
  if (-not (Test-ContainsHangul $srt)) { throw "Whisper SRT does not contain valid Hangul text." }
  if (-not (Test-ContainsHangul $jsonText)) { throw "Whisper JSON does not contain valid Hangul text." }
  if ($srt -notmatch "\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}") {
    throw "Whisper SRT timestamps are missing."
  }
  if ($segments.Count -lt 1) { throw "Whisper segment timestamps are missing." }

  $timedSegments = @()
  $wordCount = 0
  $epsilon = 0.001
  foreach ($segment in $segments) {
    if (-not (Test-FiniteNumber $segment.start) -or -not (Test-FiniteNumber $segment.end)) {
      throw "A Whisper segment has a missing or non-finite timestamp."
    }
    $segmentStart = [double]$segment.start
    $segmentEnd = [double]$segment.end
    if ($segmentStart -lt 0 -or $segmentEnd -le $segmentStart) {
      throw "A Whisper segment has an invalid timestamp range."
    }
    if ([string]::IsNullOrWhiteSpace([string]$segment.text) -or ([string]$segment.text).Contains([char]0xFFFD)) {
      throw "A Whisper segment has invalid text."
    }
    $timedSegments += $segment

    $segmentWords = @($segment.words | Where-Object { $null -ne $_ })
    foreach ($word in $segmentWords) {
      if (-not (Test-FiniteNumber $word.start) -or -not (Test-FiniteNumber $word.end)) {
        throw "A Whisper word has a missing or non-finite timestamp."
      }
      $wordStart = [double]$word.start
      $wordEnd = [double]$word.end
      if ($wordStart -lt 0 -or $wordEnd -le $wordStart) {
        throw "A Whisper word has an invalid timestamp range."
      }
      if ($wordStart -lt ($segmentStart - $epsilon) -or $wordEnd -gt ($segmentEnd + $epsilon)) {
        throw "A Whisper word timestamp falls outside its segment range."
      }
      if ([string]::IsNullOrWhiteSpace([string]$word.word) -or ([string]$word.word).Contains([char]0xFFFD)) {
        throw "A Whisper word has invalid text."
      }
      $wordCount++
    }
  }
  if ($wordCount -lt 1) { throw "Whisper word timestamps are missing." }

  $expectedMatchCount = -1
  if ($isGeneratedInput) {
    $expectedKeywordBase64 = @(
      "7ZSE66as66+47Ja0",
      "7YWM7Iqk7Yq4",
      "7J6Q66eJ",
      "7Y647KeR"
    )
    $expectedKeywords = @($expectedKeywordBase64 | ForEach-Object {
      [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($_))
    })
    $expectedMatchCount = @($expectedKeywords | Where-Object { $transcript.Contains($_) }).Count
    if ($expectedMatchCount -lt 2) {
      throw "Generated-speech transcript matched only $expectedMatchCount of 4 expected keywords."
    }
  }

  $evidencePath = Write-Evidence `
    -Status "pass" `
    -Transcript $transcript `
    -SegmentCount $timedSegments.Count `
    -WordCount $wordCount `
    -ExpectedMatchCount $expectedMatchCount `
    -SourceName ([System.IO.Path]::GetFileName($source))

  Write-Host "PASS: local Whisper STT smoke test"
  Write-Host "  model: $Model / device: $Device"
  Write-Host "  segments: $($timedSegments.Count) / words: $wordCount"
  Write-Host "  expected keyword matches: $(if ($expectedMatchCount -ge 0) { "$expectedMatchCount/4" } else { "n/a (external input)" })"
  Write-Host "  SRT: $srtPath"
  Write-Host "  JSON: $jsonPath"
  Write-Host "  evidence: $evidencePath"
}
catch {
  $message = $_.Exception.Message
  $evidencePath = Write-Evidence -Status "fail" -ErrorMessage $message -SourceName $(
    if ($InputPath) { [System.IO.Path]::GetFileName($InputPath) } else { "generated-ko-KR.wav" }
  )
  Write-Error "Local Whisper STT smoke test failed. Evidence: $evidencePath. $message"
  exit 1
}
