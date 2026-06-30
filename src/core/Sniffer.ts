import { VideoParseRuler } from './VideoParseRuler';
import { AdBlocker } from './AdBlocker';

// Conditionally import BrowserWindow
let BrowserWindow: any;
try { BrowserWindow = require('electron').BrowserWindow; } catch { BrowserWindow = null; }

export class Sniffer {
    static async sniff(url: string, clickSelector?: string): Promise<string> {
        if (BrowserWindow) {
            return Sniffer.sniffWithBrowser(url, clickSelector);
        }
        return Sniffer.sniffWithFetch(url);
    }

    private static sniffWithBrowser(url: string, clickSelector?: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const win = new BrowserWindow({
                width: 800,
                height: 600,
                show: false,
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    webSecurity: false,
                    images: false,
                },
            });

            let resolved = false;
            const timeoutId = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    if (!win.isDestroyed()) win.destroy();
                    reject(new Error('Sniffing timeout'));
                }
            }, 15000);

            // Block ads
            win.webContents.session.webRequest.onBeforeRequest((details: any, callback: any) => {
                if (AdBlocker.isAd(details.url)) {
                    return callback({ cancel: true });
                }

                // Check if this is a video URL using rules
                if (VideoParseRuler.isVideoUrl(url, details.url)) {
                    if (!VideoParseRuler.isFiltered(url, details.url)) {
                        if (!resolved) {
                            resolved = true;
                            clearTimeout(timeoutId);
                            if (!win.isDestroyed()) win.destroy();
                            resolve(details.url);
                        }
                        return callback({ cancel: true });
                    }
                }

                callback({ cancel: false });
            });

            // Inject scripts if configured for this host
            const script = VideoParseRuler.getScript(url);
            if (script) {
                win.webContents.on('dom-ready', () => {
                    for (const s of script) {
                        win.webContents.executeJavaScript(s).catch(() => {});
                    }
                });
            }

            win.webContents.on('did-fail-load', () => {
                clearTimeout(timeoutId);
                if (!resolved) {
                    resolved = true;
                    if (!win.isDestroyed()) win.destroy();
                    reject(new Error('Page failed to load'));
                }
            });

            win.loadURL(url, {
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            });

            // Click selector support: click an element after page loads
            if (clickSelector) {
                win.webContents.on('dom-ready', () => {
                    const parts = clickSelector.split(';');
                    if (parts.length >= 2) {
                        // Format: "domain;selector" - only click if URL matches domain
                        const domain = parts[0];
                        if (url.includes(domain)) {
                            win.webContents.executeJavaScript(`document.querySelector('${parts[1]}')?.click()`).catch(() => {});
                        }
                    } else {
                        win.webContents.executeJavaScript(`document.querySelector('${clickSelector}')?.click()`).catch(() => {});
                    }
                });
            }
        });
    }

    private static async sniffWithFetch(url: string): Promise<string> {
        const axios = require('axios');
        try {
            const resp = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                },
                timeout: 15000,
                responseType: 'text',
            });
            // Try to find video URLs in the HTML response
            const html = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
            const videoRegex = /https?:\/\/[^\s"'<>]+?\.(m3u8|mp4|flv|mkv)(\?[^\s"'<>]*)?/gi;
            const matches = html.match(videoRegex);
            if (matches && matches.length > 0) {
                return matches[0];
            }
            throw new Error('No video URL found in page content');
        } catch (e: any) {
            throw new Error(`Sniff failed: ${e.message}`);
        }
    }
}
