### **第一步：创建 KV 数据库 (用于消息同步)**
这是实现“对方修改消息，你也同步修改”的关键组件。

1. 登录 Cloudflare Dashboard。
2. 在左侧菜单栏找到 Workers & Pages (Workers 和   #@Pages)，点击进入。
3. 在二级菜单中点击 KV。
4. 点击右上角的 Create a namespace (创建命名空间)。
5. 在 "Namespace Name" 中输入：TG_BOT_KV• 注意：名字可以随意取，但为了配合代码，建议直接用这个。
6. 点击 Add (添加)。
 状态检查：列表中出现 TG_BOT_KV 即为成功。

### **第二步：创建 Worker 并绑定 KV**

1. 回到 Workers & Pages -> Overview (概览)。
2. 点击 Create Application (创建应用) -> Create Worker (创建 Worker)。
3. 给 Worker 起个名字（比如 my-tg-bot），然后点击 Deploy (部署)。
• 此时里面的代码是默认的 Hello World，不用管它。
4. 点击 Edit code (编辑代码) 旁边的 Settings (设置) 选项卡（或者直接点击刚创建的 Worker 进入详情页再点 Settings）。
5. 在 Settings 页面中，点击 Variables (变量)。
6. 向下滚动找到 KV Namespace Bindings (KV 命名空间绑定)。
7. 点击 Add binding (添加绑定)：
• Variable name (变量名): 必须填 KV
• ⚠️ 严重警告：必须是大写 KV，必须完全一致，否则代码会报错。
• KV Namespace (KV 命名空间): 下拉选择刚才创建的 TG_BOT_KV。
8. 点击 Save and Deploy (保存并部署)。

### **第三步：设置环境变量 (Environment Variables)**

1. 点击 Add variable (添加变量)。
2. 你需要添加以下两个变量：
• 变量 1 (必须):
• Variable name: SECRET_TOKEN
• Value: 输入一串复杂的随机字符（建议 20 位以上，包含大小写字母和数字）。
• 用途：这是 Telegram 用来验证请求是否合法的密码，防止黑客伪造消息。
• 变量 2 (可选，建议添加):
• Variable name: PREFIX
• Value: public
• 用途：定义 webhook 的路径前缀。
3. 点击 Save and Deploy (保存并部署)。

### **第四步：上传代码**
现在环境配置好了，你可以去上传代码了。

1. 点击右上角的 Edit code (编辑代码)。
2. 在左侧文件列表：
• 找到 worker.js，清空内容，把之前准备好的 worker.js 粘贴进去。
• 右键点击文件列表空白处 -> Create new file (新建文件)，命名为 core.js。
• 把 core.js 粘贴进去。
3. 点击右上角的 Deploy (部署)。

### **第五步：激活机器人 (最后一步！)**
代码部署后，必须访问一次安装链接才能让 Telegram 知道要把消息推送到这里。

1. 拼接这个链接：
https://[你的Worker域名]/public/install/[你的TG账号ID]/[你的机器人Token]
• 你的Worker域名: 在 Worker 详情页上方可以看到，通常是 xxx.workers.dev。
• 你的TG账号ID: 纯数字 ID（可以用 @userinfobot 查询）。
• 你的机器人Token: 找 @BotFather 申请时给的那串。
2. 在浏览器打开这个链接。
3. 如果页面显示 {"success":true,"message":"Webhook successfully installed."}，恭喜你，大功告成！

注意：理论上可以绑定多个bot，如果更改代码，建议卸载原来绑定的bot后重新绑定。
解绑方法：https://[你的Worker域名]/public/uninstall/[你的机器人Token]
