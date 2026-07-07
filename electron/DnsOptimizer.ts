/**
 * DNS-over-HTTPS (DoH) 优化模块
 * 
 * 功能：
 * 1. 使用DNS-over-HTTPS绕过运营商DNS劫持，提高DNS解析速度
 * 2. 支持多个DoH服务器（腾讯、阿里、360、Google等）
 * 3. 自动测速并选择最快的DoH服务器
 * 4. DNS缓存机制，减少重复查询
 * 5. 故障切换机制，保证稳定性
 * 
 * 参考安卓版TVBox的OkGoHelper.java实现
 */

import https from 'https';
import http from 'http';
import dns from 'dns';
import { URL } from 'url';

// DoH服务器配置（参考安卓版TVBox）
const DOH_SERVERS = [
  { name: '腾讯', url: 'https://doh.pub/dns-query', priority: 1 },
  { name: '阿里', url: 'https://dns.alidns.com/dns-query', priority: 2 },
  { name: '360', url: 'https://doh.360.cn/dns-query', priority: 3 },
  { name: 'Google', url: 'https://dns.google/dns-query', priority: 4 },
  { name: 'AdGuard', url: 'https://dns.adguard.com/dns-query', priority: 5 },
  { name: 'Quad9', url: 'https://dns.quad9.net/dns-query', priority: 6 },
];

// DNS缓存结构
interface DnsCacheEntry {
  ips: string[];           // 解析出的IP地址列表
  timestamp: number;       // 缓存时间戳
  ttl: number;             // TTL（秒）
  dohServer: string;       // 使用的DoH服务器
}

// DoH服务器测速结果
interface DoHSpeedTestResult {
  name: string;
  url: string;
  latency: number;         // 响应延迟（ms）
  success: boolean;
  error?: string;
}

export class DnsOptimizer {
  // DNS缓存（域名 -> 缓存条目）
  private dnsCache = new Map<string, DnsCacheEntry>();
  
  // 最快的DoH服务器（自动测速后确定）
  private fastestDohServer: string | null = null;
  
  // DoH测速结果
  private dohSpeedResults: DoHSpeedTestResult[] = [];
  
  // 缓存默认TTL（秒）
  private defaultTTL = 300; // 5分钟
  
  // 缓存最大条目数（防止内存泄漏）
  private maxCacheSize = 1000;
  
  // 是否启用DoH
  private dohEnabled = true;
  
  // 是否已进行DoH测速
  private speedTestDone = false;
  
  constructor() {
    console.log('[DnsOptimizer] DNS-over-HTTPS优化模块已初始化');
  }
  
  /**
   * 启用/禁用DoH
   */
  setEnabled(enabled: boolean) {
    this.dohEnabled = enabled;
    console.log(`[DnsOptimizer] DoH已${enabled ? '启用' : '禁用'}`);
  }
  
  /**
   * 测试所有DoH服务器的速度
   * 自动选择最快的DoH服务器
   */
  async testDohServers(): Promise<DoHSpeedTestResult[]> {
    console.log('[DnsOptimizer] 开始测试DoH服务器速度...');
    
    this.dohSpeedResults = [];
    const testDomain = 'hxqapi.hiyun.tv'; // 使用韩剧源域名测试
    
    for (const server of DOH_SERVERS) {
      const startTime = Date.now();
      try {
        // 测试DoH服务器
        const ips = await this.dohResolve(testDomain, server.url);
        const latency = Date.now() - startTime;
        
        this.dohSpeedResults.push({
          name: server.name,
          url: server.url,
          latency,
          success: true,
        });
        
        console.log(`[DnsOptimizer] ${server.name} DoH: ${latency}ms, 解析出 ${ips.length} 个IP`);
      } catch (e: any) {
        const latency = Date.now() - startTime;
        this.dohSpeedResults.push({
          name: server.name,
          url: server.url,
          latency,
          success: false,
          error: e.message,
        });
        
        console.warn(`[DnsOptimizer] ${server.name} DoH测试失败:`, e.message);
      }
    }
    
    // 选择最快的成功DoH服务器
    const successfulServers = this.dohSpeedResults
      .filter(r => r.success)
      .sort((a, b) => a.latency - b.latency);
    
    if (successfulServers.length > 0) {
      this.fastestDohServer = successfulServers[0].url;
      console.log(
        `[DnsOptimizer] 最快的DoH服务器: ${successfulServers[0].name} (${successfulServers[0].url}), 延迟: ${successfulServers[0].latency}ms`
      );
    } else {
      console.warn('[DnsOptimizer] 所有DoH服务器都失败，将使用系统DNS');
      this.fastestDohServer = null;
    }
    
    this.speedTestDone = true;
    return this.dohSpeedResults;
  }
  
