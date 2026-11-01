@echo off
title Link Chrome Downloads to ComfyUI-Shared
set "TARGET_ROOT=E:\Comfy-Desktop\ComfyUI-Shared"

if not "%~1"=="" set "TARGET_ROOT=%~1"

for /f "usebackq tokens=*" %%D in (`powershell -NoProfile -Command "(New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path"`) do set "DOWNLOADS_DIR=%%D"

set "JUNCTION_PATH=%DOWNLOADS_DIR%\ComfyUI-Shared"

echo ========================================================
echo  Civitai to ComfyUI - Folder Link Setup
echo ========================================================
echo Chrome Downloads folder : "%DOWNLOADS_DIR%"
echo ComfyUI Target Root     : "%TARGET_ROOT%"
echo Link Location           : "%JUNCTION_PATH%"
echo.

if exist "%JUNCTION_PATH%" (
    echo [OK] Link "%JUNCTION_PATH%" already exists!
) else (
    mklink /J "%JUNCTION_PATH%" "%TARGET_ROOT%"
    if errorlevel 1 (
        echo [!] Could not create directory junction. Please check the target path.
    ) else (
        echo [SUCCESS] Linked "%JUNCTION_PATH%" -^> "%TARGET_ROOT%"!
        echo Now Chrome can save directly into "%TARGET_ROOT%\models\..."
        echo without changing your default Chrome Downloads folder.
    )
)
echo.
pause
