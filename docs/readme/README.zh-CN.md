# DeveAgent Studio

<p align="center">
  <a href="../../README.md"><img alt="English" src="https://img.shields.io/badge/Language-English-202124?style=for-the-badge" /></a>
  <a href="./README.zh-CN.md"><img alt="简体中文" src="https://img.shields.io/badge/语言-简体中文-D94F2B?style=for-the-badge" /></a>
  <a href="./README.fr.md"><img alt="Français" src="https://img.shields.io/badge/Langue-Français-2563EB?style=for-the-badge" /></a>
</p>

**自主智能体工作台：编码、规划与长跑任务 —— 基于 OpenCode 架构，配以 DeveAgent 原生外壳。**

DeveAgent Studio 是一款桌面端 AI 编程智能体：以久经考验的 OpenCode 引擎为内核，
在其上叠加独立的智能体层 —— 自主 Goal/Loop 执行、多智能体（MoA）团队、持久化项目记忆、
独立视觉/语音配置、缓存友好的提示词架构，以及 Codex 风格界面。

---

## 这是什么

- **桌面应用**（Electron + SolidJS），包裹 OpenCode 服务器。
- **智能体层**：把单个聊天会话变成有边界的自主 worker —— 带验收标准的 Goal、
  带运行预算的 Loop、以及"拷问"（Grilling）交叉质询模式。
- **持久记忆系统**：Markdown + JSON + FTS 检索，跨会话保留决策与 Bug 历史。
- **缓存优先的提示词设计**：字节稳定系统前缀、turn-tail 运行时状态、
  逐会话前缀形状诊断。

## 核心功能

### 自主执行

- **Goal 模式**：设定描述 + 验收标准；智能体在有界重入内持续工作直到验证通过，
  带墙钟/重试预算、截止时间强制执行与本地持久化恢复状态。
- **Loop 模式**：调度有界重复任务（间隔/轮次/重试/时长预算）；暂停/恢复/取消。
- **Grilling Me**：交叉质询流程，强制先做显式问答决策再继续。

### 多智能体协作

- **MoA 团队**：planner/coder/reviewer/verifier 顾问 + 可选 executor；
  通过真实 OpenCode 子会话顺序/并行/辩论运行；中断的可写阶段必须显式复核，
  不会静默重放。
- **专家系统**：内置只读顾问（chief/planner/codegraph/reviewer/security/test/
  memory/token-saver/UI）+ 用户自定义专家。
- **工作包（Work Packs）**：一键预设，绑定模式、技能与角色路由。
- **角色→模型路由**：按角色绑定模型，绑定模型无法解析时如实告警。

### 记忆与上下文

- **持久记忆**：项目 MEMORY.md、会话检查点/笔记、任务进度、决策、Bug 历史、
  自动发现的技能候选；运行时具备 FTS5 时使用 SQLite FTS + 中文 bigram，
  否则回退关键词检索。
- **Token Saver**：上下文范围裁剪、有界工具结果投影与字节稳定标记；界面节省量是
  本地估算，不是 Provider 账单或缓存保证。
- **CodeGraph**：有边界的语法级符号索引（tree-sitter + 解析回退）、启发式导入/
  调用邻居、上下文包和审查范围。
- **缓存形状诊断**：同时记录系统/工具 schema 变化与 Provider 缓存用量，
  不把相关性写成缓存未命中的因果。

### 独立能力

- **独立视觉 API**（OpenAI 兼容提供商：MiMo/GLM/火山方舟/百炼/Moonshot/Ollama…）
  自动回退系统 OCR（Windows.Media.Ocr / macOS Vision）——与主提供商分离。
- **独立 STT** 配置，带真实网络探测测试。
- **受限 Computer Use**：操作 DeveAgent 自身窗口、隔离浏览器和只读 shell 白名单；
  不是任意桌面软件控制，也不是操作系统安全沙箱。

### UI（Codex 风格、DeveAgent 品牌化）

- 左栏 / 状态栏 / 右侧概览面板外壳，暖橙强调色，Inter 优先字体，
  `# Skill` 风格技能 chips，圆形发送按钮，粘性时间线头部，可折叠推理，
  带无障碍控件的 diff 摘要，浅/深双主题 token 级换肤。

## 参考来源

- **OpenCode**（https://github.com/anomalyco/opencode）—— 核心引擎：会话管理、
  提供商、工具与服务器。DeveAgent Studio 是增量 fork，定期移植上游修复。
