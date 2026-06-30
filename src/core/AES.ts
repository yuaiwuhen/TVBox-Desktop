import CryptoJS from 'crypto-js';

export class AES {
    static ECB(data: string, key: string): string {
        const keyHex = CryptoJS.enc.Utf8.parse(key.padEnd(16, '0').substring(0, 16));
        const decrypted = CryptoJS.AES.decrypt(data, keyHex, {
            mode: CryptoJS.mode.ECB,
            padding: CryptoJS.pad.Pkcs7
        });
        return decrypted.toString(CryptoJS.enc.Utf8);
    }

    static CBC(data: string, key: string, iv: string): string {
        const keyHex = CryptoJS.enc.Utf8.parse(key.padEnd(16, '0').substring(0, 16));
        const ivHex = CryptoJS.enc.Utf8.parse(iv.padEnd(16, '0').substring(0, 16));
        const decrypted = CryptoJS.AES.decrypt(
            { ciphertext: CryptoJS.enc.Hex.parse(data) } as any,
            keyHex,
            { mode: CryptoJS.mode.CBC, iv: ivHex, padding: CryptoJS.pad.Pkcs7 }
        );
        return decrypted.toString(CryptoJS.enc.Utf8);
    }

    static isJson(str: string): boolean {
        try {
            const obj = JSON.parse(str);
            return typeof obj === 'object' && obj !== null;
        } catch {
            return false;
        }
    }

    static toBytes(hex: string): number[] {
        const bytes: number[] = [];
        for (let i = 0; i < hex.length; i += 2) {
            bytes.push(parseInt(hex.substring(i, i + 2), 16));
        }
        return bytes;
    }

    static rightPadding(str: string, pad: string, len: number): string {
        while (str.length < len) str += pad;
        return str.substring(0, len);
    }
}
