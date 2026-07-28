package com.wexfnw.libso;

import android.content.Context;
import java.io.File;
import java.net.URL;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.FileWriter;
import java.io.PrintWriter;
import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;

/**
 * Stub for com.wexfnw.libso.LoadNiMa.
 *
 * The real class loads libLoadNiMa.so (ARM native library) in its static
 * initializer and exposes native methods. The .so cannot run on Windows JVM,
 * so we stub the class and call unidbg loader via subprocess to decode data.
 *
 * Source isolation: Each source has its own native library cache.
 * The decode method calls unidbg-loader.jar subprocess to simulate the native
 * method.
 */
public class LoadNiMa {

    public static boolean contains(String s) {
        return false;
    }

    private static String initArg = "";
    private static boolean initCalled = false;

    /**
     * Find the unidbg loader JAR.
     * Search order:
     * 1. System property "tvbox.unidbg.jar" (set by JarLoader.ts)
     * 2. Same directory as this stub JAR (packaged mode: resources/tools/)
     * 3. Dev path: tools/unidbg-loader/target/unidbg-loader-1.0.0.jar
     */
    private static File findUnidbgJar() {
        // 1. System property (most reliable — JarLoader.ts sets this)
        String propPath = System.getProperty("tvbox.unidbg.jar");
        if (propPath != null && !propPath.isEmpty()) {
            File f = new File(propPath);
            if (f.exists()) {
                System.out.println("[LoadNiMa-stub] Unidbg JAR from system property: " + f);
                return f;
            }
        }

        // 2. Same directory as this stub JAR
        try {
            URL loc = LoadNiMa.class.getProtectionDomain().getCodeSource().getLocation();
            if (loc != null) {
                File stubJar = new File(loc.toURI());
                File toolsDir = stubJar.getParentFile();
                if (toolsDir != null) {
                    // Packaged: unidbg-loader-1.0.0-shaded.jar
                    File shaded = new File(toolsDir, "unidbg-loader-1.0.0-shaded.jar");
                    if (shaded.exists()) {
                        System.out.println("[LoadNiMa-stub] Unidbg JAR (shaded) from stub dir: " + shaded);
                        return shaded;
                    }
                    // Dev: unidbg-loader-1.0.0.jar
                    File plain = new File(toolsDir, "unidbg-loader-1.0.0.jar");
                    if (plain.exists()) {
                        System.out.println("[LoadNiMa-stub] Unidbg JAR from stub dir: " + plain);
                        return plain;
                    }
                }
            }
        } catch (Exception e) {
            System.err.println("[LoadNiMa-stub] Could not determine stub JAR location: " + e.getMessage());
        }

        // 3. Dev fallback
        String projectRoot = System.getProperty("user.dir");
        if (projectRoot == null)
            projectRoot = ".";
        File devJar = new File(projectRoot, "tools/unidbg-loader/target/unidbg-loader-1.0.0.jar");
        if (devJar.exists()) {
            System.out.println("[LoadNiMa-stub] Unidbg JAR from dev path: " + devJar);
            return devJar;
        }

        return null;
    }

    /**
     * Find the java executable.
     * Search order:
     * 1. System property "tvbox.java.exe" (bundled JRE in packaged mode)
     * 2. java.home/bin/java
     * 3. "java" (on PATH)
     */
    private static String findJavaExe() {
        String propPath = System.getProperty("tvbox.java.exe");
        if (propPath != null && !propPath.isEmpty() && new File(propPath).exists()) {
            return propPath;
        }
        String javaHome = System.getProperty("java.home");
        if (javaHome != null) {
            File exe = new File(javaHome, "bin/java.exe");
            if (!exe.exists())
                exe = new File(javaHome, "bin/java");
            if (exe.exists())
                return exe.getAbsolutePath();
        }
        return "java";
    }

    /**
     * File-based logger — System.out may not be visible in Electron's captured
     * logs. Write to a temp file so we can verify the stub is actually called.
     */
    private static void logToFile(String msg) {
        try {
            String logPath = System.getProperty("tvbox.loadnima.logfile");
            if (logPath == null || logPath.isEmpty()) {
                logPath = new File(System.getProperty("java.io.tmpdir", "/tmp"), "loadnima-stub.log").getAbsolutePath();
            }
            PrintWriter pw = new PrintWriter(new FileWriter(logPath, true));
            pw.println("[" + System.currentTimeMillis() + "] " + msg);
            pw.close();
        } catch (Exception e) {
            // ignore
        }
    }

