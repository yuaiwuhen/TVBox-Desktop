package com.github.catvod.spider;

/**
 * Stub for com.github.catvod.spider.Proxy.
 * Some spiders (e.g. SP360) call Proxy.getUrl() to get the proxy URL.
 */
public class Proxy {
    private static int port = 9978;

    public static String getUrl() {
        return "http://127.0.0.1:" + port;
    }

    public static int getPort() {
        return port;
    }

    public static String getOriginUrl() {
        return "http://127.0.0.1:" + port;
    }

    /**
     * Returns the local proxy URL for XYQHiker/XYQBiu spiders.
     * Called during spider init to build request URLs through the proxy.
     */
    public static String localProxyUrl() {
        return "http://127.0.0.1:" + port;
    }

    public static Object[] proxy(java.util.Map<String, String> params) {
        // Delegate to ProxyOrigin.proxy if available
        try {
            Class<?> proxyOrigin = Class.forName("com.github.catvod.spider.ProxyOrigin");
            java.lang.reflect.Method proxyMethod = proxyOrigin.getMethod("proxy", java.util.Map.class);
            return (Object[]) proxyMethod.invoke(null, params);
        } catch (Exception e) {
            System.err.println("[stub spider.Proxy] ProxyOrigin.proxy failed: " + e.getMessage());
            return new Object[0];
        }
    }
}