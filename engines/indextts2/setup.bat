@echo off
REM ============================================================
REM  setup_indextts_env.bat
REM  Build a fully self-contained, project-embedded micromamba
REM  environment for IndexTTS2, isolated from the SoVITS venv.
REM
REM  PREREQ: vendor\micromamba\micromamba.exe must already exist.
REM          (see the curl/tar download steps in chat)
REM
REM  Everything lives INSIDE the project:
REM    vendor\micromamba\micromamba.exe   <- the binary
REM    vendor\micromamba\root\            <- MAMBA_ROOT_PREFIX (envs live here)
REM    vendor\micromamba\root\envs\indextts
REM
REM  Nothing is written to your user profile or system.
REM ============================================================
setlocal enabledelayedexpansion

REM ---- config (edit if needed) -------------------------------
set "PROJ=%~dp0"
set "MM=%PROJ%vendor\micromamba\micromamba.exe"
set "MAMBA_ROOT_PREFIX=%PROJ%vendor\micromamba\root"
set "ENVNAME=indextts"
set "PYVER=3.11"
set "IDXREPO=D:\AI\index-tts"

REM torch build (already verified working for IndexTTS2)
REM IndexTTS2 official baseline: torch 2.8.* on CUDA 12.8.
REM (pip does NOT read pyproject's [tool.uv.sources], so we install the
REM  CUDA build explicitly from the cu128 index BEFORE installing the repo.)
REM NOTE: torchvision is NOT installed on purpose -- IndexTTS2's official
REM [project] dependencies declare only torch + torchaudio (torchvision
REM appears solely as a uv index route, not a real dependency). Skipping it
REM saves a few hundred MB.
set "TORCH_INDEX=https://download.pytorch.org/whl/cu128"
set "TORCH_PKGS=torch==2.8.* torchaudio==2.8.*"

REM China mirrors (comment out if not needed)
set "CONDA_CH=https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge"
set "PIP_MIRROR=https://pypi.tuna.tsinghua.edu.cn/simple"
REM ------------------------------------------------------------

if not exist "%MM%" (
  echo [ERR] micromamba.exe not found at:
  echo       %MM%
  echo Download it first, then re-run this script.
  exit /b 1
)
if not exist "%IDXREPO%\pyproject.toml" (
  echo [ERR] IndexTTS2 pyproject.toml not found at:
  echo       %IDXREPO%\pyproject.toml
  echo Fix IDXREPO at the top of this script.
  exit /b 1
)

echo.
echo === [1/6] create env "%ENVNAME%" (python %PYVER%) ===
"%MM%" create -y -r "%MAMBA_ROOT_PREFIX%" -n %ENVNAME% -c "%CONDA_CH%" -c conda-forge python=%PYVER%
if errorlevel 1 goto :fail

echo.
echo === [2/6] upgrade pip ===
"%MM%" run -r "%MAMBA_ROOT_PREFIX%" -n %ENVNAME% python -m pip install --no-cache-dir --upgrade pip -i %PIP_MIRROR%
if errorlevel 1 goto :fail

echo.
echo === [3/6] install torch %TORCH_PKGS% (cu128) FIRST so the repo install won't pull CPU torch ===
"%MM%" run -r "%MAMBA_ROOT_PREFIX%" -n %ENVNAME% python -m pip install --no-cache-dir %TORCH_PKGS% --index-url %TORCH_INDEX%
if errorlevel 1 goto :fail

echo.
echo === [4/6] install IndexTTS2 from its pyproject (official dependency baseline, full resolution) ===
"%MM%" run -r "%MAMBA_ROOT_PREFIX%" -n %ENVNAME% python -m pip install --no-cache-dir "%IDXREPO%" -i %PIP_MIRROR%
if errorlevel 1 goto :fail

echo.
echo === [5/6] verify ===
"%MM%" run -r "%MAMBA_ROOT_PREFIX%" -n %ENVNAME% python -c "import torch,transformers;print('OK  torch',torch.__version__,'| cuda',torch.cuda.is_available(),'| transformers',transformers.__version__)"
if errorlevel 1 goto :fail

echo.
echo === [6/6] reclaim disk: purge conda + pip download caches ===
"%MM%" run -r "%MAMBA_ROOT_PREFIX%" -n %ENVNAME% python -m pip cache purge
"%MM%" clean --all --yes

echo.
echo ============================================================
echo  DONE. IndexTTS2 env ready at:
echo    %MAMBA_ROOT_PREFIX%\envs\%ENVNAME%
echo.
echo  Run anything inside it with:
echo    "%MM%" run -r "%MAMBA_ROOT_PREFIX%" -n %ENVNAME% python your_script.py
echo ============================================================
exit /b 0

:fail
echo.
echo [FAILED] step above returned an error. Scroll up for the real message.
exit /b 1