    /**
     * Try AES-128-CBC decryption fallback (used when unidbg fails).
     *
     * This handles WexWenCai (and similar wexfnw spiders) where the encrypted
     * response is AES-128-CBC with:
     * Key = YYYYMMDD + "woshini8" (16 bytes, date-based)
     * IV = "Wexfnwshinidieha" (16 bytes, capital W)
     *
     * The input is base64-encoded ciphertext. The output is a UTF-8 string
     * (e.g. a 40-char hex sign for WexWenCai hotSearch).
     *
     * Returns the decrypted string, or null if decryption fails or output
     * is not printable ASCII.
     */
    private static String tryWenCaiAESFallback(String base64Input) {
        try {
            byte[] encrypted = java.util.Base64.getDecoder().decode(base64Input.trim());
            if (encrypted.length == 0 || encrypted.length % 16 != 0) {
                return null;
            }

            // Date-based key: YYYYMMDD + "woshini8"
            LocalDate now = LocalDate.now();
            String dateStr = now.format(DateTimeFormatter.ofPattern("yyyyMMdd"));
            String keyStr = dateStr + "woshini8";
            byte[] keyBytes = keyStr.getBytes(StandardCharsets.UTF_8);
            byte[] ivBytes = "Wexfnwshinidieha".getBytes(StandardCharsets.UTF_8);

            SecretKeySpec keySpec = new SecretKeySpec(keyBytes, "AES");
            IvParameterSpec ivSpec = new IvParameterSpec(ivBytes);
            Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
            cipher.init(Cipher.DECRYPT_MODE, keySpec, ivSpec);
            byte[] decrypted = cipher.doFinal(encrypted);

            // Validate: output should be printable ASCII (sign, JSON, etc.)
            String result = new String(decrypted, StandardCharsets.UTF_8).trim();
            if (result.isEmpty()) {
                return null;
            }
            for (int i = 0; i < result.length(); i++) {
                char c = result.charAt(i);
                if (c < 0x20 && c != '\r' && c != '\n' && c != '\t') {
                    // Control character — likely garbage
                    return null;
                }
            }
            return result;
        } catch (Exception e) {
            logToFile("WenCai AES fallback failed: " + e.getMessage());
            return null;
        }
    }

    /**
     * Decode encrypted data via unidbg subprocess.
     */
    public static String decode(Context ctx, String s) {
        System.out.println("[LoadNiMa-stub] ========== decode called ==========");
        System.out.println("[LoadNiMa-stub] input length: " + s.length());
        System.out.println("[LoadNiMa-stub] input (full): " + s);
        logToFile("decode called, input length=" + s.length() + ", input=" + s);

        try {
            // Get native library path from system property (set by JarLoader.ts)
            String nativeLibPath = System.getProperty("tvbox.nativelib.WexGuaZiGuard");
            if (nativeLibPath == null || nativeLibPath.isEmpty()) {
                String projectRoot = System.getProperty("user.dir");
                if (projectRoot == null)
                    projectRoot = ".";
                nativeLibPath = new File(projectRoot, "jar_cache/WexGuaZiGuard/libLoadNiMa.so").getAbsolutePath();
                System.out.println("[LoadNiMa-stub] Using default native lib path: " + nativeLibPath);
            } else {
                System.out.println("[LoadNiMa-stub] Using native lib path from System property: " + nativeLibPath);
            }

            File nativeLibFile = new File(nativeLibPath);
            if (!nativeLibFile.exists()) {
                System.err.println("[LoadNiMa-stub] Native lib not found: " + nativeLibPath);
                return s;
            }

            File unidbgJar = findUnidbgJar();
            if (unidbgJar == null) {
                System.err.println("[LoadNiMa-stub] Unidbg JAR not found anywhere");
                return s;
            }

            String javaExe = findJavaExe();
            System.out.println("[LoadNiMa-stub] Calling unidbg loader: " + unidbgJar.getAbsolutePath());
            System.out.println("[LoadNiMa-stub] Native lib: " + nativeLibPath);
            System.out.println("[LoadNiMa-stub] Java exe: " + javaExe);
            System.out.println("[LoadNiMa-stub] initCalled=" + initCalled + ", initArg.length=" + initArg.length());

            // Determine the api_url to pass to the unidbg loader.
            // Priority: init() argument > system property > empty (no init)
            String apiUrl = initCalled ? initArg : System.getProperty("tvbox.api_url.WexGuaZiGuard");
            if (apiUrl == null)
                apiUrl = "";
            System.out.println("[LoadNiMa-stub] api_url for unidbg: " + apiUrl);

            ProcessBuilder pb = new ProcessBuilder(
                    javaExe,
                    "-cp", unidbgJar.getAbsolutePath(),
                    "com.tvbox.LoadNiMaDecryptor",
                    nativeLibPath,
                    s,
                    apiUrl);

            pb.redirectErrorStream(false);
            Process process = pb.start();

            StringBuilder stdOut = new StringBuilder();
            StringBuilder stdErr = new StringBuilder();

            Thread stdOutThread = new Thread(() -> {
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        stdOut.append(line).append("\n");
                    }
                } catch (Exception e) {
                    stdErr.append("stdout read error: ").append(e.getMessage()).append("\n");
                }
            });

