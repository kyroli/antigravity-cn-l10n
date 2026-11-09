@echo off
chcp 65001 > nul
title Antigravity 安装汉化

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo.
    echo [错误] 未检测到 Node.js 运行环境，请先前往 https://nodejs.org 下载并安装 Node.js。
    echo.
    echo 请按任意键关闭窗口...
    pause >nul
    exit /b 1
)

node "%~dp0patch.js" %*
if %errorlevel% neq 0 (
    echo.
    echo 请按任意键关闭窗口...
    pause >nul
    exit /b 1
)

echo.
echo 请按任意键关闭窗口...
pause >nul
