# `public/siwc/` — Sign in with ChatGPT 品牌资产（**可选、默认不存在**）

> ## ⚠️ 这里的东西**不是 MIT**
>
> 本目录（若存在内容）属于 **Sign-in with ChatGPT DevKit Noncommercial License v1.0**：
> 仅限**非商业**用途，且**不授予任何 OpenAI 商标/logo 权利**。
> 仓库根 `LICENSE`（MIT）**不覆盖本目录**。详见 `THIRD-PARTY-NOTICES.txt`。
>
> **本目录为空 = 完全正常。** 应用在资产缺失时自动回退纯文字按钮，
> 功能（登录、套餐用量、模型选择）**不依赖**本目录里的任何文件。

## 为什么是空目录

资产有两条互斥的引入路径，两个仓库都**默认不携带**任何 OpenAI 图形资产：

| 路径 | 做法 | 适用 |
|---|---|---|
| **BYO（默认）** | 使用者自备：自己 clone DevKit，把六份 sign-in SVG 放到本目录（或用 `VITE_SIWC_ASSETS_DIR` 指到别处） | 想显示官方标识、且自身用途符合 Noncommercial 的场景 |
| **不引入** | 什么都不放：UI 显示文字按钮 `Continue with ChatGPT` | 任何可能被商用/公司环境使用的分发 |

**禁止**：把本目录的内容在 MIT 口径下再分发（等于对下游做了我们无权做的承诺）。

## 应该放什么

DevKit 仓库 `openai/sign-in-with-chatgpt-devkit` 的 `assets/` 里，本应用只用到 sign-in 按钮这一组：

| 期望文件名 | 上游路径 | 用途 |
|---|---|---|
| `sign-in-with-chatgpt-black.svg` | `assets/readme/sign-in-with-chatgpt-black.svg` | 深色底按钮 |
| `sign-in-with-chatgpt-white.svg` | `assets/readme/sign-in-with-chatgpt-white.svg` | 浅色底按钮 |

> 上游目录结构可能变化。**放入任何文件前先核对** `assets/README.md` 与
> `LICENSE` 的当前内容，并在下表登记来源与哈希。

### 来源登记（放入文件时必须补全）

本应用的第三方字体已经用同样方式登记在 `public/fonts/THIRD-PARTY-NOTICES.txt`，
这里沿用同一纪律：**每个文件都要能追溯到来源与内容哈希**。

| 文件 | 上游 URL | commit | SHA-256 | 取用日期 |
|---|---|---|---|---|
| _（待登记）_ | | | | |

## BYO 用法

```powershell
git clone https://github.com/openai/sign-in-with-chatgpt-devkit
# 方式 A：复制到本目录（随构建产物一起分发 —— 你要为此承担 Noncommercial 约束）
copy ..\sign-in-with-chatgpt-devkit\assets\readme\sign-in-with-chatgpt-*.svg public\siwc\

# 方式 B（推荐）：只在本机指向，不进入仓库、不进入产物
$env:VITE_SIWC_ASSETS_DIR = 'E:\src\sign-in-with-chatgpt-devkit\assets\readme'
```

方式 B 下**本目录保持为空**，仓库与其产物依旧整体 MIT。

## 商标注意（与许可无关的第二道风险）

许可不授予商标权，商标另受 [OpenAI brand guidelines](https://openai.com/brand/) 约束。
即使用户自备资产，也**不得**把 ChatGPT 标识用于：

- 暗示与 OpenAI 的合作、赞助或背书；
- 登录/授权之外的装饰性用途；
- `sharing == false`（仅登录、未授权套餐用量）时展示「Using ChatGPT plan」——
  那是计费事实陈述，后端用 `siwc.status.sharing` 明确区分了这两种状态。

违反上述任一情形，请走「不引入」路径。
