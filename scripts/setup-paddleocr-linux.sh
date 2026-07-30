#!/usr/bin/env bash

set -Eeuo pipefail
umask 022

readonly PADDLEPADDLE_VERSION="3.3.0"
readonly PADDLEOCR_VERSION="3.7.0"
readonly PILLOW_VERSION="11.3.0"
readonly PADDLE_CPU_INDEX="https://www.paddlepaddle.org.cn/packages/stable/cpu/"

fail() {
  printf 'PaddleOCR setup failed: %s\n' "$*" >&2
  exit 1
}

[[ "$(uname -s)" == "Linux" ]] || fail "this script only supports Linux"
[[ "$(uname -m)" == "x86_64" ]] || fail "PaddlePaddle CPU wheels require Linux x86_64 (found $(uname -m))"

readonly SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly PROJECT_ROOT="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd -P)"
readonly RUNTIME_ROOT="${PROJECT_ROOT}/.runtime"
readonly VENV="${RUNTIME_ROOT}/paddleocr"

if [[ -n "${PADDLEOCR_BOOTSTRAP_PYTHON:-}" ]]; then
  BOOTSTRAP_PYTHON="${PADDLEOCR_BOOTSTRAP_PYTHON}"
else
  BOOTSTRAP_PYTHON=""
  for candidate in python3.13 python3.12 python3.11 python3.10 python3.9 python3; do
    if command -v "${candidate}" >/dev/null 2>&1 && \
      "${candidate}" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 9) and sys.version_info[:2] <= (3, 13) else 1)' 2>/dev/null; then
      BOOTSTRAP_PYTHON="${candidate}"
      break
    fi
  done
fi
readonly BOOTSTRAP_PYTHON

[[ -n "${BOOTSTRAP_PYTHON}" ]] && command -v "${BOOTSTRAP_PYTHON}" >/dev/null 2>&1 || \
  fail "Python was not found; set PADDLEOCR_BOOTSTRAP_PYTHON to a Python 3.9-3.13 executable"

"${BOOTSTRAP_PYTHON}" - <<'PY' || fail "the bootstrap Python is not compatible"
import platform
import sys

version = sys.version_info
if version.major != 3 or not (9 <= version.minor <= 13):
    raise SystemExit(
        f"Python 3.9-3.13 is required; found {platform.python_version()}"
    )
if platform.architecture()[0] != "64bit":
    raise SystemExit("a 64-bit Python interpreter is required")
PY

if [[ -r /proc/cpuinfo ]] && ! grep -qiE '(^|[[:space:]])avx([[:space:]]|$)' /proc/cpuinfo; then
  fail "the CPU does not expose AVX support required by the official PaddlePaddle wheel"
fi

[[ ! -L "${RUNTIME_ROOT}" ]] || fail "refusing to use symlinked runtime directory: ${RUNTIME_ROOT}"
[[ ! -L "${VENV}" ]] || fail "refusing to use symlinked virtual environment: ${VENV}"
mkdir -p -- "${RUNTIME_ROOT}"

if [[ ! -x "${VENV}/bin/python" ]]; then
  if [[ -d "${VENV}" ]] && find "${VENV}" -mindepth 1 -print -quit | grep -q .; then
    fail "an incomplete non-empty runtime exists at ${VENV}; inspect or remove it before retrying"
  fi
  "${BOOTSTRAP_PYTHON}" -m venv "${VENV}" || \
    fail "could not create the virtual environment (install the OS python3-venv package if needed)"
fi

readonly VENV_PYTHON="${VENV}/bin/python"

"${VENV_PYTHON}" - <<'PY' || fail "the existing virtual environment uses an incompatible Python"
import platform
import sys

version = sys.version_info
if version.major != 3 or not (9 <= version.minor <= 13):
    raise SystemExit(
        f"Python 3.9-3.13 is required; found {platform.python_version()}"
    )
PY

if "${VENV_PYTHON}" -m pip show paddlepaddle-gpu >/dev/null 2>&1; then
  fail "the project runtime contains paddlepaddle-gpu; use a clean CPU runtime at ${VENV}"
fi

export PIP_DISABLE_PIP_VERSION_CHECK=1
export PIP_NO_CACHE_DIR=1
export PYTHONDONTWRITEBYTECODE=1

"${VENV_PYTHON}" -m pip install --upgrade 'pip>=24.3,<26'
"${VENV_PYTHON}" -m pip install --upgrade \
  --index-url "${PADDLE_CPU_INDEX}" \
  "paddlepaddle==${PADDLEPADDLE_VERSION}"
"${VENV_PYTHON}" -m pip install --upgrade \
  "paddleocr==${PADDLEOCR_VERSION}" \
  "Pillow==${PILLOW_VERSION}"

"${VENV_PYTHON}" "${PROJECT_ROOT}/tools/paddleocr/check_env.py"

printf 'PaddleOCR CPU runtime is ready: %s\n' "${VENV_PYTHON}"
