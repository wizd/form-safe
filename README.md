# Form Safe 🛡️ — 每个网页表单的保险箱

Chrome 扩展（Manifest V3）。你提交表单时，它会保存一份私人回执，内容包括每个问题、你的回答、时间、网址和一张截图。

## 安装（开发版）
1. 打开 `chrome://extensions`，开启右上角 **开发者模式**
2. 点 **加载已解压的扩展程序**，选择本目录 `D:\working\form-safe`
3. 首次安装会自动打开欢迎页，点 **Turn on automatic receipts** 授权即可开启自动回执

## 功能
- **自动回执**：监听原生 `submit` 事件，以及 SPA 页面里 Submit / Send / Apply / 提交 / 发送 / 申请 等按钮的点击。提交那一刻就抓取表单，所以页面随后跳转也不会丢数据
- **手动保存**：点工具栏图标，或按 `Alt+Shift+S`。手动保存只用 `activeTab` 权限，不需要全站权限
- **字段识别**：支持 `<label>`、`aria-*`、`fieldset/legend`、Google Forms 风格的 div 问题块、ARIA radio/checkbox、contenteditable、开放的 Shadow DOM、文件名（不读文件内容）
- **隐私过滤**：从不记录密码、卡号（含 Luhn 校验）、CVV、验证码 / OTP、SSN / IBAN、token、隐藏字段
- **保险箱页面**：全文搜索、备注、置顶、复制 Markdown、下载 .md、打印 / PDF、`mailto` 发给自己、导出 JSON / CSV、导入备份
- **发到收件箱（可选）**：用你自己的 Resend API Key 发邮件（附截图），或者 POST 到 Webhook（Zapier / Make / n8n）。扩展没有自己的服务器
- **防噪**：默认排除邮箱、聊天类网站；填写字段数少于 N 个的自动提交（搜索框、登录框）直接忽略；页面上会弹 Undo 提示条
- **保留期**：可设置自动清理天数，置顶的回执不会被删

## 开发
- `node scripts/make-icons.js`：重新生成图标
- `node test/serve.js`，然后打开 `http://localhost:5178/test/demo.html?harness`：不装扩展也能直接跑内容脚本做测试
