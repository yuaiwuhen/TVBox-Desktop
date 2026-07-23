# 源适配快速参考

## 常用命令

```bash
# 一键适配（测试所有源）
node tools/e2e/adapt-new-jar.cjs

# 测试单个配置
node tools/e2e/adapt-new-jar.cjs https://9280.kstore.vip/newwex.json

# 诊断单个源
node tools/e2e/diag-full.cjs MyQuark

# 列出所有源
node tools/e2e/list-all-sites.cjs

# 切换配置
node tools/e2e/switch-config.cjs https://9280.kstore.vip/newwex.json
```

## 常见问题速查

| 问题 | 检查项 | 解决方案 |
|------|--------|----------|
| ClassNotFoundException | 查看错误中的类名 | 添加对应stub类 |
| UnsatisfiedLinkError | 查看缺少的.so文件 | 确保native库在正确路径 |
| homeContent返回空 | 检查网络、参数、Cookie | 查看Spider日志 |
| detailContent返回空 | 检查vod_id格式 | 网盘源可能需要vod_id重排 |
| playerContent失败 | 检查Cookie、Token | 网盘源可能需要登录 |
| Guard解密失败 | 检查wexguard_v8.so版本 | 使用最新版解密库 |

## 添加Stub类步骤

```bash
# 1. 创建Java文件
cd tools/stub-classes
mkdir -p android/os
# 创建 Environment.java

# 2. 编译
javac -source 1.8 -target 1.8 android/os/Environment.java

# 3. 更新JAR
jar uf ../../stub.jar android/os/Environment.class

# 4. 清理
rm android/os/Environment.class
```

## 网盘登录检查

```javascript
// CDP Console
const {PanLogin} = await import('/src/core/PanLogin.ts');
console.log('Quark:', PanLogin.isLoggedIn('quark'));
console.log('UC:', PanLogin.isLoggedIn('uc'));
console.log('Ali:', PanLogin.isLoggedIn('aliyun'));
console.log('Baidu:', PanLogin.isLoggedIn('baidu'));
```

## 强制刷新JAR缓存

```bash
# 清理缓存
rm -rf jar_cache/*

# 或在CDP Console
const {spiderEngine} = await import('/src/core/SpiderEngine.ts');
spiderEngine.clearCache();
```

## 测试特定方法

```bash
# 只测试home
node tools/e2e/diag-full.cjs MyQuark home

# 只测试detail
node tools/e2e/diag-full.cjs MyQuark detail

# 只测试play
node tools/e2e/diag-full.cjs MyQuark play
```

## 查看Spider原始数据

```javascript
// CDP Console
const {useAppStore} = await import('/src/store/app.ts');
const s = useAppStore();

// 查看首页数据
console.log(JSON.stringify(s.homeVodList[0], null, 2));

// 查看详情数据
console.log(JSON.stringify(s.currentVod, null, 2));

// 查看播放数据
console.log('URL:', s.currentPlayUrl);
console.log('Header:', s.currentPlayHeader);
```

## 不可修复的源

以下源无法通过代码修复，属于正常情况：

- **服务器宕机**: API无响应（肥猫、光盘等）
- **发现类源**: 无detailContent（豆瓣、豆瓣预告）
- **搜索类源**: homeContent为空（米搜、PanSearch）
- **直播源**: 时机依赖（看球、瓜子）
- **WAF保护**: 需要JS指纹（NewJuTou）
- **Spider bug**: 代码缺陷（WexBoBo）
- **JS Spider**: 需要JS引擎（儿童）
- **配置问题**: 需要特定账户（MyUcPan非VIP）