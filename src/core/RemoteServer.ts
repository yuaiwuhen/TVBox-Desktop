import type { SourceBean, Movie } from './models';

const _require =
  typeof require !== 'undefined'
    ? require
    : (m: string) => {
        throw new Error(`Cannot require ${m}`);
      };
const http = _require('http');
const { URL } = _require('url');

export interface RemoteControlHandler {
  getCurrentSource(): SourceBean | null;
  getSources(): SourceBean[];
  search(keyword: string, siteKeys?: string[]): Promise<void>;
  getDetail(sourceKey: string, vodId: string): Promise<Movie | null>;
  play(
    sourceKey: string,
    vodId: string,
    flag: string,
    episodeUrl: string,
  ): Promise<void>;
  control(action: string): void;
  getStatus(): Record<string, any>;
  setConfigUrl?(url: string): Promise<void>;
  setLiveUrl?(url: string): void;
  setEpgUrl?(url: string): void;
}

export class RemoteServer {
  private server: any = null;
  private port: number = 12345;
  private handler: RemoteControlHandler | null = null;

  setHandler(handler: RemoteControlHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this.server) return;

    this.server = http.createServer((req: any, res: any) => {
      this.handleRequest(req, res).catch((e: any) => {
        console.error('[RemoteServer] Error:', e);
        this.sendJson(res, 500, { error: 'Internal Server Error' });
      });
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(this.port, '0.0.0.0', () => {
        console.log(`[RemoteServer] Listening on http://0.0.0.0:${this.port}`);
        resolve();
      });
      this.server!.on('error', (e: any) => {
        if (e.code === 'EADDRINUSE') {
          this.port++;
          this.server!.close();
          this.server!.listen(this.port, '0.0.0.0', () => {
            console.log(
              `[RemoteServer] Listening on http://0.0.0.0:${this.port}`,
            );
            resolve();
          });
        } else {
          reject(e);
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolve, reject) => {
      this.server!.close((err: any) => {
        this.server = null;
        if (err) reject(err);
        else resolve();
      });
    });
  }

  getPort(): number {
    return this.port;
  }

  private async handleRequest(req: any, res: any): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);
    const pathname = reqUrl.pathname;

    if (pathname === '/') {
      this.sendJson(res, 200, {
        name: 'TVBox PC Remote',
        version: '1.0.0',
        endpoints: [
          '/',
          '/status',
          '/search',
          '/detail',
          '/push',
          '/control',
          '/sources',
          '/source',
          '/action',
          '/media',
        ],
      });
    } else if (pathname === '/status' || pathname === '/media') {
      this.handleStatus(res);
    } else if (pathname === '/sources') {
      this.handleSources(res);
    } else if (pathname === '/source') {
      this.handleSource(reqUrl, res);
    } else if (pathname === '/search') {
      await this.handleSearch(reqUrl, res);
    } else if (pathname === '/detail') {
      await this.handleDetail(reqUrl, res);
    } else if (pathname === '/push') {
      await this.handlePush(reqUrl, res);
    } else if (pathname === '/control') {
      this.handleControl(reqUrl, res);
    } else if (pathname === '/action') {
      await this.handleAction(req, reqUrl, res);
    } else {
      this.sendJson(res, 404, { error: 'Not Found' });
    }
  }

  private handleStatus(res: any): void {
    if (!this.handler) {
      this.sendJson(res, 503, { error: 'Handler not connected' });
      return;
    }
    this.sendJson(res, 200, this.handler.getStatus());
  }

  private handleSources(res: any): void {
    if (!this.handler) {
      this.sendJson(res, 503, { error: 'Handler not connected' });
      return;
    }
    const sources = this.handler.getSources();
    this.sendJson(
      res,
      200,
      sources.map((s) => ({ key: s.key, name: s.name, type: s.type })),
    );
  }

  private handleSource(reqUrl: URL, res: any): void {
    if (!this.handler) {
      this.sendJson(res, 503, { error: 'Handler not connected' });
      return;
    }
    const key = reqUrl.searchParams.get('key') || '';
    const current = this.handler.getCurrentSource();
    if (key) {
      const sources = this.handler.getSources();
      const found = sources.find((s) => s.key === key);
      this.sendJson(res, 200, found || null);
    } else {
      this.sendJson(res, 200, current);
    }
  }

  private async handleSearch(reqUrl: URL, res: any): Promise<void> {
    if (!this.handler) {
      this.sendJson(res, 503, { error: 'Handler not connected' });
      return;
    }
    const keyword = reqUrl.searchParams.get('wd') || '';
    if (!keyword) {
      this.sendJson(res, 400, { error: 'Missing wd parameter' });
      return;
    }
    const siteKeys = reqUrl.searchParams.get('sites')?.split(',') || undefined;
    try {
      await this.handler.search(keyword, siteKeys);
      this.sendJson(res, 200, { message: 'Search initiated', keyword });
    } catch (e: any) {
      this.sendJson(res, 500, { error: e.message });
    }
  }

  private async handleDetail(reqUrl: URL, res: any): Promise<void> {
    if (!this.handler) {
      this.sendJson(res, 503, { error: 'Handler not connected' });
      return;
    }
    const sourceKey = reqUrl.searchParams.get('source') || '';
    const vodId = reqUrl.searchParams.get('id') || '';
    if (!sourceKey || !vodId) {
      this.sendJson(res, 400, { error: 'Missing source or id parameter' });
      return;
    }
    try {
      const detail = await this.handler.getDetail(sourceKey, vodId);
      this.sendJson(res, 200, detail);
    } catch (e: any) {
      this.sendJson(res, 500, { error: e.message });
    }
  }

