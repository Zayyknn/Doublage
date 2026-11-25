param([string]$dir)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
$lines = Get-Content "$dir\lines.txt" -Encoding UTF8
$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
foreach ($v in [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices) {
  $synth.Voice = $v; $name = $v.DisplayName.Split(' ')[-1]
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $out = "$dir\lines\$name-$('{0:D2}' -f $i).wav"; if (Test-Path $out) { continue }
    $stream = Await ($synth.SynthesizeTextToStreamAsync($lines[$i])) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
    $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
    $n = [uint32]$stream.Size; $null = Await ($reader.LoadAsync($n)) ([uint32])
    $buf = New-Object byte[] $n; $reader.ReadBytes($buf); [IO.File]::WriteAllBytes($out, $buf)
  }
}
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice("Microsoft Zira Desktop")
for ($i = 0; $i -lt $lines.Count; $i++) { $out = "$dir\lines\Zira-$('{0:D2}' -f $i).wav"; if (Test-Path $out) { continue }; $s.SetOutputToWaveFile($out); $s.Speak($lines[$i]) }
$s.Dispose()
(Get-ChildItem "$dir\lines").Count
