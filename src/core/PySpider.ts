import axios from 'axios';
import type { ISpider } from './models';

// Node.js builtins via require (Vite doesn't bundle these)
const _require =
  typeof require !== 'undefined'
    ? require
    : (m: string) => {
        throw new Error(`Cannot require ${m}`);
      };
const { spawn } = _require('child_process');
const fs = _require('fs');
const path = _require('path');
const os = _require('os');

interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params: any[];
  id: number;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  result?: any;
  error?: { code: number; message: string };
  id: number;
}

const RUNNER_SCRIPT = `
#coding=utf-8
import sys
import json
import os
import importlib.util

sys.dont_write_bytecode = True

spiders = {}
spider_params = {}

def load_spider(name, py_path, extend=""):
    spec = importlib.util.spec_from_file_location(name, py_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    sp = mod.Spider()
    sp.extend = extend
    spiders[name] = sp
    spider_params[name] = extend
    return sp

def get_spider(name):
    if name not in spiders:
        return None
    return spiders[name]

# JSON-RPC loop
buf = ""
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        method = req.get("method", "")
        params = req.get("params", [])
        rid = req.get("id", 0)
        name = params[0] if params else ""

        if method == "load":
            py_path = params[1]
            extend = params[2] if len(params) > 2 else ""
            sp = load_spider(name, py_path, extend)
            sp.init(extend)
            sys.stdout.write(json.dumps({"id": rid, "result": "ok"}) + "\\n")
            sys.stdout.flush()

        elif method == "init":
            sp = get_spider(name)
            extend = params[1] if len(params) > 1 else spider_params.get(name, "")
            if sp:
                sp.init(extend)
                sys.stdout.write(json.dumps({"id": rid, "result": "ok"}) + "\\n")
            else:
                sys.stdout.write(json.dumps({"id": rid, "error": {"code": -1, "message": "spider not found"}}) + "\\n")
            sys.stdout.flush()

        elif method == "homeContent":
            sp = get_spider(name)
            filter_val = params[1] if len(params) > 1 else False
            result = sp.homeContent(filter_val) if sp else {}
            sys.stdout.write(json.dumps({"id": rid, "result": json.dumps(result, ensure_ascii=False)}) + "\\n")
            sys.stdout.flush()

        elif method == "homeVideoContent":
            sp = get_spider(name)
            result = sp.homeVideoContent() if sp else {}
            sys.stdout.write(json.dumps({"id": rid, "result": json.dumps(result, ensure_ascii=False)}) + "\\n")
            sys.stdout.flush()

        elif method == "categoryContent":
            sp = get_spider(name)
            tid = params[1] if len(params) > 1 else ""
            pg = params[2] if len(params) > 2 else "1"
            filter_val = params[3] if len(params) > 3 else False
            extend = params[4] if len(params) > 4 else "{}"
            if isinstance(extend, str):
                try: extend = json.loads(extend)
                except: extend = {}
            result = sp.categoryContent(tid, pg, filter_val, extend) if sp else {}
            sys.stdout.write(json.dumps({"id": rid, "result": json.dumps(result, ensure_ascii=False)}) + "\\n")
            sys.stdout.flush()

        elif method == "detailContent":
            sp = get_spider(name)
            ids = params[1] if len(params) > 1 else []
            result = sp.detailContent(ids) if sp else {}
            sys.stdout.write(json.dumps({"id": rid, "result": json.dumps(result, ensure_ascii=False)}) + "\\n")
            sys.stdout.flush()

        elif method == "searchContent":
            sp = get_spider(name)
            key = params[1] if len(params) > 1 else ""
            quick = params[2] if len(params) > 2 else False
            pg = params[3] if len(params) > 3 else ""
            result = sp.searchContent(key, quick, pg) if sp and pg else (sp.searchContent(key, quick) if sp else {})
            sys.stdout.write(json.dumps({"id": rid, "result": json.dumps(result, ensure_ascii=False)}) + "\\n")
            sys.stdout.flush()

        elif method == "playerContent":
            sp = get_spider(name)
            flag = params[1] if len(params) > 1 else ""
            vid = params[2] if len(params) > 2 else ""
            vipFlags = params[3] if len(params) > 3 else []
            result = sp.playerContent(flag, vid, vipFlags) if sp else {}
            sys.stdout.write(json.dumps({"id": rid, "result": json.dumps(result, ensure_ascii=False)}) + "\\n")
            sys.stdout.flush()

        elif method == "isVideoFormat":
            sp = get_spider(name)
            url = params[1] if len(params) > 1 else ""
            result = sp.isVideoFormat(url) if sp else False
            sys.stdout.write(json.dumps({"id": rid, "result": result}) + "\\n")
            sys.stdout.flush()

        elif method == "manualVideoCheck":
            sp = get_spider(name)
            result = sp.manualVideoCheck() if sp else False
            sys.stdout.write(json.dumps({"id": rid, "result": result}) + "\\n")
            sys.stdout.flush()

        elif method == "action":
            sp = get_spider(name)
            actionId = params[1] if len(params) > 1 else ""
            actionData = params[2] if len(params) > 2 else ""
            if isinstance(actionData, str):
                try: actionData = json.loads(actionData)
                except: pass
            result = sp.action(actionId, actionData) if sp else {}
            sys.stdout.write(json.dumps({"id": rid, "result": json.dumps(result, ensure_ascii=False)}) + "\\n")
            sys.stdout.flush()

        elif method == "localProxy":
            sp = get_spider(name)
            param = params[1] if len(params) > 1 else {}
            if isinstance(param, str):
                try: param = json.loads(param)
                except: pass
            result = sp.localProxy(param) if sp else None
            sys.stdout.write(json.dumps({"id": rid, "result": result}) + "\\n")
            sys.stdout.flush()

        else:
            sys.stdout.write(json.dumps({"id": rid, "error": {"code": -32601, "message": "method not found"}}) + "\\n")
            sys.stdout.flush()

    except Exception as e:
        sys.stdout.write(json.dumps({"id": req.get("id", 0) if "req" in dir() else 0, "error": {"code": -32603, "message": str(e)}}) + "\\n")
        sys.stdout.flush()
`;

