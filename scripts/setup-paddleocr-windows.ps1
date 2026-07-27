$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Python = if ($env:PADDLEOCR_BOOTSTRAP_PYTHON) { $env:PADDLEOCR_BOOTSTRAP_PYTHON } else { 'python' }
$Venv = Join-Path $ProjectRoot '.runtime\paddleocr'

if (-not (Test-Path (Join-Path $Venv 'Scripts\python.exe'))) {
  & $Python -m venv $Venv
}

$VenvPython = Join-Path $Venv 'Scripts\python.exe'
& $VenvPython -m pip install --upgrade pip

try {
  & $VenvPython -m pip install paddlepaddle-gpu -i https://www.paddlepaddle.org.cn/packages/stable/cu126/
} catch {
  Write-Warning 'GPU Paddle installation failed; installing CPU package instead.'
  & $VenvPython -m pip install paddlepaddle
}

& $VenvPython -m pip install paddleocr pillow
& $VenvPython (Join-Path $ProjectRoot 'tools\paddleocr\check_env.py')
