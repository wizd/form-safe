# Form Safe 开发笔记：需求从哪来

记录时间：2026-10-27

## 1. 需求是怎么找到的

### 起点：AI Robert 的推文
- 链接：https://x.com/aiRobertDaily/status/2114925454486577427 （2026-10-27）
- 方法分三步：
  1. 在 Reddit 搜带英文引号的 `"I would pay for"`，找用户亲口说愿意付钱的需求
  2. 看评论区推荐的现成方案，以及大家嫌它哪里不好（太贵、太重、配置麻烦）
  3. 把需求改写成工具关键词（推文里的例子是 `app store screenshot generator`），放进 Semrush 看搜索量、KD 和 CPC

### 在 Reddit 上的筛选过程
- 先搜 `"I would pay for"` / `"I'd pay for"`，再加上 app、tool、extension、plugin 等词，帖子和评论都搜了
- 一共整理出 10 个候选方向，最后选了「网页表单提交回执」。原因是：用户直接报了价格，技术上做得出来，现有竞品也都很弱（见第 3 节）

## 2. 需求原帖

- 帖子：r/AppIdeas —「Which small Chrome extension would actually be useful enough for you to pay for?」
  https://www.reddit.com/r/AppIdeas/comments/1utuexw/which_small_chrome_extension_would_actually_be/
- 发帖人 u/Conscious-Image-4161 列了 7 个 Chrome 扩展点子，第 3 个是 **Form Submission Receipt**：每次提交重要的网页表单时，在本地存一份私人回执，记下自己填了什么。

### 评论区原话（u/j-j-a-go-go）
> #3 is a good idea and potentially worth paying for but I'm nervous about installing third party Chrome extensions that would need permission to read all browsing data.

> If you did build it, I'd want the form info to be emailed to me so I can search it in my inbox just like other email I send. I'd want it open source so that I could have an LLM verify that there is no tracking and could use my own email server. If you made it open source and sold it for a one time fee (maybe $10-$20?), I'd be interested.

> I'm often filling out online forms or contact forms for work things. Having a record of when I filled them out with all of my answers so I can reference them in the future.

> I'd want it to be automatic so I don't have to think about it.

### 同一帖下的其他意见
- u/chickenfal 指出不一定需要「读取所有浏览数据」的权限，可以用 `activeTab`
- u/hipster-coder 说自己没有这个痛点、不会付钱，但觉得工作中经常要提交表单的人可能会买；在 7 个点子里，他也认为这个最好

### 从原话里提炼出的付费条件
| # | 用户要求 | 
|---|---|
| A | 全自动，不用每次记得去点 |
| B | 回执进自己的邮箱，可以在收件箱里搜 |
| C | 开源，可以审计有没有追踪，可以用自己的邮件服务器 |
| D | 权限尽量小，不想给「读取全部浏览数据」 |
| E | 一次性买断，$10–$20 |

## 3. 竞品调研（Chrome Web Store，2026-10-27）

数据来自商店详情页，「—」表示页面上没有显示用户数。

### A. 通用网页表单回执（直接竞品）
| 扩展 | 用户 / 评分 | 定价 | 问题 |
|---|---|---|---|
| SubmitSentry — Form Receipt Vault | — / 无评分 | 免费 5 次，之后 €9.99 买断 | 全靠手动：提交前开弹窗扫描、勾选字段、截图，提交后还要再补一张确认页截图。不能发邮件，不开源 |
| FormTrail — Submission Records | 4 / 无评分 | 免费 | 要先手动扫描当前页，或者手动「arm」提交检测。只存在本地，不能发邮件。商店简介里还留着没删的 Markdown 草稿 |

### B. 只支持 Google Forms
| 扩展 | 用户 / 评分 | 定价 |
|---|---|---|
| Google Form Tracker | 337 / 5.0 (1) | 免费 |
| Google Forms Submission Logger | 13 / 5.0 (3) | 免费 |
| FormProof – Google Forms Receipts | — / 无评分 | 免费 5 次，之后 $1.99 买断 |
| Form Keep | — / 无评分 | 免费 |

### C. 防丢字、草稿恢复（相邻品类，需求不同但流量大）
| 扩展 | 用户 / 评分 |
|---|---|
| Form History Control (II) | 20,000 / 3.9 (39) |
| Typio Form Recovery Reboot（开源，MV3 社区复刻） | 3,000 / 4.2 (5) |
| Form Recovery | 133 / 2.0 (4) |
| TypeVault | 10 |
| Lifeboat | 4 |

这一类扩展按输入框保存打字草稿，用来防止崩溃丢字。它们不会把一次提交整理成「问题 + 答案 + 时间 + 截图」的回执。Lazarus 和原版 Typio 被下架以后，这个品类空出了一批用户。

### 结论
- 直接竞品都是今年刚上架的，用户数是个位数
- 没有一款同时满足 A（自动）+ B（进收件箱）+ C（开源）

## 4. 需求和实现的对应关系（v0.1.0）

| 需求 | 现在怎么做的 | 状态 |
|---|---|---|
| A 自动 | 监听 `submit` 事件，以及 Submit / Send / 提交 等按钮的点击；在点击那一刻抓取，所以页面跳转后数据还在 | 已在测试页验证 |
| B 进收件箱 | 方式一：用用户自己的 Resend API Key 发邮件，带截图附件。方式二：发到 Webhook。也可以在回执页手动用 `mailto` 发给自己 | **未实测**。还不支持 Gmail API 和自定义 SMTP |
| C 开源 | 代码没有服务器、没有统计 | **还没加开源许可证，也还没发布到 GitHub** |
| D 最小权限 | 手动保存只用 `activeTab`；自动模式要全站权限，但用户在 Chrome 里点一次授权才会开启（`optional_host_permissions`） | 权限申请流程未实测 |
| E 买断 | — | 还没有付费功能 |
| 隐私 | 排除密码、卡号（Luhn 校验）、CVV、OTP、SSN / IBAN、token、隐藏字段 | 已在测试页验证 |

## 5. 下一步待办
- [ ] 在 Chrome 里装上，走一遍完整流程：存储、截图、popup、保险箱页面、权限申请
- [ ] 实测 Resend 和 Webhook 投递
- [ ] 加开源许可证，发布到 GitHub（对应条件 C）
- [ ] 支持 Gmail API 或自定义 SMTP（对应条件 B 里「用自己的邮件服务器」）
- [ ] 定价：免费额度 + $12–$19 买断
- [ ] 商店关键词同时覆盖两个方向：`form submission receipt`、`save web form submission` 和 `form recovery`、`auto save form input`
- [ ] 按推文第 3 步，用 Semrush 等工具查这些关键词的搜索量（这一步还没做）