let pythonCmd = '';
let pythonAvailable = false;

function detectPython(): string {
  if (pythonCmd) return pythonCmd;
  const commands = ['python3', 'python', 'py'];
  for (const cmd of commands) {
    try {
      const { execSync } = require('child_process');
      const version = execSync(`${cmd} --version 2>&1`, {
        timeout: 5000,
      }).toString();
      if (version.includes('Python 3')) {
        pythonCmd = cmd;
        pythonAvailable = true;
        return cmd;
      }
    } catch {
      continue;
    }
  }
  return '';
}

export class PySpider implements ISpider {
  private key: string;
  private api: string;
  private ext: string;
  private process: import('child_process').ChildProcess | null = null;
  private rpcId = 0;
  private pendingCallbacks: Map<
    number,
    { resolve: Function; reject: Function }
  > = new Map();
  private loaded = false;
  private pyFilePath = '';
  private pluginDir = '';

  constructor(key: string, api: string, ext: string = '') {
    this.key = key;
    this.api = api;
    this.ext = ext;
    this.pluginDir = path.join(os.tmpdir(), 'tvbox-pc', 'plugin');
  }

  private async ensureProcess(): Promise<void> {
    if (this.process) return;

    const pyCmd = detectPython();
    if (!pyCmd)
      throw new Error(
        'Python 3 not found. Install Python 3 to use .py sources.',
      );

    // Ensure plugin dir
    if (!fs.existsSync(this.pluginDir)) {
      fs.mkdirSync(this.pluginDir, { recursive: true });
    }

    // Write runner script
    const runnerPath = path.join(this.pluginDir, 'runner.py');
    fs.writeFileSync(runnerPath, RUNNER_SCRIPT, 'utf-8');

    // Download spider .py file
    this.pyFilePath = await this.downloadSpider();

    // Spawn Python process
    this.process = spawn(pyCmd, [runnerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.pluginDir,
      env: { ...process.env, PYTHONPATH: this.pluginDir },
    });

    this.process!.stdout!.on('data', (data: Buffer) => {
      const lines = data
        .toString()
        .split('\n')
        .filter((l) => l.trim());
      for (const line of lines) {
        try {
          const resp: JsonRpcResponse = JSON.parse(line);
          const cb = this.pendingCallbacks.get(resp.id);
          if (cb) {
            this.pendingCallbacks.delete(resp.id);
            if (resp.error) cb.reject(new Error(resp.error.message));
            else cb.resolve(resp.result);
          }
        } catch {
          /* ignore non-JSON output */
        }
      }
    });

    this.process!.stderr!.on('data', (data: Buffer) => {
      console.warn(`[PySpider:${this.key}]`, data.toString());
    });

    this.process!.on('error', (err: Error) => {
      console.error(`[PySpider:${this.key}] process error:`, err);
      this.rejectAll(err);
    });

    this.process!.on('exit', () => {
      this.process = null;
      this.rejectAll(new Error('Python process exited'));
    });

    // Load the spider
    await this.rpc('load', [this.key, this.pyFilePath, this.ext]);
    this.loaded = true;
  }

