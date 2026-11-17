# 考试规划官 · 自托管版

一个接入你自己 DeepSeek API 的 **AI 聊天助手 + 考试规划工具**，**带跨数月/数年的长期记忆**。默认就是通用自由聊天（什么都能聊），需要时可以切到「考试规划」模式。数据全部存在你自己的设备里，不上传任何第三方服务器。

## 两种对话模式

| 模式 | 用途 | 对话存储 |
|------|------|---------|
| 💬 **自由聊天**（默认） | 学习、工作、生活、答疑、写作、脑暴，什么都能聊 | 独立分区 |
| 🎯 **考试规划** | 围绕考试排计划、盯进度、管科目 | 按每场考试独立分区 |

在对话页顶部一键切换。两种模式的**对话历史互相隔离**，但**长期记忆档案是共享的**——你在自由聊天里告诉它的事（比如你的目标、习惯、偏好），切到考试模式它也记得，反之亦然。在「考试」页选中某场考试会自动进入考试规划模式。

提供两套实现：

| 方案 | 说明 | 推荐度 |
|------|------|--------|
| **PWA 网页版**（`index.html` 等根目录文件） | 浏览器打开即用，可"添加到主屏幕"当 App，我现在就能帮你预览 | ⭐ 立刻可用 |
| **鸿蒙原生版**（`harmony/` 目录） | HarmonyOS NEXT ArkTS 工程，用 DevEco Studio 编译成真正的 .hap 安装包 | 想要纯原生时 |

---

## 一、先拿到 DeepSeek API Key（两种方案通用）

1. 打开 <https://platform.deepseek.com/api_keys>，注册登录
2. 创建 API Key，**只显示一次，立刻复制保存**
3. 充 10 元（够用很久）

> ⚠️ 网页版 Key 只存在你手机的浏览器本地（localStorage），不会发给任何第三方。但浏览器端直连 API 会暴露 Key 于网络请求中——自用没问题，别把它填进公网共享的部署里。

**成本对比**：你现在每月 90 元。DeepSeek 当前价格（2026-11）：

| 模型 | 输入 / 百万 token | 输出 / 百万 token | 我的建议 |
|------|------------------|------------------|---------|
| `deepseek-flash` | 约 ¥1 | 约 ¥2 | ✅ 日常规划够用，超便宜 |
| `deepseek-v4-pro` | 约 ¥3 | 约 ¥6 | 复杂推理时切换 |

每天聊几十条，一个月通常也就**几毛到几块钱**，比 90 元省得多。

> API 有变化：老的 `deepseek-chat` / `deepseek-reasoner` 模型名已于 2026/07/24 弃用，本项目已使用最新的 `deepseek-flash` / `deepseek-v4-pro`，并带 `thinking` 参数。

---

## 二、方案 A：PWA 网页版（推荐先用这个）

### 本地预览（电脑上）
```bash
cd exam-ai-shell
python3 -m http.server 8899
# 浏览器打开 http://localhost:8899
```
> 必须用 http 服务打开，不能直接双击 index.html（Service Worker 和 IndexedDB 需要 http 环境）。

### 放到手机上当 App 用
PWA 需要一个 **https 地址**（localhost 手机访问不了）。三种办法任选：

1. **让我帮你发布**：我可以用「发布为应用」功能把它部署成在线链接，你手机浏览器打开后 → 菜单 → 「添加到主屏幕」，就有独立图标、全屏运行，和 App 一样。
2. **自己部署**：传到任意静态托管（Vercel / Netlify / GitHub Pages / 你的服务器），用 https 访问后添加到主屏幕。
3. **局域网临时用**：电脑和手机同一 WiFi，用 `https` 反代或内网穿透（如 Cloudflare Tunnel）暴露本地服务。

### 首次配置
1. 打开应用 → 「设置」页
2. 填 API Key，模型保持 `deepseek-flash`
3. 点「测试 API 连接」，出现 ✅ 即成功
4. 回到「考试」页添加考试，选中它
5. 回「对话」页开始用

---

## 三、长期记忆是怎么做到"记住几百天"的

DeepSeek API 本身没有记忆。本项目用**分层记忆**解决：

```
第 1 层  核心档案     考试目标、科目进度、你的偏好与约定 → 每次对话必带
第 2 层  滚动摘要     旧对话每 30 条由 AI 压缩成一段摘要 → 带最近 3 段
第 3 层  相关检索     从全量归档里按关键词找出相关历史片段 → 按需带 5 条
第 4 层  全量归档     所有原始消息存 IndexedDB，永不删除，可导出/导入
第 5 层  最近对话     最近 N 条原文（设置里可调，默认 12）
```

每次请求只把「档案 + 摘要 + 相关内容 + 最近对话」发给 API，既能跨几百天保持连贯，又不会把全部历史一股脑塞进去烧 token。

- 「记忆」页可以随时查看档案和摘要，点「立即整理」手动压缩。
- 换手机：记忆页「导出全部数据」→ 新设备「导入数据」即可无缝迁移。

---

## 四、方案 B：鸿蒙原生版（可选）

目录 `harmony/` 是一个标准的 HarmonyOS NEXT（API 12）工程骨架：

```
harmony/
├── build-profile.json5          # 工程级构建配置
├── oh-package.json5 / hvigorfile.ts
├── AppScope/                    # 应用图标、名称
└── entry/
    ├── src/main/module.json5    # 模块配置（已声明 INTERNET 权限）
    └── src/main/ets/
        ├── entryability/EntryAbility.ets   # 应用入口
        ├── pages/Index.ets                 # 主界面（四个页签）
        └── common/
            ├── Types.ets          # 数据模型
            ├── Store.ets          # 持久化（preferences）
            └── DeepSeekService.ets# API 流式调用 + 分层记忆 + 记忆整理
```

### 编译步骤
1. 安装 **DevEco Studio**（华为开发者官网下载）
2. File → Open，选择 `harmony/` 目录
3. 首次打开会自动 Sync（下载依赖）
4. 登录后配置签名：File → Project Structure → Signing Configs，勾选 Automatically generate signature
5. 用真机（HarmonyOS NEXT）或模拟器运行
6. 构建 HAP：Build → Build HAP(s)

### 已知简化点（骨架阶段）
- 消息归档用 `preferences` 存 JSON 字符串。**消息量大后（几千条以上）建议换成 `relationalStore` 关系型数据库**，性能更好——接口已在 `Store.ets` 里封装好，替换实现即可。
- 流式解析用了 `@ohos.net.http` 的 `requestInStream`，需在真机（API 12+）上运行验证。
- ArkTS 语法较严格，若 DevEco 报类型错误，多为 Object/Record 断言需按提示微调。

> 原生版本我无法在当前环境编译验证（缺少 HarmonyOS SDK），它是一份结构完整、逻辑真实、可直接在此基础上开发的骨架。PWA 版则是已验证可运行的成品。

---

## 五、文件说明

| 文件 | 作用 |
|------|------|
| `index.html` | PWA 页面结构 |
| `style.css` | 移动端样式，适配鸿蒙/安卓/iOS，支持深色模式 |
| `db.js` | IndexedDB 持久化层 |
| `app.js` | 主逻辑：DeepSeek 流式接入、分层记忆、考试管理 |
| `manifest.json` / `sw.js` | PWA 配置与离线缓存 |
| `icon-*.png` | 应用图标 |
| `harmony/` | 鸿蒙原生 ArkTS 工程骨架 |

所有数据属于你自己，随时可导出。
