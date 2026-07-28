# WexWenCai AES Fallback 修复方案

**最后更新**: 2026-07-28
**状态**: 已解决

## 问题背景

WexWenCai（文才┃秒播源）使用 `LoadNiMa.decode()` 解密 API 响应。PC 版通过 unidbg 模拟 ARM native library 来执行解密，但 unidbg 的 `decrypt_core` 函数对该源的加密数据**返回输入不变**（即解密未实际执行），导致后续 API 调用缺少签名参数，返回 `JSONObject["data"] not found` 错误。

## 根因分析

### 1. unidbg 解密失败

LoadNiMaDecryptor 日志显示：
```
[LoadNiMaDecryptor] Calling decode() with input length: 64
[LoadNiMaDecryptor] Decoded successfully, length: 64
[LoadNiMaDecryptor] Output equals input - decryption not performed
```

native library 的 `decrypt_core` 函数对 WexWenCai 的输入直接返回原值，未执行解密操作。

### 2. API 加密机制

通过分析发现，WexWenCai 的 API 响应使用 **AES-128-CBC** 加密：
- **Key**: `YYYYMMDD` + `woshini8`（16 字节，基于日期）
- **IV**: `Wexfnwshinidieha`（16 字节，注意是大写 W）
- **输入**: base64 编码的密文
- **输出**: UTF-8 字符串（如 40 字符的 hex 签名）

解密成功后得到 40 字符的签名（SHA1 格式），用于后续 API 调用。

## 修复方案

在 `tools/stubs/com/wexfnw/libso/LoadNiMa.java` 中添加 AES fallback：

### 1. 新增 `tryWenCaiAESFallback` 方法

```java
private static String tryWenCaiAESFallback(String base64Input) {
    byte[] encrypted = Base64.getDecoder().decode(base64Input.trim());
    // 日期相关 key
    String dateStr = LocalDate.now().format(DateTimeFormatter.ofPattern("yyyyMMdd"));
    String keyStr = dateStr + "woshini8";
    byte[] ivBytes = "Wexfnwshinidieha".getBytes(StandardCharsets.UTF_8);
    // AES-128-CBC 解密
    Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
    cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(keyBytes, "AES"), new IvParameterSpec(ivBytes));
    byte[] decrypted = cipher.doFinal(encrypted);
    // 验证输出为可打印 ASCII
    return new String(decrypted, StandardCharsets.UTF_8).trim();
}
```

### 2. 修改 `decode` 方法，在 unidbg 失败时尝试 AES fallback

在两个场景下触发 fallback：
1. **unidbg 超时**（120 秒未响应）
2. **unidbg 返回输入不变**（`decodedResult.equals(s)`）

```java
boolean unidbgFailed = decodedResult == null
        || decodedResult.equals(s)
        || decodedResult.equals("{\"class\":[],\"list\":[]}")
        || decodedResult.isEmpty();
if (unidbgFailed) {
    String aesResult = tryWenCaiAESFallback(s);
    if (aesResult != null) return aesResult;
    return "{\"class\":[],\"list\":[]}";  // 兜底返回空 JSON
}
```

## 重要注意事项

### Stub JAR 更新

Electron 运行时加载的是 `tools/runtime/tvbox-spider-stubs-complete.jar`（不是 `tools/tvbox-spider-stubs-complete.jar`）。更新 stub 后必须同时更新两个 JAR：

```bash
node tools/rebuild_loadnima_stub.cjs
```

`rebuild_loadnima_stub.cjs` 已更新为同时更新三个 JAR：
- `tools/tvbox-spider-stubs.jar`（legacy）
- `tools/tvbox-spider-stubs-complete.jar`（dev fallback）
- `tools/runtime/tvbox-spider-stubs-complete.jar`（运行时实际加载）

### IV 大小写

IV 必须是 `Wexfnwshinidieha`（大写 W），小写 `w` 会导致解密失败。这是通过 unidbg breakpoint 跟踪到的。

### api_url 配置

WexWenCai 的 `api.txt` 解密后得到 `http://103.36.222.35:9595/`，但该地址返回 403。`JarLoader.ts` 中的 `fetchAndDecryptApiTxt` 已添加 URL 可用性验证，403 时回退到 `https://api.ww4f4jrg.com`。

## 验证结果

```
WexWenCai:
  classCount: 4 (电影、电视剧、综艺、动漫)
  listCount: 12
  homeResultLen: 1812
  categoryContent: 6546 bytes (有效数据)
```

配置 2 整体通过率从 72/87 提升到 75/87，无回归。
