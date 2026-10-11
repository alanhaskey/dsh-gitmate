# dsh-git — 给 DSH 的 Git 面板与 Git 工具

在 DeepSeek Harness 的**右侧栏**里直接操作 Git：看改动、看差异、暂存/取消暂存、丢弃、**一键生成提交说明**、提交、推送/拉取/获取、初始化仓库、写本机配置、切分支、回滚提交、一键生成 `.gitignore`。点开一个文件可以看补丁，也可以让模型用几句话**总结这个文件改了什么**，不必逐行读。同一套能力也注册成 Agent 工具，所以在对话里说一句也能做。

以前这些要切回 VS Code、依赖那个时灵时不灵的提交信息插件；现在 dsh 自己就能做，提交说明由当前会话的模型按 Conventional Commits 生成，风格统一、可配置。

## 面板

右侧栏 →「+」→ 选 **Git** 打开（和 Files、Terminal 同一排）。

**改动视图**

- **分支栏**：点分支名展开本地分支列表——点名字切换、`×` 删除（需二次确认）、底部输入框直接**新建并切过去**；右侧显示上游与领先/落后。
- **改动列表**：冲突 / 已暂存 / 改动 / 未跟踪 四组，每行左侧是状态字母，右侧是 `+`（暂存）`−`（取消暂存）`⟲`（丢弃，需二次确认）。
- **点路径展开差异**：补丁就地展开在那一行下面（不跳走），按 `+` / `-` / `@@` 着色，超长自动截断。未跟踪文件没有补丁，面板直接把文件内容当新增展示。
- **「解释改动」**：在差异头部点一下，模型用 2–5 条要点说清这个文件改了什么、要注意什么——不想逐行读的时候就靠它。
- **提交区**：说明输入框、**生成说明**、**提交**、`提交后推送`，以及推送 / 拉取 / 获取。
- **回滚上次提交**：展开后选「保留改动（已暂存）」/「保留改动（取消暂存）」/「丢弃改动」。已经推送过的提交会被明确警告——撤销它会改写历史。
- **身份提示**：仓库没有 `user.name` / `user.email` 时提交按钮没有意义，面板会直接给出本仓库 / 全局两个范围的填写框。

**设置视图**（右上角齿轮）

- 生成说明的**语言**（跟随仓库 / 英文 / 简体中文）、**风格**（Conventional Commits / 普通祈使句）、**自定义要求或模板**（例如「以模块名开头」，会追加在默认规则之后且优先级更高）。
- 提交是否加 `Signed-off-by`、默认分支名、生成用的 provider/model（留空用会话默认）。
- **一键生成 `.gitignore`**：按仓库里已有的文件推断出适用的分组（Node / Python / Go / Rust / Java / .NET / Ruby / PHP / 密钥 / 日志 / 编辑器 / 系统），勾选后**追加**写入，已有内容一行都不会删。

设置写回插件自己的配置行（`cordis.patch.yml`），所以升级不丢、在插件页也能看到、改完 profile 会热重载一次。

面板每 5 秒静默重读一次仓库（页面不可见或正在执行操作时跳过），所以 Agent 在对话里提交之后，面板会自己跟上。

## 它同时给了 dsh 什么

十个 Agent 工具（`git_*`），注册在 Host 侧：

| 工具 | 作用 |
| --- | --- |
| `git_status` | 当前分支、上游领先/落后、已暂存 / 已修改 / 未跟踪 / 冲突的完整清单 |
| `git_diff` | 指定范围的补丁：`all` / `staged` / `unstaged` / `last-commit` / `range` |
| `git_stage` | `add` / `unstage` / `discard`（丢弃必须显式给出路径） |
| `git_commit` | **不传 `message` 就自动生成**；也支持 `amend` / `signoff` / `dryRun` 预览 / `push` |
| `git_reset` | 撤销最近一次提交：`soft` 保留已暂存 / `mixed` 保留未暂存 / `hard` 丢弃，并报告该提交是否已经推送过 |
| `git_log` | 最近提交 |
| `git_init` | 初始化仓库、按分组或字面文本写 `.gitignore`、可选首次提交 |
| `git_config` | 读写 `local` / `global` / `effective` 配置 |
| `git_sync` | `push` / `pull` / `fetch` |
| `git_branch` | 列出、新建、切换、删除分支 |

### 提交说明是怎么生成的

`git_commit` 不带 `message`、或面板点「生成说明」时，插件收集：暂存区逐文件改动量、完整补丁、未暂存改动、未跟踪文件内容抽样、当前分支、以及最近 15 条提交标题——交给当前会话的默认模型，按 Conventional Commits 规则生成。最近提交标题同时用于**学习这个仓库的既有风格**（`messageLanguage: auto` 时会跟随仓库既有提交的语言）。设置里填的自定义要求会作为最高优先级追加在提示词最后。

面板的「解释改动」走同一条模型通路，只是提示词换成「向没读过补丁的审查者解释这一个文件」，输出 2–5 条要点。

生成失败不会静默降级成一句废话：错误连同原因一起返回，并提示改用 `git_diff` 自己写。

