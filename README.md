<h1 align="center">飞速MarkDown</h1>

<p align="center">
  <strong>仅 7MB,免费且强大的 Markdown 编辑 / PDF 阅读工具</strong>
</p>

<p align="center">
  <a href="README.md">简体中文</a> | <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/flyhunterl/flymd/releases/latest"><img src="https://img.shields.io/github/v/release/flyhunterl/flymd" alt="GitHub Release" /></a>
  <a href="https://github.com/flyhunterl/flymd/releases/latest"><img src="https://img.shields.io/github/release-date/flyhunterl/flymd" alt="Release Date" /></a>
  <a href="https://github.com/flyhunterl/flymd/actions/workflows/build.yml"><img src="https://github.com/flyhunterl/flymd/actions/workflows/build.yml/badge.svg" alt="Build Status" /></a>
  <a href="https://github.com/flyhunterl/flymd/stargazers"><img src="https://img.shields.io/github/stars/flyhunterl/flymd" alt="GitHub Stars" /></a>
  <img src="https://img.shields.io/github/downloads/flyhunterl/flymd/total" alt="GitHub Downloads" />
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/flyhunterl/flymd" alt="License: GPL-3.0" /></a>
  <a href="https://github.com/flyhunterl/flymd"><img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey.svg" alt="Platform" /></a>
  <a href="https://github.com/microsoft/winget-pkgs/tree/master/manifests/f/flyhunterl/FlyMD"><img src="https://img.shields.io/badge/winget-flyhunterl.FlyMD-blue" alt="Winget" /></a>
  <a href="https://t.me/+3SOMbwSbCvIxMGQ9"><img src="https://img.shields.io/badge/Telegram-Join-blue?logo=telegram&logoColor=white" alt="Telegram 社区" /></a>
</p>

---

## 简介

FlyMD 是一款轻量级、高性能的本地 Markdown 编辑器,支持 PDF 高精度解析、AI 辅助写作、智能待办提醒等功能。本地优先,数据安全可控,开箱即用。

---

## 核心特性

### 编辑体验

- **源码/所见双模式** - 双模式自由切换,源码模式支持分屏
- **毫秒级启动与渲染** - DOM 就绪仅需 5ms,实测 8 万字笔记无卡顿
- **智能大纲导航** - 目录大纲支持左右切换,快速定位长文档

### 高级功能

- **AI 助手** - 辅助写作、润色与改错,支持 Markdown 渲染与代码高亮,内置免费 AI 模型开箱即用
- **智能待办提醒** - 自动识别 TODO,支持微信、短信、邮箱、钉钉、飞书等多渠道推送
- **高精度 PDF/图片解析** - 解析为 MD 或 Docx 格式,支持翻译
- **一键发布** - 支持 Typecho / WordPress / Halo 博客平台
- **协同编辑** - 通过扩展插件实现多人实时协同(需安装"协同编辑"扩展,详询 QQ 群 343638913)
- **Git 版本控制** - 文档接入 Git,支持状态查询、历史查看与显式提交
- **iframe 嵌入** - 支持音乐、视频、地图、在线文档等外部内容
- **选区感知 AI** - 右键菜单快捷操作可仅作用于选中文本
- **标签与便签工具** - 标签右键支持新实例打开、重命名,一键生成桌面便签

