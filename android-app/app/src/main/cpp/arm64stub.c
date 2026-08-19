/*
 * libarm64stub.so - arm64 ABI 占位库
 *
 * 作用：让 APK 声明 primaryCpuAbi=arm64-v8a，使整个进程走 native
 * bridge 翻译层。jar 内 DexNative 从自身 assets 提取的 arm64
 * wexguard_v8.so 用 System.load 时才能被翻译层正确 dlopen。
 *
 * 本库不含业务逻辑，仅作为稳定的 ABI 占位符，不依赖从 spider jar
 * 提取的 wexguard_v8.so（后者会随 jar 更新而过时）。
 *
 * 已编译产物：app/src/main/jniLibs/arm64-v8a/libarm64stub.so
 * 重新编译命令（NDK 26）：
 *   aarch64-linux-android24-clang -shared -fPIC -o libarm64stub.so arm64stub.c
 */

int __attribute__((visibility("default"))) arm64stub_version(void) {
    return 1;
}