## 结构

```
lib/plugin.js     bundle 入口：插件身份 + 按修订号加载实现
lib/impl.js       Host：createOperations() 一处实现，注册九个工具
lib/rpc.js        Host：面板端点（/api/dsh-git 上的精确 Fetch 路由）
lib/git-core.js   纯 git 操作，注入 exec 即可脱离 DSH 测试
lib/messages.js   提交说明的提示词与模型调用
lib/client.js     浏览器半边：右侧栏 Git 面板
```

面板和工具**共用同一份实现**：`createOperations()` 产出操作对象，工具是它的一个调用方，`/api/dsh-git` 的端点分发是另一个。改一处两边同时生效，不会出现两套逻辑不一致。

面板通过 `connection.fetch.register()` 注册 `/api/dsh-git` 这条精确 Fetch 路由，因此**继承 `/api` 前缀已有的 Host/Origin 校验与浏览器鉴权**，而且不写会话日志——每 5 秒刷新一次也不会污染 transcript。

（不用 `connection.rpc.handle()` 是因为它把路由挂在 `owner.effect(() => owner.webServer.register(route))` 上，而那里的 `owner` 是 connection 插件自己的 context，从未注入 `webServer`，任何外部插件调用都会以 `cannot get property "webServer" without inject` 失败。`dsh-context` 把同样的调用包在 `try/catch` 里，所以它是静默失效的。）

## 配置

改 `cordis.patch.yml` 里的 `config`：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `defaultBranch` | `main` | `git_init` 未指定时的首个分支名 |
| `messageLanguage` | `auto` | `auto` / `en` / `zh` |
| `messageStyle` | `conventional` | `conventional`（`feat: ...`）或 `plain` |
| `messageTemplate` | 未设置 | 追加在默认规则之后的自定义要求，优先级最高 |
| `maxPromptBytes` | `24000` | 每次交给模型的补丁字节上限 |
| `maxDiffBytes` | `80000` | 补丁返回字节上限 |
| `commandTimeoutMs` | `60000` | 单条 git 命令超时；网络命令放宽到 4 倍 |
| `signoff` | `false` | 是否给提交加 `Signed-off-by` |
| `provider` / `model` | 未设置 | 生成提交说明用的模型；不写就用会话默认模型 |

## 安全边界

- 所有 git 参数单引号转义，路径校验不许逃出仓库根目录。
- `discard` 是破坏性操作：工具侧必须显式给 `paths`（全丢传 `["."]`），面板侧需要二次确认；未跟踪文件默认保留。
- 命令固定前缀 `GIT_TERMINAL_PROMPT=0 GIT_EDITOR=true GIT_PAGER=cat`，不会卡在凭据或编辑器上。
- 面板端点只接受 POST + JSON，请求体上限 1 MiB，且必须先通过连接层鉴权。

## 开发

```bash
node test/smoke.mjs     # 202 项断言，跑真实 git，不需要 DSH
```

覆盖四层：

1. **git 行为**——用 `node:child_process` 冒充 `ctx.shell`，在临时仓库里跑真 git（并隔离 `HOME`，机器上的全局配置影响不了结果）。
2. **工具注册**——用假 `ctx` 跑 `apply`，检查九个工具的名字、参数 schema、结果渲染，并按 `@deepseek-ai/dsh-tools` 的 `assertSupportedJsonSchema` 规则复刻一份 **schema 子集校验**，让会被 Host 拒绝的 schema 在本地就失败。
3. **面板桥**——驱动真实的 Fetch handler：请求体解析、状态码、`{ok,value}` / `{ok,error}` 信封、未知端点、不存在的会话，以及暂存 / 差异 / 提交 / 配置 / 设置 / 回滚 / `.gitignore` / 未跟踪预览整条链路。
4. **提示词与消息归一化**——假 LLM 验证路由解析、system prompt、代码围栏/引号/署名 trailer 的清洗，以及文件改动解释。

### 两条平台限制，代码里都绕开了

- **没有模块热重载**：DSH Desktop 不给 Node 传 `--expose-internals`，所以 `@deepseek-ai/dsh-hmr` 的模块级重载不可用（`hmr.root` 一旦非空，那一行会直接激活失败，还会连带弄坏 profile 配置热重载——所以这个 bundle 绝不去覆盖 `hmr`）。`lib/plugin.js` 因此按**所有实现文件的最新 mtime**取一个修订号再去 `import`：改完在插件页把这个 bundle 关掉再打开就是新代码，不用重启 App，也不会无限堆积模块。注意入口模块自身是被缓存的，改 `plugin.js` 需要重启才生效。
- **`dsh.client` 声明只扫描一次**：`@deepseek-ai/dsh-client-modules` 会把「这个包不是客户端包」的结论按 loader specifier 缓存到进程结束，所以后加的 `dsh.client` 在旧 specifier 下永远不会被发现。patch 里的行因此**用路径而不是包名寻址**（插入的相对行会锚定在 patch 文件旁），扫描每次都读最新 manifest，浏览器半边不必等重启。改完 `lib/client.js` 刷新页面即可。
