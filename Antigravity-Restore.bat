@echo off
chcp 65001 > nul
title Antigravity 还原英文

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo.
    echo [错误] 未检测到 Node.js 运行环境，请先前往 https://nodejs.org 下载并安装 Node.js。
    goto :fail
)

node "%~dp0patch.js" --restore %*
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
