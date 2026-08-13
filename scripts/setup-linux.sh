#!/bin/bash

# TVBox Linux环境自动安装脚本
# 功能：自动安装Docker和redroid-headless容器

set -e  # 遇到错误立即退出

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 配置参数
DOCKER_IMAGE="redroid/redroid:11.0.0-latest"
CONTAINER_NAME="tvbox-redroid"
SPIDER_PORT=9978
LOG_FILE="$PWD/setup.log"

# 日志函数
log() {
    local level=$1
    local message=$2
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo -e "${timestamp} [${level}] ${message}" | tee -a "$LOG_FILE"
}

info() {
    log "INFO" "${BLUE}$1${NC}"
}

success() {
    log "SUCCESS" "${GREEN}$1${NC}"
}

warn() {
    log "WARN" "${YELLOW}$1${NC}"
}

error() {
    log "ERROR" "${RED}$1${NC}"
    exit 1
}

# 检查root权限
check_root() {
    if [ "$EUID" -ne 0 ]; then
        error "请使用sudo权限运行此脚本: sudo $0"
    fi
}

# 检测系统类型
detect_system() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS=$ID
        VER=$VERSION_ID
    else
        error "无法检测系统类型"
    fi
    info "检测到系统: $OS $VER"
}

# 安装Docker（使用国内镜像源）
install_docker() {
    info "检查Docker是否已安装..."
    
    if command -v docker &> /dev/null; then
        success "Docker已安装"
        docker --version
        return 0
    fi
    
    info "开始安装Docker..."
    
    case $OS in
        ubuntu|debian)
            # 更新apt包索引
            apt-get update
            
            # 安装依赖
            apt-get install -y \
                apt-transport-https \
                ca-certificates \
                curl \
                gnupg \
                lsb-release
            
            # 添加Docker的阿里云镜像源（国内加速）
            curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
            
            echo \
              "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://mirrors.aliyun.com/docker-ce/linux/ubuntu \
              $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
            
            # 安装Docker Engine
            apt-get update
            apt-get install -y docker-ce docker-ce-cli containerd.io
            ;;
        
        centos|rhel|fedora)
            # 安装依赖
            yum install -y yum-utils
            
            # 添加Docker的阿里云镜像源
            yum-config-manager \
                --add-repo \
                https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo
            
            # 安装Docker Engine
            yum install -y docker-ce docker-ce-cli containerd.io
            ;;
        
        *)
            error "不支持的系统: $OS"
            ;;
    esac
    
    # 启动Docker服务
    systemctl start docker
    systemctl enable docker
    
    # 验证安装
    if docker --version; then
        success "Docker安装成功"
    else
        error "Docker安装失败"
    fi
}

# 配置Docker镜像加速（国内）
configure_docker_mirror() {
    info "配置Docker镜像加速..."
    
    mkdir -p /etc/docker
    
    cat > /etc/docker/daemon.json <<EOF
{
  "registry-mirrors": [
    "https://docker.mirrors.sjtug.sjtu.edu.cn",
    "https://docker.m.daocloud.io",
    "https://docker.nju.edu.cn"
  ],
  "insecure-registries": [],
  "debug": false,
  "experimental": false,
  "live-restore": true,
  "storage-driver": "overlay2"
}
EOF
    
    # 重启Docker服务
    systemctl daemon-reload
    systemctl restart docker
    
    success "Docker镜像加速配置完成"
}

# 加载binder/ashmem内核模块
load_kernel_modules() {
    info "检查内核模块..."
    
    # 检查binder模块
    if lsmod | grep -q binder; then
        success "binder模块已加载"
    else
        info "加载binder模块..."
        modprobe binder_linux devices="binder,hwbinder,vndbinder" 2>/dev/null || {
            warn "无法加载binder模块，可能需要手动编译"
            warn "请参考: https://github.com/remote-android/redroid-doc"
        }
    fi
    
    # 检查ashmem模块
    if lsmod | grep -q ashmem; then
        success "ashmem模块已加载"
    else
        info "加载ashmem模块..."
        modprobe ashmem_linux 2>/dev/null || {
            warn "无法加载ashmem模块，可能需要手动编译"
        }
    fi
    
    # 持久化内核模块加载
    if [ ! -f /etc/modules-load.d/redroid.conf ]; then
        cat > /etc/modules-load.d/redroid.conf <<EOF
binder_linux
ashmem_linux
EOF
        info "已配置开机自动加载内核模块"
    fi
}

# 拉取redroid Docker镜像
pull_redroid_image() {
    info "拉取redroid-headless镜像..."
    
    docker pull $DOCKER_IMAGE
    
    if [ $? -eq 0 ]; then
        success "redroid镜像拉取成功"
    else
        error "redroid镜像拉取失败"
    fi
}

