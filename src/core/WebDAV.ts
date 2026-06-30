import axios from 'axios';
import type { AxiosInstance } from 'axios';

export interface WebDAVConfig {
    url: string;
    username?: string;
    password?: string;
}

/**
 * TVBox standard WebDAV backup feature implementation
 */
export class WebDAV {
    private client: AxiosInstance;

    constructor(config: WebDAVConfig) {
        const auth = config.username && config.password ? {
            username: config.username,
            password: config.password
        } : undefined;

        this.client = axios.create({
            baseURL: config.url,
            auth: auth,
            headers: {
                'Content-Type': 'application/json'
            }
        });
    }

    async testConnection(): Promise<boolean> {
        try {
            await this.client.request({ method: 'PROPFIND', url: '/' });
            return true;
        } catch (e) {
            return false;
        }
    }

    async backup(filename: string, data: any): Promise<boolean> {
        try {
            const content = JSON.stringify(data, null, 2);
            await this.client.put(`/${filename}`, content);
            return true;
        } catch (e) {
            console.error("WebDAV backup failed:", e);
            return false;
        }
    }

    async restore(filename: string): Promise<any | null> {
        try {
            const { data } = await this.client.get(`/${filename}`);
            return data;
        } catch (e) {
            console.error("WebDAV restore failed:", e);
            return null;
        }
    }
}
