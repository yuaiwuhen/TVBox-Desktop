@echo off
setlocal enabledelayedexpansion

echo ========================================
echo   Spider Android VM Installer
echo ========================================
echo.

REM 检查VirtualBox是否安装
echo [1/5] 检查VirtualBox...
where VBoxManage >nul 2>&1
if errorlevel 1 (
    echo VirtualBox未安装，正在启动安装...
    
    REM 下载VirtualBox
    echo 正在下载VirtualBox...
    powershell -Command "Invoke-WebRequest -Uri 'https://download.virtualbox.org/virtualbox/7.0.20/VirtualBox-7.0.20-166301-Win.exe' -OutFile '%TEMP%\VirtualBox.exe'"
    
    echo 正在安装VirtualBox...
    start /wait %TEMP%\VirtualBox.exe --silent --ignore-reboot
    
    echo VirtualBox安装完成
) else (
    echo VirtualBox已安装
)

REM 下载Android-x86 ISO
echo.
echo [2/5] 下载Android-x86系统镜像...
if not exist "android-x86.iso" (
    echo 正在下载Android-x86 9.0 (约900MB)...
    powershell -Command "Invoke-WebRequest -Uri 'https://osdn.net/projects/android-x86/storage/release/9.0/r2/android-x86_64-9.0-r2.iso' -OutFile 'android-x86.iso'"
    echo 下载完成
) else (
    echo Android-x86镜像已存在
)

REM 创建虚拟机
echo.
echo [3/5] 创建Android虚拟机...
VBoxManage createvm --name "Spider-Android" --register 2>nul
if errorlevel 1 (
    echo 虚拟机已存在，跳过创建
) else (
    echo 虚拟机创建成功
    
    REM 配置虚拟机
    VBoxManage modifyvm "Spider-Android" --memory 2048 --cpus 2 --vram 128
    VBoxManage modifyvm "Spider-Android" --acpi on --ioapic on
    VBoxManage modifyvm "Spider-Android" --nic1 nat
    VBoxManage modifyvm "Spider-Android" --natpf1 "adb,tcp,,5555,,5555"
    VBoxManage modifyvm "Spider-Android" --natpf1 "spider,tcp,,9978,,9978"
    
    REM 创建虚拟硬盘
    VBoxManage createhd --filename "Spider-Android.vdi" --size 8192
    VBoxManage storagectl "Spider-Android" --name "IDE Controller" --add ide
    VBoxManage storageattach "Spider-Android" --storagectl "IDE Controller" --port 0 --device 0 --type hdd --medium "Spider-Android.vdi"
    VBoxManage storageattach "Spider-Android" --storagectl "IDE Controller" --port 1 --device 0 --type dvddrive --medium "android-x86.iso"
    
    echo 虚拟机配置完成
)

REM 启动虚拟机
echo.
echo [4/5] 启动Android虚拟机...
VBoxManage startvm "Spider-Android" --type gui

echo.
echo [5/5] 后续步骤提示：
echo.
echo 1. 在虚拟机中选择 "Installation" 安装Android
echo 2. 创建分区并安装系统（选择ext4格式）
echo 3. 安装完成后重启虚拟机
echo 4. 在Android中安装Spider APK
echo 5. 配置ADB连接: adb connect localhost:5555
echo.
echo 虚拟机管理命令：
echo   启动: VBoxManage startvm "Spider-Android"
echo   停止: VBoxManage controlvm "Spider-Android" acpipowerbutton
echo   删除: VBoxManage unregistervm "Spider-Android" --delete
echo.

pause