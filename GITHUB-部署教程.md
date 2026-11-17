# 上传到 GitHub 并开启免费在线网址

这套源码上传到你自己的 GitHub 后，可以免费获得一个长期稳定的在线网址（GitHub Pages），
完全由你自己掌控，不依赖任何第三方平台的托管服务。

## 第一步：上传源码到 GitHub

### 方式一：网页上传（最简单，不用装任何软件）

1. 打开 https://github.com 并登录
2. 点右上角 **「+」** → **「New repository」**（新建仓库）
3. 填写：
   - Repository name（仓库名）：`ai-exam-assistant`（或任意英文名）
   - 选 **Public**（公开，这样免费网页才能用）
   - **不要**勾选 "Add a README file" 等任何选项（保持空仓库）
   - 点 **「Create repository」**
4. 在接下来的页面里，点 **「uploading an existing file」**（上传已有文件）
5. 把本压缩包 **解压**，把里面的 `exam-ai-shell` 文件夹**整个拖进上传框**
   > 注意：要上传文件夹里的内容，让 `index.html` 位于仓库根目录
6. 拉到页面底部，填提交信息如 `initial commit`，点 **「Commit changes」**

### 方式二：用 Git 命令（如果你熟悉）

```bash
git init
git add .
git commit -m "initial commit"
git branch -M main
git remote add origin https://github.com/你的用户名/ai-exam-assistant.git
git push -u origin main
```

## 第二步：开启免费在线网址（GitHub Pages）

1. 进入你的仓库页面，点顶部 **「Settings」**（设置）
2. 左侧菜单点 **「Pages」**
3. Build and deployment 部分：
   - Source 选择 **「Deploy from a branch」**
   - Branch 选择 **`main`**，文件夹选 **`/ (root)`**
   - 点 **「Save」**
4. 等 1-2 分钟刷新页面，顶部会出现一个网址，类似：
   `https://你的用户名.github.io/ai-exam-assistant/`
5. 打开这个网址就是你的应用了！

## 第三步：手机上当 App 用

用手机浏览器打开上面的网址 → 菜单 → **「添加到主屏幕」**，
桌面就多一个图标，点开全屏运行，和真 App 一样。

## 重要提醒

1. **API Key 不进 GitHub**：你的 DeepSeek API Key 只存在手机浏览器本地，
   源码里没有写死任何 Key，所以公开仓库是安全的。
2. **数据也不在 GitHub**：对话和记忆都存在你手机本地，仓库里只有程序代码。
3. **网址是你的**：`你的用户名.github.io` 这个网址永久跟着你的账号，
   只要 GitHub 账号在，网址就在，完全自己掌控。
4. **想更新内容**：在 GitHub 网页上改文件，或重新上传，Pages 会自动更新网址。

## 关于鸿蒙原生版

`harmony/` 目录是 HarmonyOS NEXT 的 ArkTS 工程骨架，
用华为 DevEco Studio 打开可以编译成真正的 .hap 安装包。
网页版（根目录文件）已经在浏览器验证可用，是推荐先用的方案。
