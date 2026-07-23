# WexGuaZi 解密流程完整解决方案

**最后更新**: 2026-07-21
**状态**: 已解决

## 问题背景

WexGuaZiGuard（瓜子秒播源）使用复杂的加密流程来获取视频 URL。PC 版本需要通过 unidbg 模拟 ARM native library 才能解密。

## 完整解密流程

### 1. API 请求获取加密数据

```
POST https://api.jianfacb.com/App/Resource/VurlDetail/showOne
Headers:
  - Ver: 1.9.3.11
  - code: GZ0369
  - PackageName: com.adf6c13c1f.udb8474b6a.qf98ac7d2120250120
  - User-Agent: okhttp/3.12.0
  - Referer: https://api.ww4f4jrg.com
  - version: 2412021
  - Content-Type: application/x-www-form-urlencoded

Response:
{
  "data": {
    "response_key": "<hex_string>",  // 加密的视频 URL
    "keys": "<base64_string>"        // 用于解密的密钥参数
  }
}
```

### 2. 下载并解密 api.txt

```python
URL: http://upload.baicanuc.cn/ossfiles/1768320816/api.txt

# Step 1: Base64 解码
api_txt_encrypted = base64.b64decode(api_txt_raw)

# Step 2: AES/CBC/PKCS5Padding 解密
KEY = b"nifanbianyikeyia"  # 16 bytes
IV = b"keyijiangjiudian"   # 16 bytes
cipher = AES.new(KEY, AES.MODE_CBC, IV)
api_txt_decrypted = unpad(cipher.decrypt(api_txt_encrypted))

# 结果: caonidie.php 的 base URL
# 例如: https://api.ww4f4jrg.com
```

### 3. 调用 caonidie.php 获取解密参数

```python
# Step 1: 将 keys (base64) 的每个字符转换为 hex
hex_encoded_keys = "".join(f"{ord(c):02X}" for c in keys_base64)

# Step 2: 拼接完整 URL
caonidie_url = f"{base_url}/wexfnwshinidie/kuihua/caonidie.php?data={hex_encoded_keys}"

# Step 3: GET 请求（UA 必须是 Lavf/57.83.100）
headers = {"User-Agent": "Lavf/57.83.100"}
response = requests.get(caonidie_url, headers=headers)

# 响应是 Base64 编码的加密数据
```

### 4. LoadNiMa.decode() 解密 caonidie 响应

```java
// 在 JAR 内部调用
String decrypted = LoadNiMa.decode(context, caonidie_response);

// 结果: JSON 格式的解密参数
{
  "key": "...",  // AES key (16 bytes, UTF-8)
  "iv": "..."    // AES IV (16 bytes, UTF-8)
}
```

**unidbg 实现**：

```java
// LoadNiMaDecryptor.java
public class LoadNiMaDecryptor extends AbstractJni {
    // 1. Patch env_check (0x915b4) to bypass signature verification
    private void patchEnvCheck(Module module) {
        long envCheckAddr = module.base + 0x915b4L;
        byte[] patch = {0x20, 0x00, (byte)0x80, 0x52, (byte)0xC0, 0x03, 0x5F, (byte)0xD6};
        emulator.getBackend().mem_write(envCheckAddr, patch);
    }

    // 2. Hook string creation (0x9804c) to extract decrypted data
    private void hookStringCreation(Module module) {
        // 从 sp+8 读取解密后的 std::string
        // 创建 StringObject 并返回
    }
}
```

### 5. 解密 response_key 获取视频 URL

```python
# Step 1: Hex 解码 response_key
response_key_bytes = bytes.fromhex(response_key)

# Step 2: AES/CBC/PKCS5Padding 解密
cipher = AES.new(key.encode('utf-8'), AES.MODE_CBC, iv.encode('utf-8'))
decrypted = unpad(cipher.decrypt(response_key_bytes))

# 结果: 视频 URL JSON
{
  "url": "https://...",
  "parse": 0
}
```

## 关键配置

### 1. Native Library 路径

```typescript
// JarLoader.ts
const nativeLibPath = InitOrigin.init() 下载的位置
// 或从 JAR 中提取: jar_cache/<className>/libLoadNiMa.so
```

### 2. Unidbg Loader JAR

```
tools/unidbg-loader/target/unidbg-loader-1.0.0.jar
```

### 3. 必需的 Android Stubs

```
tools/stubs/tvbox-spider-stubs-complete.jar
包含:
- android.content.Context
- android.os.Environment
- android.content.pm.PackageManager
- com.github.catvod.crawler.Spider
- org.json.JSONObject
- android.util.Base64
```

## 常见问题

### Q1: LoadNiMa.decode() 返回 Base64 字符串而不是 JSON

**原因**: unidbg 环境检查失败（签名验证）

**解决**: Patch env_check (0x915b4) 让它总是返回 1

```java
// 地址: 0x915b4
// 原始: env_check() - 验证应用签名
// 补丁: mov w0, #1; ret - 总是返回成功
```

### Q2: caonidie.php 返回空或错误

**原因**: User-Agent 不正确

**解决**: 必须使用 `Lavf/57.83.100`

### Q3: api.txt 解密失败

**原因**: AES key/iv 不正确或数据格式错误

**解决**:
- Key: `nifanbianyikeyia` (16 bytes)
- IV: `keyijiangjiudian` (16 bytes)
- 需要先 Base64 解码再 AES 解密

### Q4: Native library 找不到

**原因**: `libLoadNiMa.so` 不在 JAR 中，需要通过 `InitOrigin.init()` 下载

**解决**:
```typescript
// JarLoader.ts - loadGuardSpiderJar()
await InitOrigin.init(app);  // 会下载 libLoadNiMa.so

// 或者手动从网络下载
// URL 存储在 JAR 内部的 newgo.txt 文件中
```

## 测试验证

使用 Python 脚本测试完整流程：

```bash
python d:\Code\TVBOXDesktop\decrypt_android_response.py
```

预期输出：
```
✅ Android got 'decry' URL (working video)
```

## 相关文件

- **解密脚本**: [decrypt_android_response.py](file:///d:/Code/TVBOXDesktop/decrypt_android_response.py)
- **Unidbg Loader**: [LoadNiMaDecryptor.java](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/unidbg-loader/src/main/java/com/tvbox/LoadNiMaDecryptor.java)
- **JarLoader**: [JarLoader.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/JarLoader.ts)
- **修复文档**: [修复秒播源无数据问题.md](file:///d:/Code/TVBOXDesktop/修复秒播源无数据问题.md)

## 重要提示

1. **所有解密逻辑都在 JAR 文件内部实现**，PC 版本只需要正确加载 JAR 和 native library
2. **unidbg 的作用**是模拟 ARM native library 的执行，不需要理解内部算法
3. **env_check 补丁**是关键，没有它 native 解密会返回原始输入
4. **签名验证**通过 `PackageManager.getPackageInfo(name, 64)` 实现，unidbg 无法提供真实签名，必须 patch