@echo off
chcp 65001 > nul
title Antigravity 还原英文

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo.
    echo [错误] 未检测到 Node.js 运行环境，请先前往 https://nodejs.org 下载并安装 Node.js。
    goto :fail
)

if exist "%~dp0patch.js" (
    node "%~dp0patch.js" --restore
) else if exist "%~dp0antigravity-cn\patch.js" (
    node "%~dp0antigravity-cn\patch.js" --restore
) else (
    echo.
    echo [错误] 未找到核心脚本 patch.js，请在汉化目录中运行还原脚本。
    goto :fail
)
if %errorlevel% neq 0 goto :fail

echo.
echo 请按任意键关闭窗口（10 秒后自动关闭）...
timeout /t 10 >nul 2>nul
exit /b 0

:fail
echo.
echo 请按任意键关闭窗口...
pause >nul
exit /b 1