  private async downloadSpider(): Promise<string> {
    const name = this.key.replace(/[^a-zA-Z0-9_]/g, '_');
    const filePath = path.join(this.pluginDir, `${name}.py`);

    if (this.api.startsWith('file://')) {
      return this.api.replace('file://', '');
    }

    // Check cache
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      if (Date.now() - stat.mtimeMs < 7 * 24 * 3600 * 1000) {
        return filePath;
      }
    }

    try {
      const { data } = await axios.get(this.api, {
        responseType: 'text',
        timeout: 30000,
      });
      fs.writeFileSync(
        filePath,
        typeof data === 'string' ? data : JSON.stringify(data),
        'utf-8',
      );
    } catch (e) {
      if (fs.existsSync(filePath)) return filePath;
      throw e;
    }

    return filePath;
  }

  private rpc(method: string, params: any[]): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.process) {
        reject(new Error('Python process not running'));
        return;
      }
      const id = ++this.rpcId;
      const req: JsonRpcRequest = { jsonrpc: '2.0', method, params, id };
      this.pendingCallbacks.set(id, { resolve, reject });
      this.process!.stdin!.write(JSON.stringify(req) + '\n');
      setTimeout(() => {
        if (this.pendingCallbacks.has(id)) {
          this.pendingCallbacks.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, 30000);
    });
  }

  private rejectAll(err: Error) {
    for (const cb of this.pendingCallbacks.values()) {
      cb.reject(err);
    }
    this.pendingCallbacks.clear();
  }

  async init(extend: string): Promise<void> {
    await this.ensureProcess();
    if (this.loaded && extend) {
      await this.rpc('init', [this.key, extend]);
    }
  }

  async homeContent(filter: boolean): Promise<string> {
    await this.ensureProcess();
    return await this.rpc('homeContent', [this.key, filter]);
  }

  async homeVideoContent(): Promise<string> {
    await this.ensureProcess();
    return await this.rpc('homeVideoContent', [this.key]);
  }

  async categoryContent(
    tid: string,
    pg: string,
    filter: boolean,
    extend: Record<string, string>,
  ): Promise<string> {
    await this.ensureProcess();
    return await this.rpc('categoryContent', [
      this.key,
      tid,
      pg,
      filter,
      JSON.stringify(extend),
    ]);
  }

  async detailContent(ids: string[]): Promise<string> {
    await this.ensureProcess();
    return await this.rpc('detailContent', [this.key, ids]);
  }

  async searchContent(
    key: string,
    quick: boolean,
    pg?: string,
  ): Promise<string> {
    await this.ensureProcess();
    return await this.rpc('searchContent', [this.key, key, quick, pg || '']);
  }

  async playerContent(
    flag: string,
    id: string,
    vipFlags: string[],
  ): Promise<string> {
    await this.ensureProcess();
    return await this.rpc('playerContent', [this.key, flag, id, vipFlags]);
  }

  async isVideoFormat(url: string): Promise<boolean> {
    await this.ensureProcess();
    return await this.rpc('isVideoFormat', [this.key, url]);
  }

  async manualVideoCheck(): Promise<boolean> {
    await this.ensureProcess();
    return await this.rpc('manualVideoCheck', [this.key]);
  }

  async action(actionId: string, actionData: any): Promise<string> {
    await this.ensureProcess();
    return await this.rpc('action', [
      this.key,
      actionId,
      JSON.stringify(actionData),
    ]);
  }

  destroy(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.loaded = false;
    this.rejectAll(new Error('Spider destroyed'));
  }

  async callLocalProxy(params: Record<string, string>): Promise<any> {
    await this.ensureProcess();
    return await this.rpc('localProxy', [this.key, params]);
  }
}
