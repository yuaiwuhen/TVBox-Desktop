/**
 * Port of Android AdBlocker.java
 * Simple domain-based ad blocker with default ad hosts from ApiConfig.
 */
export class AdBlocker {
    private static adHosts: Set<string> = new Set();

    static isEmpty(): boolean {
        return AdBlocker.adHosts.size === 0;
    }

    static hasHost(host: string): boolean {
        return AdBlocker.adHosts.has(host);
    }

    static addAdHost(host: string): void {
        AdBlocker.adHosts.add(host);
    }

    /**
     * Check if a URL is an ad based on its hostname matching known ad domains.
     * Mirrors Android AdBlocker.isAd logic: lowercase URL, check if any adHost is contained in it.
     */
    static isAd(url: string): boolean {
        const lowerUrl = url.toLowerCase();
        for (const adHost of AdBlocker.adHosts) {
            if (lowerUrl.includes(adHost)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Load the default ad hosts list from Android ApiConfig hardcoded values.
     */
    static loadDefault(): void {
        if (!AdBlocker.isEmpty()) return;

        const defaultHosts: string[] = [
            'mimg.0c1q0l.cn',
            'www.googletagmanager.com',
            'www.google-analytics.com',
            'mc.usihnbcq.cn',
            'mg.g1mm3d.cn',
            'mscs.svaeuzh.cn',
            'cnzz.hhttm.top',
            'tp.vinuxhome.com',
            'cnzz.mmstat.com',
            'www.baihuillq.com',
            's23.cnzz.com',
            'z3.cnzz.com',
            'c.cnzz.com',
            'stj.v1vo.top',
            'z12.cnzz.com',
            'img.mosflower.cn',
            'tips.gamevvip.com',
            'ehwe.yhdtns.com',
            'xdn.cqqc3.com',
            'www.jixunkyy.cn',
            'sp.chemacid.cn',
            'hm.baidu.com',
            's9.cnzz.com',
            'z6.cnzz.com',
            'um.cavuc.com',
            'mav.mavuz.com',
            'wofwk.aoidf3.com',
            'z5.cnzz.com',
            'xc.hubeijieshikj.cn',
            'tj.tianwenhu.com',
            'xg.gars57.cn',
            'k.jinxiuzhilv.com',
            'cdn.bootcss.com',
            'ppl.xunzhuo123.com',
            'xomk.jiangjunmh.top',
            'img.xunzhuo123.com',
            'z1.cnzz.com',
            's13.cnzz.com',
            'xg.huataisangao.cn',
            'z7.cnzz.com',
            'z2.cnzz.com',
            's96.cnzz.com',
            'q11.cnzz.com',
            'thy.dacedsfa.cn',
            'xg.whsbpw.cn',
            's19.cnzz.com',
            'z8.cnzz.com',
            's4.cnzz.com',
            'f5w.as12df.top',
            'ae01.alicdn.com',
            'www.92424.cn',
            'k.wudejia.com',
            'vivovip.mmszxc.top',
            'qiu.xixiqiu.com',
            'cdnjs.hnfenxun.com',
            'cms.qdwght.com',
        ];

        for (const host of defaultHosts) {
            AdBlocker.adHosts.add(host);
        }
    }

    /**
     * Load additional ad hosts from config. Skips duplicates.
     */
    static loadFromConfig(hosts: string[]): void {
        for (const host of hosts) {
            if (!AdBlocker.hasHost(host)) {
                AdBlocker.addAdHost(host);
            }
        }
    }

    static clear(): void {
        AdBlocker.adHosts.clear();
    }
}
