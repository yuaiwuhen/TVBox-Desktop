/**
 * JarLoader - Stub
 *
 * Java bridge has been removed as part of Docker migration.
 * This stub provides minimal API surface so that dependent modules
 * (pan services, proxy server) can still import without breaking.
 *
 * NOTE: All pan-related functionality that previously relied on the Java
 * bridge will now return empty/null results. These features are temporarily
 * disabled. JAR proxy execution is handled on the Android side (MuMu).
 */

const stubJava = {
  importClass: (className: string) => {
    console.warn(
      `[JarLoader stub] importClass(${className}) called - Java bridge is disabled`,
    );
    return class {};
  },
  newInstance: (cls: any, ...args: any[]) => {
    console.warn(
      '[JarLoader stub] newInstance called - Java bridge is disabled',
    );
    return null;
  },
  callMethod: async (...args: any[]) => {
    console.warn(
      '[JarLoader stub] callMethod called - Java bridge is disabled',
    );
    return null;
  },
};

const stubJarLoader: any = {
  java: stubJava,
  proxyInvoke: async (params: any) => {
    console.warn(
      '[JarLoader stub] proxyInvoke called - Java bridge is disabled',
    );
    return { status: 0, mime: 'text/plain', stream: null, headers: {} };
  },
  proxyInvokeAsync: async (params: any) => {
    console.warn(
      '[JarLoader stub] proxyInvokeAsync called - Java bridge is disabled',
    );
    return { status: 0, mime: 'text/plain', stream: null, headers: {} };
  },
  streamJavaToNode: (...args: any[]) => {
    console.warn(
      '[JarLoader stub] streamJavaToNode called - Java bridge is disabled',
    );
    return null;
  },
  getVideoHeadersForUrl: (url: string) => {
    return {};
  },
  isLoaded: () => false,
  loadJar: async (...args: any[]) => {
    console.warn('[JarLoader stub] loadJar called - Java bridge is disabled');
    return false;
  },
};

export const jarLoader = stubJarLoader;

export function registerJarLoaderIPC(): void {
  console.warn(
    '[JarLoader stub] registerJarLoaderIPC called - Java bridge is disabled',
  );
  // No-op
}

