package com.tvbox.spiderserver

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ProgressBar
import androidx.appcompat.app.AppCompatActivity

/**
 * 网页配置中心 WebView。
 *
 * 渲染 jar 自己的网页配置中心（如 wexconfig：/proxy?do=wexconfig）。
 * jar 的 /proxy 由本进程的 SpiderHttpServer 服务，WebView 通过
 * http://127.0.0.1:9978 直接访问；页面内触发的扫码/登录按钮会进一步
 * 走 jar 的弹窗或页面流程，二维码在设备上原生显示，可直接扫码。
 */
class WebConfigActivity : AppCompatActivity() {

    companion object {
        private const val EXTRA_URL = "url"

        /** 打开网页配置中心 */
        fun start(context: android.content.Context, url: String) {
            val intent = Intent(context, WebConfigActivity::class.java)
                .putExtra(EXTRA_URL, url)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
        }
    }

    private lateinit var webView: WebView
    private lateinit var progressBar: ProgressBar

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_web_config)

        progressBar = findViewById(R.id.progressBar)
        webView = findViewById(R.id.webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            loadWithOverviewMode = true
            useWideViewPort = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            cacheMode = WebSettings.LOAD_DEFAULT
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                // 页面内跳转（如扫码登录页）继续在 WebView 内打开，保持 jar 会话
                return false
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                progressBar.visibility = View.GONE
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                if (newProgress < 100) {
                    progressBar.visibility = View.VISIBLE
                } else {
                    progressBar.visibility = View.GONE
                }
            }

            override fun onReceivedTitle(view: WebView?, title: String?) {
                supportActionBar?.title = title
            }
        }

        val url = intent.getStringExtra(EXTRA_URL)
        if (url.isNullOrEmpty()) {
            supportActionBar?.title = "网页配置中心"
            webView.loadUrl("http://127.0.0.1:${SpiderHttpServer.PORT}/proxy?do=wexconfig")
        } else {
            webView.loadUrl(url)
        }
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