            Thread stdErrThread = new Thread(() -> {
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getErrorStream()))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        stdErr.append(line).append("\n");
                    }
                } catch (Exception e) {
                    stdErr.append("stderr read error: ").append(e.getMessage()).append("\n");
                }
            });

            stdOutThread.start();
            stdErrThread.start();

            boolean finished = process.waitFor(120, java.util.concurrent.TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                stdOutThread.interrupt();
                stdErrThread.interrupt();
                System.err.println("[LoadNiMa-stub] Decode timeout (120s)");
                System.err.println("[LoadNiMa-stub] Partial stderr: " + stdErr.toString().trim());
                logToFile("unidbg timeout, trying AES fallback");
                String aesResult = tryWenCaiAESFallback(s);
                if (aesResult != null) {
                    System.out.println("[LoadNiMa-stub] ✅ AES fallback success (after timeout), output length: "
                            + aesResult.length());
                    logToFile("AES fallback success after timeout, output length=" + aesResult.length());
                    return aesResult;
                }
                return s;
            }

            stdOutThread.join(5000);
            stdErrThread.join(5000);

            int exitCode = process.exitValue();
            System.err.println("[LoadNiMa-stub] Unidbg exit code: " + exitCode);
            System.err.println("[LoadNiMa-stub] Unidbg stderr: " + stdErr.toString().trim());
            logToFile("unidbg exit code=" + exitCode + ", stderr=" + stdErr.toString().trim());

            String decodedResult = null;
            if (exitCode == 0) {
                String raw = stdOut.toString().trim();
                if (raw.length() > 0) {
                    decodedResult = raw;
                }
            }

            // Check if unidbg actually decrypted (failed cases: empty result,
            // result equals input, or empty-JSON placeholder). For WexWenCai,
            // unidbg's decrypt_core returns input unchanged — try AES fallback.
            boolean unidbgFailed = decodedResult == null
                    || decodedResult.equals(s)
                    || decodedResult.equals("{\"class\":[],\"list\":[]}")
                    || decodedResult.isEmpty();
            if (unidbgFailed) {
                System.err.println("[LoadNiMa-stub] unidbg did not decrypt, trying WenCai AES fallback");
                logToFile("unidbg did not decrypt (exit=" + exitCode
                        + ", resultLen=" + (decodedResult == null ? 0 : decodedResult.length())
                        + "), trying AES fallback");
                String aesResult = tryWenCaiAESFallback(s);
                if (aesResult != null) {
                    System.out.println("[LoadNiMa-stub] ✅ AES fallback success, output length: " + aesResult.length());
                    System.out.println("[LoadNiMa-stub] AES output (full): " + aesResult);
                    System.out.println("[LoadNiMa-stub] ========== decode end ==========");
                    logToFile("AES fallback success, output length=" + aesResult.length());
                    return aesResult;
                }
                System.err.println("[LoadNiMa-stub] AES fallback also failed");
                logToFile("AES fallback also failed");
                // Return empty JSON for spider-compatibility (WexGuaZi expects JSON)
                return "{\"class\":[],\"list\":[]}";
            }

            System.out.println("[LoadNiMa-stub] Decode success (unidbg), output length: " + decodedResult.length());
            System.out.println("[LoadNiMa-stub] output (full): " + decodedResult);
            System.out.println("[LoadNiMa-stub] ========== decode end ==========");
            logToFile("decode success (unidbg), output length=" + decodedResult.length());
            return decodedResult;

        } catch (Exception e) {
            System.err.println("[LoadNiMa-stub] ❌ Decode failed: " + e.getMessage());
            e.printStackTrace();
            logToFile("decode exception: " + e.getMessage());
            return s; // Fallback to stub (return original input)
        }
    }

    public static String decodedata(Context ctx, String s) {
        // Similar to decode, but for data decryption
        return decode(ctx, s);
    }

    public static void init(String s) {
        initArg = s == null ? "" : s;
        initCalled = true;
        System.out.println("[LoadNiMa-stub] init called with arg (length=" + initArg.length() + "): "
                + initArg.substring(0, Math.min(200, initArg.length())));
    }

    public static File getCache(String s) {
        return new File(System.getProperty("java.io.tmpdir", "/tmp"), s);
    }
}
