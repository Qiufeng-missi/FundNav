package com.example.fundnav;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.Base64;

public class MainActivity extends Activity {

    private static final int REQ_FILE = 9001;
    private WebView wv;
    private ValueCallback<Uri[]> uploadCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        wv = new WebView(this);
        setContentView(wv);

        WebSettings ws = wv.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);       // localStorage 持久化（基金数据存本地）
        ws.setDatabaseEnabled(true);
        ws.setAllowFileAccess(true);
        ws.setAllowContentAccess(true);
        ws.setSupportZoom(false);
        ws.setUseWideViewPort(true);
        ws.setLoadWithOverviewMode(true);

        wv.setWebViewClient(new WebViewClient());
        wv.setWebChromeClient(new WebChromeClient() {
            // 让网页里的 <input type="file"> 能打开系统文件选择器（用于“提供本周 PDF”）
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback,
                                             FileChooserParams fileChooserParams) {
                if (uploadCallback != null) {
                    uploadCallback.onReceiveValue(null);
                }
                uploadCallback = filePathCallback;
                Intent intent = fileChooserParams.createIntent();
                try {
                    startActivityForResult(intent, REQ_FILE);
                } catch (Exception e) {
                    uploadCallback = null;
                    filePathCallback.onReceiveValue(null);
                    return false;
                }
                return true;
            }
        });
        wv.addJavascriptInterface(new JsBridge(), "Android");
        // 加载内置的基金净值前端（纯本地，离线可用）
        wv.loadUrl("file:///android_asset/www/index.html");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE && uploadCallback != null) {
            if (resultCode == RESULT_OK && data != null) {
                uploadCallback.onReceiveValue(new Uri[]{data.getData()});
            } else {
                uploadCallback.onReceiveValue(null);
            }
            uploadCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /** 供网页调用的原生能力：把 base64 数据写成文件并唤起系统分享/保存（用于“另存为 Excel”） */
    private class JsBridge {

        @JavascriptInterface
        public void saveFile(final String name, final String base64, final String mime) {
            try {
                byte[] data = Base64.getDecoder().decode(base64);
                File dir = new File(getCacheDir(), "shared");
                dir.mkdirs();
                File file = new File(dir, name);
                OutputStream os = new FileOutputStream(file);
                os.write(data);
                os.close();

                final Uri uri = FileProvider.getUriForFile(
                        MainActivity.this, "com.example.fundnav.fileprovider", file);

                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        Intent share = new Intent(Intent.ACTION_SEND);
                        share.setType(mime != null ? mime : "application/octet-stream");
                        share.putExtra(Intent.EXTRA_STREAM, uri);
                        share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        startActivity(Intent.createChooser(share, "导出 / 保存「" + name + "」"));
                        Toast.makeText(MainActivity.this, "已生成：" + name + "，可选择保存位置", Toast.LENGTH_LONG).show();
                    }
                });
            } catch (final Exception e) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        Toast.makeText(MainActivity.this, "导出失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
                    }
                });
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (wv != null && wv.canGoBack()) {
            wv.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
