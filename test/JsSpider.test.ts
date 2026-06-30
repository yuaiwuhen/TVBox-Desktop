import { describe, it, expect } from 'vitest';
import { JsSpider } from '../src/core/JsSpider';

describe('JsSpider', () => {
    it('should load spider and execute init', async () => {
        const spider = new JsSpider('test-spider');
        
        // Mocking localStorage for the Node.js test environment
        if (typeof global.localStorage === 'undefined') {
            global.localStorage = {
                getItem: () => null,
                setItem: () => {},
                removeItem: () => {},
                clear: () => {},
                length: 0,
                key: () => null
            } as any;
        }

        const code = `
            let inited = false;
            let currentExt = "";
            function init(ext) {
                inited = true;
                currentExt = ext;
            }
            function home(filter) {
                return JSON.stringify({ class: [{ type_id: "1", type_name: "Movie" }] });
            }
            module.exports = { init, home };
        `;

        spider.load(code);
        await spider.init('test-ext');
        
        const homeData = await spider.home(true);
        const parsed = JSON.parse(homeData);
        
        expect(parsed.class[0].type_name).toBe("Movie");
    });
});
