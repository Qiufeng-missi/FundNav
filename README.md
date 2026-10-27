# 净值收录器（Android 版）

基金周净值统计软件的原生 Android 应用。把每周提供的《量化周刊》PDF 导入后，自动按 6 大策略类（500指增/300指增/1000指增/对冲/选股/全天候）分别生成「周净值统计表」与「累计收益前十走势图」，并支持一键「另存为 Excel」。

> 本工程与「xueya 项目」出包方式完全一致：**推送到 GitHub 后，由 GitHub Actions 在云端编译出 `app-debug.apk`**，无需本机安装 JDK / Android SDK / Gradle。

## 功能
- 📥 **提供本周 PDF**：点击按钮唤起系统文件选择器，导入《国联民生·GoodLuck量化周刊》类 PDF。
- 📊 **周净值统计表**：按 6 类指数分别制表，每个基金两列（本周收益 / 累计收益），涨红跌绿（A股惯例），表头跨两行。
- 📈 **累计收益走势图**：每类取累计收益前 10 名，同期归一开始比较；虚线为对标指数。单周数据为条形图，多周自动切换为折线图。
- 💾 **另存为 Excel**：通过系统分享/保存导出多 sheet（总览 + 6 分类）的 .xlsx。
- 💾 **本地持久化**：数据存于应用本地（localStorage），下次打开仍在。

## 架构
- 原生 Android（Gradle + WebView）外壳：`app/src/main/java/.../MainActivity.java`
  - 加载 `assets/www/index.html`（纯前端，离线可用）
  - `<input type=file>` 唤起系统选择器（用于导入 PDF）
  - `JsBridge.saveFile` 调系统分享/保存（用于导出 Excel）
- 前端：`assets/www/` 下 `index.html` / `styles.css` / `app.js`（合并自 parser/storage/excel/main，无构建步骤）
- 第三方库（构建时由 CI 下载进 `assets/www/lib/`）：
  - `pdfjs-dist` v3.11.174（PDF 解析，主线程回退）
  - `xlsx` 0.18.5（Excel 导出）

## 出包（与 xueya 同样方式）
1. 把本目录推送到你的 GitHub 仓库（例如 `Qiufeng-missi/FundNav`）。
2. 在仓库 **Actions → Build APK** 手动触发，或任意分支 push 即自动触发。
3. 构建完成后在 **Artifacts** 下载 `fund-nav-debug.apk`。
4. 手机安装该 APK 即可使用（Android 8+）。

### 本地构建（可选，需自备 JDK17 + Android SDK）
```bash
gradle wrapper --gradle-version 8.2
./gradlew assembleDebug
# 产物：app/build/outputs/apk/debug/app-debug.apk
```

## 与 xueya 出包的区别点
- 仅新增一步「下载 web 库」：因前端依赖 pdf.js / xlsx，CI 在 `assembleDebug` 前把它们下载进 `assets/www/lib/`。
- 其余完全沿用 xueya 的 `ubuntu-22.04 + JDK17 + 手动装 Android SDK + gradle wrapper + assembleDebug + 上传 APK`。
