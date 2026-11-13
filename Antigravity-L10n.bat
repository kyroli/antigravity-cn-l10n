@echo off
chcp 65001 > nul
title Antigravity 安装汉化
setlocal

(
    where node >nul 2>nul
    if errorlevel 1 (
        echo.
        echo [错误] 未检测到 Node.js 运行环境，请先前往 https://nodejs.org 下载并安装 Node.js。
        echo.
        echo 请按任意键关闭窗口...
        pause >nul
        exit /b 1
    )

    if exist "%~dp0patch.js" (
        node "%~dp0patch.js" %*
    ) else (
        if not exist "%~dp0antigravity-cn\src\updater.js" (
            echo [初始化] 未检测到本地核心文件，正在从 GitHub 下载更新器到 antigravity-cn 目录...
            if not exist "%~dp0antigravity-cn\src" mkdir "%~dp0antigravity-cn\src"
            set "AG_UPDATER_OUT=%~dp0antigravity-cn\src\updater.js"
            powershell.exe -NoProfile -NonInteractive -Command "try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $wc=New-Object System.Net.WebClient; $wc.Headers.Add('User-Agent','antigravity-cn-l10n'); $ref='main'; try { $s=$wc.DownloadString('https://github.com/kyroli/antigravity-cn-l10n.git/info/refs?service=git-upload-pack'); if($s -match '([0-9a-f]{40}) refs/heads/main(?=\r|\n|\0|$)'){ $ref=$matches[1] } } catch {}; $tmp=$env:AG_UPDATER_OUT+'.tmp'; $wc.DownloadFile('https://raw.githubusercontent.com/kyroli/antigravity-cn-l10n/'+$ref+'/src/updater.js',$tmp); Move-Item -Force $tmp $env:AG_UPDATER_OUT } catch { Write-Host $_.Exception.Message; exit 1 }"
            if errorlevel 1 (
                rmdir "%~dp0antigravity-cn\src" >nul 2>nul
                rmdir "%~dp0antigravity-cn" >nul 2>nul
                echo [错误] 无法从 GitHub 下载核心脚本，请检查网络或代理设置后重试。
                echo.
                echo 请按任意键关闭窗口...
                pause >nul
                exit /b 1
            )
        )

        if not exist "%~dp0antigravity-cn\patch.js" (
            node "%~dp0antigravity-cn\src\updater.js" --bootstrap
            if errorlevel 1 (
                echo.
                echo 请按任意键关闭窗口...
                pause >nul
                exit /b 1
            )
            node "%~dp0antigravity-cn\patch.js" --no-update %*
        ) else (
            node "%~dp0antigravity-cn\patch.js" %*
        )
    )
    if errorlevel 1 (
        echo.
        echo 请按任意键关闭窗口...
        pause >nul
        exit /b 1
    )

    echo.
    echo 请按任意键关闭窗口（10 秒后自动关闭）...
    timeout /t 10 >nul 2>nul
    exit /b 0
)