# 创建redroid容器
create_redroid_container() {
    info "检查redroid容器是否已存在..."
    
    if docker ps -a | grep -q $CONTAINER_NAME; then
        warn "容器已存在: $CONTAINER_NAME"
        read -p "是否删除现有容器并重新创建? (y/n): " confirm
        if [ "$confirm" = "y" ]; then
            docker rm -f $CONTAINER_NAME
            info "已删除现有容器"
        else
            info "保留现有容器"
            return 0
        fi
    fi
    
    info "创建redroid容器..."
    
    # 创建容器配置
    docker run -d \
        --name $CONTAINER_NAME \
        --privileged \
        --memory 4g \
        --cpus 2 \
        -p $SPIDER_PORT:$SPIDER_PORT \
        $DOCKER_IMAGE \
        /vendor/bin/init
    
    if [ $? -eq 0 ]; then
        success "redroid容器创建成功"
    else
        error "redroid容器创建失败"
    fi
}

# 等待容器启动
wait_for_container() {
    info "等待容器启动..."
    
    local max_attempts=30
    local attempt=0
    
    while [ $attempt -lt $max_attempts ]; do
        if docker exec $CONTAINER_NAME getprop init.svc.bootanim 2>/dev/null | grep -q "stopped"; then
            success "容器启动完成"
            return 0
        fi
        
        attempt=$((attempt + 1))
        info "等待启动... ($attempt/$max_attempts)"
        sleep 2
    done
    
    warn "容器启动超时，请手动检查"
}

# 安装Spider APK
install_spider_apk() {
    info "检查Spider APK..."
    
    APK_PATH="../docker/android-app/app/build/outputs/apk/debug/app-debug.apk"
    
    if [ ! -f "$APK_PATH" ]; then
        warn "Spider APK不存在，需要先构建"
        info "构建命令: cd docker/android-app && ./gradlew assembleDebug"
        return 1
    fi
    
    info "安装Spider APK到容器..."
    
    # 复制APK到容器
    docker cp "$APK_PATH" $CONTAINER_NAME:/data/local/tmp/
    
    # 安装APK
    docker exec $CONTAINER_NAME pm install -r /data/local/tmp/app-debug.apk
    
    if [ $? -eq 0 ]; then
        success "Spider APK安装成功"
        
        # 启动Spider服务
        docker exec $CONTAINER_NAME am startservice com.tvbox.spiderserver/.SpiderHttpService
        success "Spider服务已启动"
    else
        error "Spider APK安装失败"
    fi
}

# 验证安装
verify_installation() {
    info "验证安装..."
    
    # 检查Docker服务
    if systemctl is-active --quiet docker; then
        success "Docker服务运行正常"
    else
        error "Docker服务未运行"
    fi
    
    # 检查redroid容器
    if docker ps | grep -q $CONTAINER_NAME; then
        success "redroid容器运行正常"
    else
        error "redroid容器未运行"
    fi
    
    # 检查Spider API
    info "测试Spider API连接..."
    sleep 3
    
    if curl -s "http://localhost:$SPIDER_PORT/health" | grep -q "ok"; then
        success "Spider API连接正常"
    else
        warn "Spider API连接失败，服务可能还在启动中"
    fi
}

# 显示使用说明
show_usage() {
    echo ""
    echo "========== 安装成功 =========="
    echo ""
    success "安装完成！"
    echo ""
    info "容器名称: $CONTAINER_NAME"
    info "Spider API地址: http://localhost:$SPIDER_PORT"
    echo ""
    info "常用命令："
    echo "  启动容器: docker start $CONTAINER_NAME"
    echo "  停止容器: docker stop $CONTAINER_NAME"
    echo "  查看日志: docker logs $CONTAINER_NAME"
    echo "  进入容器: docker exec -it $CONTAINER_NAME sh"
    echo ""
    warn "如果Spider API无法连接，请手动安装Spider APK："
    echo "  1. 构建APK: cd docker/android-app && ./gradlew assembleDebug"
    echo "  2. 安装APK: docker cp app/build/outputs/apk/debug/app-debug.apk $CONTAINER_NAME:/data/local/tmp/"
    echo "  3. 安装应用: docker exec $CONTAINER_NAME pm install -r /data/local/tmp/app-debug.apk"
    echo "  4. 启动服务: docker exec $CONTAINER_NAME am startservice com.tvbox.spiderserver/.SpiderHttpService"
    echo ""
}

# 主函数
main() {
    echo ""
    echo "=========================================="
    echo "   TVBox Linux环境自动安装脚本"
    echo "=========================================="
    echo ""
    
    info "开始时间: $(date '+%Y-%m-%d %H:%M:%S')"
    
    # 检查root权限
    check_root
    
    # 检测系统类型
    detect_system
    
    # 安装Docker
    install_docker
    
    # 配置Docker镜像加速
    configure_docker_mirror
    
    # 加载内核模块
    load_kernel_modules
    
    # 拉取redroid镜像
    pull_redroid_image
    
    # 创建redroid容器
    create_redroid_container
    
    # 等待容器启动
    wait_for_container
    
    # 安装Spider APK（可选）
    # install_spider_apk
    
    # 验证安装
    verify_installation
    
    # 显示使用说明
    show_usage
    
    info "结束时间: $(date '+%Y-%m-%d %H:%M:%S')"
}

# 执行主函数
main