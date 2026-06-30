import { describe, it, expect } from 'vitest';
import { ConfigParser } from '../src/core/ConfigParser';

describe('ConfigParser', () => {
    it('should parse basic config correctly', async () => {
        const parser = new ConfigParser();
        
        // Mocking axios get via a simple spy/mock or testing the logic directly
        // We'll test with a direct JSON string to avoid HTTP calls in test
        const mockJson = {
            sites: [
                { key: "site1", name: "Site 1", type: 3, api: "csp_Site1" }
            ]
        };
        
        // Override the load method behavior for the test
        parser.config = mockJson as any;
        
        const sites = parser.getSites();
        expect(sites.length).toBe(1);
        expect(sites[0].name).toBe("Site 1");
        
        const site1 = parser.getSite("site1");
        expect(site1).toBeDefined();
        expect(site1?.api).toBe("csp_Site1");
    });
});
