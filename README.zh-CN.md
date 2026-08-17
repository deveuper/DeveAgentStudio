# DeveAgent Studio

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
  带墙钟/重试预算、截止时间强制执行与崩溃磁盘恢复。
- **Loop 模式**：调度有界重复任务（间隔/轮次/重试/时长预算）；暂停/恢复/取消。
- **Grilling Me**：交叉质询流程，强制先做显式问答决策再继续。

### 多智能体协作
- **MoA 团队**：planner/coder/reviewer/verifier 顾问 + 可选 executor；
  顺序/并行/辩论运行；恰好一次执行恢复（中断阶段绝不静默重放）。
- **专家系统**：内置只读顾问（chief/planner/codegraph/reviewer/security/test/
  memory/token-saver/UI）+ 用户自定义专家。
- **工作包（Work Packs）**：一键预设，绑定模式、技能与角色路由。
- **角色→模型路由**：按角色绑定模型，绑定模型无法解析时如实告警。

### 记忆与上下文
- **持久记忆**：项目 MEMORY.md、会话检查点/笔记、任务进度、决策、Bug 历史、
  自动发现的技能候选 —— SQLite FTS 检索，中文按 bigram 分词。
- **Token Saver**：确定性头尾压缩 + 字节稳定标记（保持前缀缓存稳定同时真正省 token）。
- **CodeGraph**：增量符号索引（tree-sitter）+ 导入/调用边、上下文包、审查范围。
- **缓存形状诊断**：逐会话归因前缀缓存未命中（系统/工具/参数变化），
  缓存行为可观测而非假设。

### 独立能力
- **独立视觉 API**（OpenAI 兼容提供商：MiMo/GLM/火山方舟/百炼/Moonshot/Ollama…）
  自动回退系统 OCR（Windows.Media.Ocr / macOS Vision）——与主提供商分离。
- **独立 STT** 配置，带真实网络探测测试。
- **Computer Use**：加固的只读 shell 白名单（git/rg/node/bun/python 受限安全命令；
  无 shell 注入面）。

### UI（Codex 风格、DeveAgent 品牌化）
- 左栏 / 状态栏 / 右侧概览面板外壳，暖橙强调色，Inter 优先字体，
  `# Skill` 风格技能 chips，圆形发送按钮，粘性时间线头部，可折叠推理，
  带无障碍控件的 diff 摘要，浅/深双主题 token 级换肤。

## 参考来源

- **OpenCode**（https://github.com/anomalyco/opencode）—— 核心引擎：会话管理、
  提供商、工具与服务器。DeveAgent Studio 是增量 fork，定期移植上游修复。
- **MiMo Code 工作流** —— 模式词汇（ask/plan/build/compose/goal/loop/review/
  debug/refactor/auto）与 turn-tail 运行时状态模式。
- **Reasonix / ZCode / Codex** —— 视觉方向：紧凑 IDE 式布局、橙色强调、
  紧致排版、无障碍交互模式。

## 相比普通 agent CLI 的提升

以下是本代码库的设计级特性（绝不虚构指标；逐会话缓存指标在应用内如实统计）：

- **缓存优先提示词**：系统前缀整个会话字节稳定；运行时状态以合成部分随用户轮
  携带，而非重渲染前缀。前缀形状诊断告诉你缓存未命中*为什么*发生。
- **一切有界**：goal/loop 有轮次/重试/墙钟预算；所有内存注册表与持久化存储均
  有上限且原子写入（temp+rename、串行链、Windows 锁回退）——崩溃不会静默丢失
  智能体状态。
- **诚实降级**：未知模型定价返回缺失而非猜测；视觉/STT/OCR 不可用会说明原因；
  中断的多智能体阶段如实报告、绝不静默重放。
- **安全姿态**：只读 computer-use shell 白名单 + 逐命令旗标阻断、远程技能 URL
  白名单（仅 HTTPS 市场主机）、浏览器/MCP URL 的私网/DNS 重绑定防护、
  发布前强制密钥卫生（见 `agent.md`）。
- **验证纪律**：每个产品变更经过源码检查（typecheck + 单测）、对抗式代码审查、
  打包版 E2E 门禁链（loop/team/role/click + 项目流程）后方可发布。

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

## 项目状态

积极开发中。自主功能（goal/loop/团队/记忆/视觉/STT/computer-use）在每个发布周期
都由单测与打包版 E2E 门禁验证。开发日志存于私有工作区；本仓库只发布产品源码。

## 致谢

- 核心引擎：[OpenCode](https://github.com/anomalyco/opencode)（MIT 许可 fork 基础，
  核心部分见其 LICENSE）。
- DeveAgent 层、桌面外壳、记忆/团队/自主系统与 UI：DeveAgent Studio 贡献者。
