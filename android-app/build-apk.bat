@echo off
setlocal enabledelayedexpansion

echo ========================================
echo   Building Spider HTTP Service APK
echo ========================================
echo.

REM Set Android SDK path
set ANDROID_HOME=C:\Users\%USERNAME%\AppData\Local\Android\Sdk
set ANDROID_SDK_ROOT=%ANDROID_HOME%

echo [1/4] Checking Android SDK...
if not exist "%ANDROID_HOME%" (
    echo ERROR: Android SDK not found
    echo Path: %ANDROID_HOME%
    exit /b 1
)
echo OK: Android SDK found at %ANDROID_HOME%

echo.
echo [2/4] Checking Java...
java -version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Java not installed or not in PATH
    echo Please install JDK 17 or higher
    exit /b 1
)
echo OK: Java is installed

cd /d "%~dp0"

REM Download Gradle Wrapper if not exists
if not exist "gradle\wrapper\gradle-wrapper.jar" (
    echo.
    echo [3/4] Downloading Gradle Wrapper...
    if not exist "gradle\wrapper" mkdir gradle\wrapper
    
    powershell -Command "Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/gradle/gradle/v8.9.0/gradle/wrapper/gradle-wrapper.jar' -OutFile 'gradle\wrapper\gradle-wrapper.jar'"
    
    if not exist "gradle\wrapper\gradle-wrapper.jar" (
        echo ERROR: Failed to download gradle-wrapper.jar
        exit /b 1
    )
    echo OK: Gradle Wrapper downloaded
) else (
    echo OK: Gradle Wrapper exists
)

echo.
echo [4/4] Building APK...
call gradlew.bat assembleDebug

if errorlevel 1 (
    echo.
    echo ERROR: Build failed
    exit /b 1
)

echo.
echo ========================================
echo   Build Successful!
echo ========================================
echo.
echo APK location: build\outputs\apk\debug\app-debug.apk
echo.

endlocal