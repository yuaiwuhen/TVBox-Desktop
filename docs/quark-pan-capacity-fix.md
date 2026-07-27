# 夸克网盘容量已满导致转存失败修复

## 问题

测试 `http://肥猫.net/tv` 配置时，夸克网盘类源（`csp_Duopan`、`csp_FeiMaoUC`、`csp_Netfixtv`）的详情页能正确返回播放链接，但调用 `loadPlay` 时返回错误：

```
容量已满, 建议购买会员
```

导致视频无法播放。

## 根本原因

夸克网盘免费用户空间有限（约 10GB）。`QuarkPanService.getDownloadUrlViaTransfer` 在播放夸克分享链接时会先将文件转存到 `TVBox` 临时文件夹，再通过 `/file/v2/play` 或 `/file/download` 获取播放 URL，最后调度 6 小时后清理。

由于以下原因导致 TVBox 文件夹堆积大量历史文件：

1. **清理调度仅在 6 小时后触发**：用户连续测试多个视频时，新转存的文件尚未到清理时间，旧文件却已积累到占用全部空间。
2. **`cleanupOldTransfers` 只清理 6 小时前的文件**：在 `getDownloadUrlViaTransfer` 入口调用，但 6 小时内的文件不会被清理。
3. **应用重启不会清理**：转存的文件持久存在于夸克网盘，跨会话累积。
4. **历史测试残留**：用户网盘 TVBox 文件夹曾占用 304GB，全是历次测试转存积累的文件。

当夸克网盘空间不足时，`/file/transfer` 接口返回错误码表示空间不足，`pollTransferTask` 检测到 `spaceIssue=true`，但 `getDownloadUrlViaTransfer` 此前没有对应的恢复逻辑，直接返回 `null`，最终被 `JarLoader.playerContent` 包装成"视频资源已失效"或更具体的"容量已满, 建议购买会员"。

## 修复方案

在 `QuarkPanService.ts` 中新增 `cleanupAllTransfers` 方法，并在 `getDownloadUrlViaTransfer` 检测到 `spaceIssue` 时调用：

### 1. 新增 `cleanupAllTransfers` 方法

```typescript
private static async cleanupAllTransfers(
  commonHeaders: Record<string, string>,
  tvboxFid: string,
): Promise<void> {
  try {
    let page = 1;
    const pageSize = 100;
    let totalDeleted = 0;
    while (true) {
      const resp = await axios.get(
        `https://drive-pc.quark.cn/1/clouddrive/file/sort?pr=ucpro&fr=pc&pdir_fid=${encodeURIComponent(tvboxFid)}&_page=${page}&_size=${pageSize}&_fetch_total=1&_fetch_sub_dirs=0&_sort=file_type:asc,updated_at:desc`,
        { headers: commonHeaders, timeout: 15000, validateStatus: () => true },
      );
      const list = resp.data?.data?.list || [];
      if (list.length === 0) break;
      for (const item of list) {
        if (item.dir) continue;  // 跳过子目录，避免误删用户文件夹
        await this.deleteFile(commonHeaders, item.fid);
        totalDeleted++;
      }
      if (list.length < pageSize) break;
      page++;
      if (page > 50) break;  // 安全上限，防止 API 异常时无限循环
    }
    console.log('[QuarkPanService] cleanupAllTransfers: deleted', totalDeleted, 'files');
  } catch (e: any) {
    console.warn('[QuarkPanService] cleanupAllTransfers error:', e.message);
  }
}
```

### 2. 在 `getDownloadUrlViaTransfer` 中调用

```typescript
let pollResult = await this.pollTransferTask(commonHeaders, taskId);

// 如果因空间不足失败，激进清理 TVBox 文件夹后重试一次
if (!pollResult.fid && pollResult.spaceIssue) {
  console.log('[QuarkPanService] getDownloadUrlViaTransfer: space issue detected, aggressively cleaning TVBox folder and retrying');
  await this.cleanupAllTransfers(commonHeaders, tvboxFid);
  const retryTransfer = await this.transferShareFile(
    commonHeaders, shareId, fid, shareFidToken, stoken, tvboxFid,
  );
  if (retryTransfer.taskId) {
    pollResult = await this.pollTransferTask(commonHeaders, retryTransfer.taskId);
  }
}
```

## 与 `cleanupOldTransfers` 的区别

| 方法 | 触发时机 | 清理范围 | 用途 |
|------|---------|---------|------|
| `cleanupOldTransfers` | 每次转存前（懒清理） | 仅 6 小时前的文件 | 防止 TVBox 文件夹日常堆积 |
| `cleanupAllTransfers` | 转存失败且检测到空间不足时 | 所有文件（不分年龄） | 紧急释放空间以挽救本次播放 |

## 注意事项

- **只清理文件，不清理子目录**：避免误删用户在 TVBox 文件夹下手动创建的子目录。
- **分页拉取**：单页 100 条，最多拉 50 页（5000 文件），覆盖大部分场景。
- **不缓存 `spaceIssue` 状态**：本次失败后下次仍会尝试，因为清理后可能就够空间了。
- **不影响其他源**：仅修改 QuarkPanService 内部逻辑，对其他网盘和源无影响。

## 验证

修复前 `test-3configs.cjs` 测试 `http://肥猫.net/tv`：20/39 通过。
修复后：22/39 通过，3 个夸克源（`csp_FeiMaoUC`、`csp_Duopan`、`csp_Netfixtv`）从 FAIL 变为 PASS。

## 相关文件

- [electron/QuarkPanService.ts](file:///d:/Code/TVBOXDesktop/TVBox-PC/electron/QuarkPanService.ts) - `cleanupAllTransfers` 方法、`getDownloadUrlViaTransfer` 中的调用
- [tools/e2e/test-3configs.cjs](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/e2e/test-3configs.cjs) - 验证脚本
- [tools/e2e/test-specific-play.cjs](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/e2e/test-specific-play.cjs) - 单源播放验证脚本
- [tools/e2e/diag-quark-drive.cjs](file:///d:/Code/TVBOXDesktop/TVBox-PC/tools/e2e/diag-quark-drive.cjs) - 网盘容量诊断脚本