  private async handlePush(reqUrl: URL, res: any): Promise<void> {
    if (!this.handler) {
      this.sendJson(res, 503, { error: 'Handler not connected' });
      return;
    }
    const sourceKey = reqUrl.searchParams.get('source') || '';
    const vodId = reqUrl.searchParams.get('id') || '';
    const flag = reqUrl.searchParams.get('flag') || '';
    const episodeUrl = reqUrl.searchParams.get('url') || '';
    if (!sourceKey || !vodId || !episodeUrl) {
      this.sendJson(res, 400, {
        error: 'Missing source, id, or url parameter',
      });
      return;
    }
    try {
      await this.handler.play(sourceKey, vodId, flag, episodeUrl);
      this.sendJson(res, 200, { message: 'Playback started' });
    } catch (e: any) {
      this.sendJson(res, 500, { error: e.message });
    }
  }

  private handleControl(reqUrl: URL, res: any): void {
    if (!this.handler) {
      this.sendJson(res, 503, { error: 'Handler not connected' });
      return;
    }
    const action = reqUrl.searchParams.get('action') || '';
    if (!action) {
      this.sendJson(res, 400, { error: 'Missing action parameter' });
      return;
    }
    this.handler.control(action);
    this.sendJson(res, 200, { message: `Action ${action} executed` });
  }

  /**
   * POST /action - Remote control actions (Box-compatible)
   * do=search&word=xxx    - Remote search
   * do=api&url=xxx        - Set config URL
   * do=live&url=xxx       - Set live URL
   * do=epg&url=xxx        - Set EPG URL
   * do=push&url=xxx       - Push URL for playback
   * do=mirror&id=x&sourceKey=y - Push video to this device
   */
  private async handleAction(req: any, reqUrl: URL, res: any): Promise<void> {
    // Collect body data for POST
    const body = await this.readBody(req);
    const params = new URLSearchParams(body || '');
    const doAction = reqUrl.searchParams.get('do') || params.get('do') || '';

    switch (doAction) {
      case 'search': {
        const word =
          params.get('word') || reqUrl.searchParams.get('word') || '';
        if (!word || !this.handler) {
          this.sendJson(res, 400, { error: 'Missing word parameter' });
          return;
        }
        try {
          await this.handler.search(word);
          this.sendJson(res, 200, { message: `Search initiated: ${word}` });
        } catch (e: any) {
          this.sendJson(res, 500, { error: e.message });
        }
        break;
      }
      case 'api': {
        const url = params.get('url') || reqUrl.searchParams.get('url') || '';
        if (!url) {
          this.sendJson(res, 400, { error: 'Missing url parameter' });
          return;
        }
        if (this.handler?.setConfigUrl) {
          try {
            await this.handler.setConfigUrl(url);
            this.sendJson(res, 200, { message: `Config URL set: ${url}` });
          } catch (e: any) {
            this.sendJson(res, 500, { error: e.message });
          }
        } else {
          this.sendJson(res, 501, { error: 'setConfigUrl not supported' });
        }
        break;
      }
      case 'live': {
        const url = params.get('url') || reqUrl.searchParams.get('url') || '';
        if (!url) {
          this.sendJson(res, 400, { error: 'Missing url parameter' });
          return;
        }
        if (this.handler?.setLiveUrl) {
          this.handler.setLiveUrl(url);
          this.sendJson(res, 200, { message: `Live URL set: ${url}` });
        } else {
          this.sendJson(res, 501, { error: 'setLiveUrl not supported' });
        }
        break;
      }
      case 'epg': {
        const url = params.get('url') || reqUrl.searchParams.get('url') || '';
        if (!url) {
          this.sendJson(res, 400, { error: 'Missing url parameter' });
          return;
        }
        if (this.handler?.setEpgUrl) {
          this.handler.setEpgUrl(url);
          this.sendJson(res, 200, { message: `EPG URL set: ${url}` });
        } else {
          this.sendJson(res, 501, { error: 'setEpgUrl not supported' });
        }
        break;
      }
      case 'push': {
        const url = params.get('url') || reqUrl.searchParams.get('url') || '';
        if (!url || !this.handler) {
          this.sendJson(res, 400, { error: 'Missing url parameter' });
          return;
        }
        // Try to play the pushed URL directly
        this.handler.control(`push:${url}`);
        this.sendJson(res, 200, { message: `Push received: ${url}` });
        break;
      }
      case 'mirror': {
        const id = params.get('id') || '';
        const sourceKey = params.get('sourceKey') || '';
        if (!id || !sourceKey || !this.handler) {
          this.sendJson(res, 400, {
            error: 'Missing id or sourceKey parameter',
          });
          return;
        }
        try {
          await this.handler.play(sourceKey, id, '', '');
          this.sendJson(res, 200, { message: 'Mirror playback started' });
        } catch (e: any) {
          this.sendJson(res, 500, { error: e.message });
        }
        break;
      }
      default:
        this.sendJson(res, 400, { error: `Unknown action: ${doAction}` });
    }
  }

  private readBody(req: any): Promise<string> {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        resolve(body);
      });
      req.on('error', () => {
        resolve('');
      });
    });
  }

  private sendJson(res: any, code: number, data: any): void {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }
}

export const remoteServer = new RemoteServer();
