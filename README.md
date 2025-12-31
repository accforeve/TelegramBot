### **基于 [原版](https://github.com/wozulong/open-wegram-bot) 增改**
相较于原版，做了如下增改：

1. 核心架构与基础设施

- > 状态管理: 引入 Cloudflare KV 数据库
- > 数据记忆：记录消息 ID 映射 (Map)，记录用户黑白名单状态
- > 配置方式：全面使用环境变量 (KV, SECRET_TOKEN, PREFIX)

2. 消息处理机制 (Message Handling)

- > 编辑消息同步 (Edit Sync): 支持原地同步修改。利用 KV 数据库查找对应关系，当用户在 60秒内 修改消息时，你收到的消息也会同步变身。
- > 超时处理: 超过 60 秒的修改，会作为新消息发送，确保你保留原始的历史记录（防篡改）。
- > 界面风格: 去除名字和图标（🔒 From: Name (ID)，带有锁图标和名字），仅显示纯数字 UID（以避免Name过长遮挡UID)。


3. 安全与反垃圾 (Security & Anti-Spam) ---这是改动最大的部分，增加了一套完整的防御系统。

- > 人机验证 (Captcha): 陌生人首次发消息会被拦截，必须点击按钮验证。
- > 黑名单机制 (Blacklist): 24小时自动封禁。如果用户在 30秒 内未完成验证，会被自动拉入黑名单，24小时内无法再发消息。
- > 白名单机制 (Session): 验证通过后，1小时内 免验证通行。

4. 健壮性与体验 (Robustness & UX)

- > 交互反馈: 收到消息后立刻显示 "typing..." (正在输入) 状态，让用户知道 Bot 活着。
- > 防崩溃设计: 使用了可选链 (?.) 和 try...catch 全局捕获，即使出现异常也能优雅处理。
- > 防死循环: 增加了对 Bot 自身 ID 的严格过滤，防止自言自语消耗配额。

### **现在我们开始部署：**

### **第一步：创建 KV 数据库 (用于消息同步)**
这是实现“对方修改消息，你也同步修改”的关键组件。

1. 登录 Cloudflare Dashboard。
2. 在左侧菜单栏找到 Workers & Pages (Workers 和   #@Pages)，点击进入。
3. 在二级菜单中点击 KV。
4. 点击右上角的 Create a namespace (创建命名空间)。
5. 在 "Namespace Name" 中输入：TG_BOT_KV （注意：名字可以随意取，但为了配合代码，建议直接用这个。）
6. 点击 Add (添加)。
  -  状态检查：列表中出现 TG_BOT_KV 即为成功。

### **第二步：创建 Worker 并绑定 KV**

1. 回到 Workers & Pages -> Overview (概览)。
2. 点击 Create Application (创建应用) -> Create Worker (创建 Worker)。
3. 给 Worker 起个名字（比如 my-tg-bot），然后点击 Deploy (部署)。
    - 此时里面的代码是默认的 Hello World，不用管它。
4. 点击 Edit code (编辑代码) 旁边的 Settings (设置) 选项卡（或者直接点击刚创建的 Worker 进入详情页再点 Settings）。
5. 在 Settings 页面中，点击 Variables (变量)。
6. 向下滚动找到 KV Namespace Bindings (KV 命名空间绑定)。
7. 点击 Add binding (添加绑定)：
    - Variable name (变量名): 必须填 KV（⚠️ 严重警告：必须是大写 KV，必须完全一致，否则代码会报错。）
    - KV Namespace (KV 命名空间): 下拉选择刚才创建的 TG_BOT_KV。
8. 点击 Save and Deploy (保存并部署)。

### **第三步：设置环境变量 (Environment Variables)**

1. 变量和机密 点击 Add variable (添加变量)。
2. 你需要添加以下两个变量：（⚠️注意：名字可以随意取，但为了配合代码，建议直接用这个。）
- [ ] 变量 1 (必须): 
    - 纯文本类型
    - 变量名称: SECRET_TOKEN
    - 值: 输入一串复杂的随机字符（建议 20 位以上，包含大小写字母和数字）。
    - 用途：这是 Telegram 用来验证请求是否合法的密码，防止黑客伪造消息。
- [ ] 变量 2 (可选，建议添加):  用于定义 webhook 的路径前缀。
    - 纯文本类型
    - 变量名称: PREFIX
    - 值: public
3. 点击 Save and Deploy (保存并部署)。

### **第四步：上传代码**
现在环境配置好了，你可以去上传代码了。

1. 点击右上角的 Edit code (编辑代码)。
2. 在左侧文件列表：
    - 找到 worker.js，清空内容，把 worker.js 粘贴进去。
    - 右键点击文件列表空白处 -> Create new file (新建文件)，命名为 core.js ，把 core.js 粘贴进去。
3. 点击右上角的 Deploy (部署)。

### **第五步：激活机器人 (最后一步！)**
代码部署后，必须访问一次安装链接才能让 Telegram 知道要把消息推送到这里。

1. 拼接这个链接：
https://[你的Worker域名]/public/install/[你的TG账号ID]/[你的机器人Token]
    - 你的Worker域名: 在 Worker 详情页上方可以看到，通常是 xxx.workers.dev。
    - 你的TG账号ID: 纯数字 ID（可以用 @userinfobot 查询）。
    - 你的机器人Token: 找 @BotFather 申请时给的那串。
2. 在浏览器打开这个拼接好的链接。
3. 如果页面显示 {"success":true,"message":"Webhook successfully installed."}，恭喜你，大功告成！

**⚠️注意：可以绑定多个bot。如果更迭代码，建议重新激活bot（重复第五步）。**


### 原版地址：https://github.com/wozulong/open-wegram-bot