- **MiMo Code 工作流** —— 模式词汇（ask/plan/build/compose/goal/loop/review/
  debug/refactor/auto）与 turn-tail 运行时状态模式。
- **Hermes Agent 与 Pi** —— 研究有界团队编排、Provider/Profile 路由、
  Session 生命周期和扩展行为，再按 OpenCode 接口重新实现。
- **Reasonix / ZCode / Codex** —— 上下文效率思路与紧凑、可访问的桌面工作台方向。

参考仓库只用于接口和行为研究；DeveAgent 按本 fork 规范重新实现，不复制泄漏提示词原文。

## 相比普通 agent CLI 的提升

以下是本代码库的设计级特性（绝不虚构指标；逐会话缓存指标在应用内如实统计）：

- **缓存优先提示词**：系统前缀整个会话字节稳定；运行时状态以合成部分随用户轮
  携带，而非重渲染前缀。形状诊断指出相关系统/工具变化，但不伪装成缓存未命中因果。
- **一切有界**：goal/loop 有轮次/重试/墙钟预算；内存注册表与持久化存储有上限并
  串行写入。正常路径使用 temp+rename；Windows 锁回退和损坏状态恢复属于尽力而为，
  不是事务保证。
- **诚实降级**：未知模型定价返回缺失而非猜测；视觉/STT/OCR 不可用会说明原因；
  中断的多智能体阶段如实报告、绝不静默重放。
- **安全姿态**：只读 computer-use shell 白名单 + 逐命令旗标阻断、远程技能 URL
  白名单（仅 HTTPS 市场主机）、浏览器/MCP URL 的私网/DNS 重绑定防护、
  发布前强制密钥卫生（见 `agent.md`）。
- **验证纪律**：源码改动运行定向 typecheck 与单测；产品发布切片再运行打包 E2E
  门禁链（loop/team/role/click + 项目流程）。纯文档或无障碍改动可能先进入源码，
  随下一产品切片打包。

## 当前实现边界

| 能力         | 当前证据                                    | 边界                                   |
| ------------ | ------------------------------------------- | -------------------------------------- |
| Goal / Loop  | 持久化有界状态、重试/截止预算、事件驱动重入 | 本地进程调度；完成仍需显式验证         |
| MoA 团队     | 真实子会话、预算、重试、运行记录与汇总      | 不是分布式恰好一次执行；中断写入需复核 |
| Memory       | Markdown/JSON + 可选 SQLite FTS5            | 打包运行时是否有 FTS 取决于环境        |
| CodeGraph    | 语法符号 + 启发式导入/调用邻居              | 不是完整跨语言语义图                   |
| Computer Use | 受限应用内/浏览器动作与只读 shell           | 不是任意外部软件桌面自动化             |
| Token/缓存   | Provider 返回的真实用量；本地估算会明确标注 | 形状诊断不能证明缓存未命中原因         |
| 远程 Skill   | HTTPS 主机/路径校验、持久安装、选中后注入   | 第三方 Skill 文本仍是不可信输入        |

## 从源码构建

要求：Node/Bun、Git、PowerShell（Windows）或 POSIX shell。

```sh
# 安装 + 类型检查
bun install
bun typecheck            # 在包目录内执行

# 单元测试（在包目录内执行，如 packages/opencode）
bun test

# 桌面开发外壳
cd packages/desktop
bunx electron-vite dev

# 打包 Windows 安装包
bun run package:win      # 先执行: bunx electron-vite build
```

包级约定见 `packages/opencode/AGENTS.md`、`packages/app/AGENTS.md`、
`packages/desktop/AGENTS.md`。

## 下载

Windows x64 安装版和便携 ZIP 会发布在
[GitHub Releases 页面](https://github.com/deveuper/DeveAgentStudio/releases/latest)。
发布包不会包含本机 Provider API Key 或 `.deveagent` 设置；安装后由用户自行配置。

## 项目状态

积极开发中。定向源码测试覆盖 Goal、Loop、团队、记忆、视觉 fallback、受限
Computer Use、远程 Skill 与 CodeGraph；打包 E2E 按产品发布切片生成证据，不会从
一个可见按钮或仅源码改动推断完成。开发日志存于私有工作区；本仓库只发布产品源码。

## 致谢

- 核心引擎：[OpenCode](https://github.com/anomalyco/opencode)（MIT 许可 fork 基础，
  核心部分见其 LICENSE）。
- DeveAgent 层、桌面外壳、记忆/团队/自主系统与 UI：DeveAgent Studio 贡献者。