  /**
   * 使用DNS-over-HTTPS解析域名
   */
  private async dohResolve(domain: string, dohUrl: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const url = new URL(dohUrl);
      
      // 构造DNS查询请求（DNS wire format）
      // DNS查询格式：https://tools.ietf.org/html/rfc8484
      const dnsQuery = this.buildDnsQuery(domain);
      
      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + '?dns=' + dnsQuery,
        method: 'GET',
        headers: {
          'Accept': 'application/dns-message',
          'User-Agent': 'TVBox-PC/1.0',
        },
        timeout: 5000, // 5秒超时
      };
      
      const req = https.request(options, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`DoH服务器返回 ${res.statusCode}`));
          return;
        }
        
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const dnsResponse = Buffer.concat(chunks);
            const ips = this.parseDnsResponse(dnsResponse);
            resolve(ips);
          } catch (e) {
            reject(e);
          }
        });
        res.on('error', reject);
      });
      
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('DoH请求超时'));
      });
      
      req.end();
    });
  }
  
  /**
   * 构造DNS查询消息（DNS wire format）
   * 参考：https://tools.ietf.org/html/rfc8484
   */
  private buildDnsQuery(domain: string): string {
    // DNS查询消息格式（简化版）
    // Header (12 bytes) + Question section
    
    const buffer = Buffer.alloc(12 + domain.split('.').length * 2 + 4);
    let offset = 0;
    
    // Header (12 bytes)
    // ID: 2 bytes (随机)
    buffer.writeUInt16BE(Math.floor(Math.random() * 65535), offset);
    offset += 2;
    
    // Flags: 2 bytes (标准查询)
    buffer.writeUInt16BE(0x0100, offset); // Recursion Desired
    offset += 2;
    
    // QDCOUNT: 2 bytes (1个问题)
    buffer.writeUInt16BE(1, offset);
    offset += 2;
    
    // ANCOUNT: 2 bytes (0个回答)
    buffer.writeUInt16BE(0, offset);
    offset += 2;
    
    // NSCOUNT: 2 bytes (0个权威)
    buffer.writeUInt16BE(0, offset);
    offset += 2;
    
    // ARCOUNT: 2 bytes (0个附加)
    buffer.writeUInt16BE(0, offset);
    offset += 2;
    
    // Question section
    // QNAME: domain name (length-prefixed labels)
    const labels = domain.split('.');
    for (const label of labels) {
      buffer.writeUInt8(label.length, offset);
      offset += 1;
      buffer.write(label, offset);
      offset += label.length;
    }
    buffer.writeUInt8(0, offset); // 结束标记
    offset += 1;
    
    // QTYPE: 2 bytes (A记录 = 1)
    buffer.writeUInt16BE(1, offset);
    offset += 2;
    
    // QCLASS: 2 bytes (IN = 1)
    buffer.writeUInt16BE(1, offset);
    offset += 2;
    
    // 转换为Base64Url编码（DoH要求）
    return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }
  
  /**
   * 解析DNS响应消息（DNS wire format）
   */
  private parseDnsResponse(dnsResponse: Buffer): string[] {
    const ips: string[] = [];
    let offset = 12; // Skip header
    
    // 解析问题数量
    const qdcount = dnsResponse.readUInt16BE(4);
    
    // 跳过问题部分
    for (let i = 0; i < qdcount; i++) {
      // 跳过QNAME
      while (dnsResponse.readUInt8(offset) !== 0) {
        const length = dnsResponse.readUInt8(offset);
        offset += length + 1;
      }
      offset += 1; // 结束标记
      
      // 跳过QTYPE和QCLASS
      offset += 4;
    }
    
    // 解析回答数量
    const ancount = dnsResponse.readUInt16BE(6);
    
    // 解析回答部分
    for (let i = 0; i < ancount; i++) {
      // 跳过NAME（使用压缩指针）
      if ((dnsResponse.readUInt8(offset) & 0xC0) === 0xC0) {
        offset += 2; // 压缩指针
      } else {
        // 跳过完整域名
        while (dnsResponse.readUInt8(offset) !== 0) {
          const length = dnsResponse.readUInt8(offset);
          offset += length + 1;
        }
        offset += 1; // 结束标记
      }
      
      // TYPE: 2 bytes
      const type = dnsResponse.readUInt16BE(offset);
      offset += 2;
      
      // CLASS: 2 bytes
      const classVal = dnsResponse.readUInt16BE(offset);
      offset += 2;
      
      // TTL: 4 bytes
      const ttl = dnsResponse.readUInt32BE(offset);
      offset += 4;
      
      // RDLENGTH: 2 bytes
      const rdlength = dnsResponse.readUInt16BE(offset);
      offset += 2;
      
      // RDATA: IP地址（如果是A记录）
      if (type === 1 && classVal === 1 && rdlength === 4) {
        const ip = `${dnsResponse.readUInt8(offset)}.${dnsResponse.readUInt8(offset + 1)}.${dnsResponse.readUInt8(offset + 2)}.${dnsResponse.readUInt8(offset + 3)}`;
        ips.push(ip);
        
        // 更新TTL（使用回答中的TTL）
        if (this.dnsCache.size < this.maxCacheSize) {
          // TTL将在缓存时使用
        }
      }
      
      offset += rdlength;
    }
    
    return ips;
  }
  
  /**
   * 解析域名（主方法）
   * 优先使用DoH，失败则使用系统DNS
   */
  async resolve(domain: string): Promise<string[]> {
    // 检查缓存
    const cached = this.dnsCache.get(domain);
    if (cached && Date.now() - cached.timestamp < cached.ttl * 1000) {
      console.log(`[DnsOptimizer] 使用缓存的DNS解析: ${domain} -> ${cached.ips.join(', ')}`);
      return cached.ips;
    }
    
    // 如果未启用DoH，直接使用系统DNS
    if (!this.dohEnabled) {
      console.log('[DnsOptimizer] DoH已禁用，使用系统DNS');
      return await this.systemResolve(domain);
    }
    
    // 如果未测速，先测速DoH服务器
    if (!this.speedTestDone) {
      console.log('[DnsOptimizer] 未测速，开始测速DoH服务器');
      await this.testDohServers();
    }
    
    // 使用最快的DoH服务器解析
    if (this.fastestDohServer) {
      try {
        console.log(`[DnsOptimizer] 使用DoH解析: ${domain}`);
        const ips = await this.dohResolve(domain, this.fastestDohServer);
        
        // 更新缓存
        this.updateCache(domain, ips, this.defaultTTL, this.fastestDohServer);
        
        console.log(`[DnsOptimizer] DoH解析成功: ${domain} -> ${ips.join(', ')}`);
        return ips;
      } catch (e: any) {
        console.warn(`[DnsOptimizer] DoH解析失败:`, e.message);
        
        // 尝试其他DoH服务器
        for (const server of DOH_SERVERS) {
          if (server.url === this.fastestDohServer) continue;
          
          try {
            console.log(`[DnsOptimizer] 尝试备用DoH服务器: ${server.name}`);
            const ips = await this.dohResolve(domain, server.url);
            
            // 更新缓存
            this.updateCache(domain, ips, this.defaultTTL, server.url);
            
            console.log(`[DnsOptimizer] 备用DoH解析成功: ${domain} -> ${ips.join(', ')}`);
            return ips;
          } catch (e2: any) {
            console.warn(`[DnsOptimizer] 备用DoH ${server.name} 也失败:`, e2.message);
          }
        }
      }
    }
    
    // 所有DoH都失败，使用系统DNS
    console.log('[DnsOptimizer] 所有DoH失败，使用系统DNS');
    return await this.systemResolve(domain);
  }
  
  /**
   * 使用系统DNS解析域名
   */
  private async systemResolve(domain: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      dns.resolve4(domain, (err, addresses) => {
        if (err) {
          reject(err);
        } else {
          // 更新缓存
          this.updateCache(domain, addresses, this.defaultTTL, 'system');
          
          console.log(`[DnsOptimizer] 系统DNS解析: ${domain} -> ${addresses.join(', ')}`);
          resolve(addresses);
        }
      });
    });
  }
  
  /**
   * 更新DNS缓存
   */
  private updateCache(domain: string, ips: string[], ttl: number, dohServer: string) {
    // 清理过期的缓存（防止内存泄漏）
    if (this.dnsCache.size >= this.maxCacheSize) {
      this.cleanExpiredCache();
    }
    
    this.dnsCache.set(domain, {
      ips,
      timestamp: Date.now(),
      ttl,
      dohServer,
    });
    
    console.log(`[DnsOptimizer] 缓存DNS解析: ${domain}, TTL=${ttl}s, DoH=${dohServer}`);
  }
  
  /**
   * 清理过期的缓存
   */
  private cleanExpiredCache() {
    const now = Date.now();
    const expiredKeys: string[] = [];
    
    for (const [key, entry] of this.dnsCache.entries()) {
      if (now - entry.timestamp > entry.ttl * 1000) {
        expiredKeys.push(key);
      }
    }
    
    for (const key of expiredKeys) {
      this.dnsCache.delete(key);
    }
    
    console.log(`[DnsOptimizer] 清理了 ${expiredKeys.length} 个过期缓存`);
  }
  
  /**
   * 获取缓存统计信息
   */
  getCacheStats() {
    return {
      totalEntries: this.dnsCache.size,
      maxCacheSize: this.maxCacheSize,
      defaultTTL: this.defaultTTL,
      dohEnabled: this.dohEnabled,
      fastestDohServer: this.fastestDohServer,
      speedTestDone: this.speedTestDone,
      speedResults: this.dohSpeedResults,
    };
  }
  
  /**
   * 清空缓存
   */
  clearCache() {
    this.dnsCache.clear();
    console.log('[DnsOptimizer] DNS缓存已清空');
  }
  
  /**
   * 手动重新测速DoH服务器
   */
  async retestDohServers() {
    this.speedTestDone = false;
    this.fastestDohServer = null;
    return await this.testDohServers();
  }
}

// 导出单例实例
export const dnsOptimizer = new DnsOptimizer();