> 💡 AI 助手扩展会在首次启动后后台静默安装;如卸载,将不会再次自动安装。
>
> ⚠️ 内置 AI 模型旨在降低 AI 应用门槛。本应用已对内置模型设置严格速率限制,请勿滥用。推荐[注册硅基流动账号](https://cloud.siliconflow.cn/i/X96CT74a)解锁更强模型和更高额度。

### 平台与格式

- **全平台支持** - Windows / Linux / macOS
- **多格式导出** - PDF / DOCX
- **便携模式** - 所有配置写入应用根目录,适合 U 盘携带

> ⚠️ Linux 提示:在 Arch / Manjaro 等基于 Arch 的发行版上,AppImage 可能因 WebKitGTK / 显卡驱动出现白屏,建议优先使用 deb → debtap / PKGBUILD 转换为 pacman 包,详见 [Arch 安装与排错说明](arch.md)。

### 数据安全

- **本地优先** - 零后台网络,数据安全可控
- **图床支持** - S3/R2 一键上传,自动插入图片链接,支持右键上传指定图片
- **WebDAV 同步** - 多设备、多文档库同步,支持端到端加密与 HTTP 主机白名单
- **扩展插件系统** - 支持自定义扩展,功能无限可能

---
## 功能演示



### PDF 高精度解析 + 翻译

**示例为高精度解析插件，同时提供MinerU解析插件，根据需求自行选择**

<img src="https://github.com/user-attachments/assets/2a512b4b-7083-41d9-9b84-f9b411b849f1" alt="PDF高精度解析翻译" width="800">

### AI 对话联动 + 桌面便签

**十种颜色可选 · 透明度自定义 · 支持可视化交互**

<img src="https://github.com/user-attachments/assets/016617fa-1971-4711-8c5e-1398a1b0aa52" alt="AI对话联动推送和便签" width="800">

---




## 快速开始

### 安装

从 [Releases](https://github.com/flyhunterl/flymd/releases) 下载对应平台安装包:

| 平台 | 安装方式 |
|------|----------|
| **Windows** | `winget install flyhunterl.FlyMD` 或下载安装包 |
| **Linux** | 支持主流桌面环境 |
| **macOS** | 支持 Intel 和 Apple Silicon |

<details>
<summary><strong>macOS 安装注意事项</strong></summary>

由于应用暂未进行 Apple 公证,首次安装可能提示"已损坏,无法打开"。

**方法 1:终端命令(推荐)**
```bash
sudo xattr -r -d com.apple.quarantine /Applications/flymd.app
```

**方法 2:系统设置方式**
1. 打开 Finder,找到下载的应用
2. **按住 Control 键点击**应用图标,选择"打开"
3. 在弹出的对话框中点击"打开"按钮

> ⚠️ FlyMD 是开源软件,代码完全透明,"已损坏"提示仅因未进行 Apple 代码签名。

</details>

### 核心操作

| 操作 | 快捷键 | 操作 | 快捷键 |
|------|--------|------|--------|
| 新建文件 | `Ctrl+N` | 切换所见模式 | `Ctrl+W` |
| 打开文件 | `Ctrl+O` | 切换编辑/预览 | `Ctrl+E` |
| 保存文件 | `Ctrl+S` | 专注模式 | `Ctrl+Shift+F` |
| 新建标签页 | `Ctrl+T` | 查找替换 | `Ctrl+H` |

**多标签页操作**:
- `Ctrl+T` - 开启空白标签页
- `Ctrl+Tab` / `Ctrl+Shift+Tab` - 循环切换标签
- `Ctrl + 点击文库文档` - 新标签打开并进入源码模式
- `Alt+W` - 关闭当前标签页

**配置与迁移**:
- 导出/导入配置 - 一键迁移完整环境(包含扩展与设置)
- 便携模式 - 所有配置写入应用根目录

**图片与同步**:
- 粘贴/拖拽自动处理图片,支持 S3/R2 图床上传
- WebDAV 同步多设备、多文档库,支持端到端加密

**页面操作**:
- `Shift + 滚轮` - 调整内容区宽度(页边距)
- `Ctrl + 滚轮` - 放大文字和图片
- `Shift + 鼠标右键` - 呼出原生菜单(当右键菜单被插件占用时)

---

## 扩展开发

FlyMD 拥有丰富的插件生态,支持通过扩展插件无限扩展功能。

### 精选插件

**文档处理**:
- **Word/Excel 导入** - 从本地 Word/Excel 文件解析并导入为 Markdown
- **PDF 高精度解析** - 使用大模型高精度识别 PDF 为 Markdown 或 Docx,支持手写、布局、公式和表格
- **MinerU PDF/图片解析** - 使用 MinerU 官方 API 解析 PDF 和图片
- **批量导出 PDF** - 一次选择多个文档并批量导出为 PDF

**博客发布**:
- **Typecho Publisher** - 一键发布到 Typecho 博客
- **Halo Publisher** - 一键发布到 Halo 博客平台
- **Typecho 博文管理** - 拉取博文列表并下载为本地 Markdown,支持按时间/分类筛选

**效率工具**:
- **Markdown 表格助手** - 在光标处快速插入 Markdown 表格
- **智能悬浮工具条** - 选中文字后在光标下方显示一个富文本工具条，并提供1-6级标题快捷键自定义功能
- **xxtui 待办推送** - 扫描文档中的未完成待办并推送到微信、短信、邮箱等
- **Telegraph 图床上传** - 粘贴/拖拽图片自动上传到 Telegraph 图床
- **Piclist图床上传** - 粘贴/拖拽图片自动上传到 Piclist设置的图床 支持源码模式中选中单张图片地址上传（0.7.1版本）
- **小红书文案生成** - 接入 AI,内置小红书爆款风格,支持一键润色、扩写
- **协同编辑** - 连接协同服务器实现多人实时协同编辑

**知识管理**:
- **双向链接（Backlinks）** - 基于 [[标题]] 语法自动建立笔记间的正向/反向链接,提供 AI 关联推荐
- **Git 版本管理** - 提供 Git 快照与历史查看侧栏,支持一键回滚到指定版本

**其他工具**:
- **发送到 Blinko** - 右键菜单一键将当前内容发送到 Blinko

### 安装扩展

- 从扩展市场一键安装
- 从 GitHub 或 HTTP URL 安装社区扩展
- 开发自定义扩展,满足个性化需求

📚 **开发文档**:[扩展开发文档 (中文)](plugin.md) | [Extension Documentation (English)](plugin.en.md)

---

## 性能与技术

### 性能指标

| 指标 | 数值 |
|------|------|
| ⚡ 冷启动 | ≤ 300ms |
| 📦 安装包体积 | ≤ 10MB |
| 💾 常驻内存 | ≤ 50MB |
| 🔄 预览切换 | ≤ 16ms |

### 技术栈与致谢

**核心技术**:

| 项目 | 用途 |
|------|------|
| [Tauri](https://tauri.app/) | 跨平台框架 |
| [MilkDown](https://milkdown.dev/) | 所见所得编辑器 |
| [markdown-it](https://github.com/markdown-it/markdown-it) | Markdown 渲染 |
| [DOMPurify](https://github.com/cure53/DOMPurify) | HTML 安全清洗 |
| [highlight.js](https://highlightjs.org/) | 代码高亮 |
| [KaTeX](https://katex.org/) | 数学公式渲染 |
| [Mermaid](https://mermaid.js.org/) | 图表绘制 |

**生态合作伙伴**:

| 合作伙伴 | 简介 | 支持类型 |
|---------|------|---------|
| [硅基流动](https://cloud.siliconflow.cn/i/X96CT74a) | 全球领先的 AI 能力提供商 | **免费模型提供商** |
| [XXTUI](https://www.xxtui.com/) | 简单高效的个人推送 API | 推送服务支持 |
| [x666.me](https://x666.me/register?aff=yUSz) | 优质 AI 接口支持的公益站 | 模型服务支持 |

**感谢硅基流动提供的免费 AI 模型支持**:

<a href="https://cloud.siliconflow.cn/i/X96CT74a" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/plugins/ai-assistant/Powered-by-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="public/plugins/ai-assistant/Powered-by-light.png">
    <img alt="Powered by SiliconFlow" src="public/plugins/ai-assistant/Powered-by-light.png" width="200">
  </picture>
</a>

---

## 社区与支持

### 加入社区

欢迎加入社区获取最新动态、版本预览与使用技巧:

| 平台 | 链接 |
|------|------|
| QQ 群 | 343638913 |
| Telegram | [t.me/+3SOMbwSbCvIxMGQ9](https://t.me/+3SOMbwSbCvIxMGQ9) |

### 社区开发者

| 开发者 | 贡献 |
|--------|------|
| [xf959211192](https://github.com/xf959211192) | Telegraph-Image 图床上传 |
| [Vita0519](https://github.com/Vita0519) | 小红书文案生成 AI 文案扩展 |

### 贡献指南

欢迎提交 Issue 和 Pull Request!

---

## 其他信息

### 路线图

详见:[ROADMAP.md](ROADMAP.md)

### Star History

[![Star History Chart](https://api.star-history.com/svg?repos=flyhunterl/flymd&type=date&legend=top-left)](https://www.star-history.com/#flyhunterl/flymd&type=date&legend=top-left)

### 许可协议

本项目基于 [GNU 通用公共许可证 第 3 版 (GPL-3.0)](LICENSE) 发布。

- ✅ **允许**：在遵守 GPL-3.0 的前提下，任何用途（包括商业用途）的使用、修改、复制与再分发
- ❗ **约束**：若分发本项目或修改版本（无论是否收费），必须开放对应源代码并保留版权与许可信息

如需在与 GPL-3.0 不兼容的闭源商业场景中使用本项目，请联系：flyhunterl <flyhunterl@gmail.com>

完整许可证：[LICENSE](LICENSE) | 第三方组件：[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)

### 常见问题

<details>
<summary><strong>macOS 提示"已损坏,无法打开"怎么办?</strong></summary>

执行:`sudo xattr -r -d com.apple.quarantine /Applications/flymd.app`,或按住 Control 键点击应用选择"打开"。

</details>

<details>
<summary><strong>Arch Linux 空白页面?</strong></summary>

请参阅 [Arch Linux 空白页面解决方法](arch.md)。

</details>

<details>
<summary><strong>右键菜单被插件占用了怎么办?</strong></summary>

使用 `Shift + 鼠标右键` 呼出原生菜单。

</details>

<details>
<summary><strong>如何放大文章或修改页边距?</strong></summary>

- `Shift + 滚轮` 调整内容区宽度(页边距)
- `Ctrl + 滚轮` 放大文字和图片

</details>

<details>
<summary><strong>所见模式支持 TODO 列表吗?</strong></summary>

目前不支持 `- [ ]`/`- [x]` 待办语法,请在源码/预览模式中编辑待办。

</details>

---

## 开源不易

分享: 个人使用稳定的模型提供商


⭐⭐⭐[rightcode](https://www.right.codes/register?aff=E8E36524) **:稳定性和性价比都极高的Claude和codex**


⭐⭐⭐ [PackyCode](https://www.packyapi.com/register?aff=Rqk1) **同样高性价比的Claude、codex、Gemini**


通过以下链接注册可以帮助我节省开发成本,您也能获得部分赠金:

[OhMyGPT:一个优质的 AI 服务平台](https://x.dogenet.win/i/dXCKvZ6Q) **使用Google/GitHub OAuth注册登陆获得20美元赠金**

<img width="300" height="300" alt="image" src="https://github.com/user-attachments/assets/4a716fd5-dc61-4a4f-b968-91626debe8d2" />
