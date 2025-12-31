export function validateSecretToken(token) {
    return token.length > 15 && /[A-Z]/.test(token) && /[a-z]/.test(token) && /[0-9]/.test(token);
}

export function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

export async function postToTelegramApi(token, method, body) {
    return fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}

// 辅助函数：将时间戳格式化为 UTC 时间字符串
function formatUTCTime(timestamp) {
    return new Date(timestamp * 1000).toISOString().replace('T', ' ').substring(0, 19) + " UTC";
}

export async function handleInstall(request, ownerUid, botToken, prefix, secretToken) {
    if (!validateSecretToken(secretToken)) {
        return jsonResponse({
            success: false,
            message: 'Secret token must be at least 16 characters.'
        }, 400);
    }

    const url = new URL(request.url);
    const baseUrl = `${url.protocol}//${url.hostname}`;
    const webhookUrl = `${baseUrl}/${prefix}/webhook/${ownerUid}/${botToken}`;

    try {
        const response = await postToTelegramApi(botToken, 'setWebhook', {
            url: webhookUrl,
            allowed_updates: ['message', 'edited_message', 'callback_query'],
            secret_token: secretToken
        });
        const result = await response.json();
        
        if (result.ok) {
            return jsonResponse({ success: true, message: 'Webhook successfully installed.' });
        }
        return jsonResponse({ success: false, message: `Failed: ${result.description}` }, 400);
    } catch (error) {
        return jsonResponse({ success: false, message: `Error: ${error.message}` }, 500);
    }
}

export async function handleUninstall(botToken, secretToken) {
    if (!validateSecretToken(secretToken)) {
        return jsonResponse({ success: false, message: 'Invalid token.' }, 400);
    }
    try {
        const response = await postToTelegramApi(botToken, 'deleteWebhook', {});
        return jsonResponse({ success: true, message: 'Webhook uninstalled.' });
    } catch (error) {
        return jsonResponse({ success: false, message: error.message }, 500);
    }
}

export async function handleWebhook(request, ownerUid, botToken, secretToken, KV) {
    if (secretToken !== request.headers.get('X-Telegram-Bot-Api-Secret-Token')) {
        return new Response('Unauthorized', { status: 401 });
    }

    const update = await request.json();
    const currentTime = Math.floor(Date.now() / 1000); 

    // 定义封禁时长 (秒) - 24小时
    const BAN_DURATION = 86400;

    // ========================================================================
    // 处理按钮点击 (Callback Query)
    // ========================================================================
    if (update.callback_query) {
        const query = update.callback_query;
        const userId = query.from.id.toString();

        if (query.data === 'captcha_verify' && KV) {
            // 1. 检查是否在黑名单中
            const banTimestamp = await KV.get(`blacklist:${userId}`);
            if (banTimestamp) {
                // 如果存在，说明被封禁。读取存储的时间戳并格式化
                const unbanTimeStr = formatUTCTime(parseInt(banTimestamp));
                await postToTelegramApi(botToken, 'answerCallbackQuery', {
                    callback_query_id: query.id,
                    text: `⛔️ Banned until: ${unbanTimeStr}\n您已被封禁，解封时间: ${unbanTimeStr}`,
                    show_alert: true
                });
                return new Response('OK');
            }

            // 2. 检查待验证记录
            const pendingTime = await KV.get(`pending:${userId}`);
            
            if (!pendingTime) {
                await postToTelegramApi(botToken, 'answerCallbackQuery', {
                    callback_query_id: query.id,
                    text: '⚠️ Session expired. Please message again.',
                    show_alert: true
                });
                return new Response('OK');
            }

            // 3. 检查是否超过 30 秒
            const timeDiff = currentTime - parseInt(pendingTime);
            
            if (timeDiff > 30) {
                // 超时 -> 拉入黑名单
                // [修改] Value 存入解封时间戳，而非简单的 "true"
                const unbanTime = currentTime + BAN_DURATION;
                await KV.put(`blacklist:${userId}`, unbanTime.toString(), { expirationTtl: BAN_DURATION });
                await KV.delete(`pending:${userId}`);

                const unbanTimeStr = formatUTCTime(unbanTime);

                await postToTelegramApi(botToken, 'answerCallbackQuery', {
                    callback_query_id: query.id,
                    text: `❌ Timeout! Banned until ${unbanTimeStr}`,
                    show_alert: true
                });
                
                await postToTelegramApi(botToken, 'editMessageText', {
                    chat_id: query.message.chat.id,
                    message_id: query.message.message_id,
                    text: `⛔️ 验证超时，您已被封禁 24 小时。\nTimeout. Banned until:\n<b>${unbanTimeStr}</b>`,
                    parse_mode: 'HTML'
                });
            } else {
                // 通过 -> 授予 1 小时有效期
                await KV.put(`verified:${userId}`, 'true', { expirationTtl: 3600 });
                await KV.delete(`pending:${userId}`);

                await postToTelegramApi(botToken, 'answerCallbackQuery', {
                    callback_query_id: query.id,
                    text: '✅ Verified!'
                });

                await postToTelegramApi(botToken, 'editMessageText', {
                    chat_id: query.message.chat.id,
                    message_id: query.message.message_id,
                    text: '✅ 验证通过，1小时内无需再次验证。\nVerified. Session valid for 1 hour.'
                });
            }
        }
        return new Response('OK');
    }

    // ========================================================================
    // 处理普通消息
    // ========================================================================
    const message = update.message || update.edited_message;
    if (!message) return new Response('OK');
    if (message.from && message.from.is_bot) return new Response('OK');

    const reply = message.reply_to_message;
    const isEdited = !!update.edited_message;

    try {
        // --- 场景 A: 站长回复用户 ---
        if (reply && message.chat.id.toString() === ownerUid) {
            const rm = reply.reply_markup;
            const firstButton = rm?.inline_keyboard?.[0]?.[0];
            
            if (firstButton) {
                let senderUid = firstButton.callback_data;
                if (!senderUid && firstButton.url) {
                    const parts = firstButton.url.split('tg://user?id=');
                    if (parts.length > 1) senderUid = parts[1];
                }

                if (senderUid) {
                    await postToTelegramApi(botToken, 'copyMessage', {
                        chat_id: parseInt(senderUid),
                        from_chat_id: message.chat.id,
                        message_id: message.message_id
                    });
                }
            }
            return new Response('OK');
        }

        // --- 场景 B: 用户发给站长 ---
        
        if (message.chat.id.toString() !== ownerUid && KV) {
            const userId = message.chat.id.toString();

            // 1. 检查黑名单
            const banTimestamp = await KV.get(`blacklist:${userId}`);
            if (banTimestamp) {
                // [修改] 如果处于黑名单，提示解封时间
                const unbanTimeStr = formatUTCTime(parseInt(banTimestamp));
                
                // 这里选择是否回复用户。为了避免被刷屏，可以选择仅在用户发 /start 时提示，或者每次都提示
                // 为了友好，我们回复一条提示
                await postToTelegramApi(botToken, 'sendMessage', { 
                    chat_id: userId, 
                    text: `⛔️ 您已被封禁 (Banned)。\n\n解封时间 / Unban Time:\n<b>${unbanTimeStr}</b>`,
                    parse_mode: 'HTML'
                });
                return new Response('OK');
            }

            // 2. 检查 Pending (防止重复验证)
            const existingPending = await KV.get(`pending:${userId}`);
            if (existingPending) {
                if (currentTime - parseInt(existingPending) > 30) {
                    // 超时封禁
                    const unbanTime = currentTime + BAN_DURATION;
                    await KV.put(`blacklist:${userId}`, unbanTime.toString(), { expirationTtl: BAN_DURATION });
                    await KV.delete(`pending:${userId}`);
                    
                    const unbanTimeStr = formatUTCTime(unbanTime);
                    await postToTelegramApi(botToken, 'sendMessage', { 
                        chat_id: userId, 
                        text: `⛔️ 验证超时，您已被封禁 24 小时。\nPrevious verification timed out.\n\n解封时间 / Unban Time:\n<b>${unbanTimeStr}</b>`,
                        parse_mode: 'HTML'
                    });
                }
                return new Response('OK');
            }

            // 3. 检查白名单
            const isVerified = await KV.get(`verified:${userId}`);
            if (!isVerified) {
                const deadlineTime = new Date((currentTime + 30) * 1000).toISOString().substr(11, 8); // HH:MM:SS (UTC)

                await KV.put(`pending:${userId}`, currentTime.toString());

                await postToTelegramApi(botToken, 'sendMessage', {
                    chat_id: userId,
                    text: `🛡 <b>人机验证 / Verification</b>\n\n请在 <b>30秒</b> 内点击按钮。\n截止时间: <b>${deadlineTime} (UTC)</b>\n超时将被<b>封禁 24小时</b>。\n\nPlease verify in <b>30s</b>.\nDeadline: <b>${deadlineTime} (UTC)</b>`,
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [[{
                            text: '⚡️ 立即验证 / Verify Now',
                            callback_data: 'captcha_verify'
                        }]]
                    }
                });
                return new Response('OK');
            }
        }

        // --- 验证通过后的正常逻辑 ---

        if (!isEdited && "/start" === message.text) return new Response('OK');

        const sender = message.chat;
        const senderUid = sender.id.toString();
        const kvKey = `map:${senderUid}:${message.message_id}`;

        if (isEdited && message.text) {
            const editTime = message.edit_date || currentTime;
            if (editTime - message.date <= 60) {
                const storedOwnerMsgId = await KV.get(kvKey);
                if (storedOwnerMsgId) {
                    const newText = `${message.text}\n\n(Ed) ID: ${senderUid}`;
                    const ik = [[{ text: senderUid, callback_data: senderUid }]];
                    const editResp = await postToTelegramApi(botToken, 'editMessageText', {
                        chat_id: parseInt(ownerUid),
                        message_id: parseInt(storedOwnerMsgId),
                        text: newText,
                        reply_markup: { inline_keyboard: ik }
                    });
                    if (editResp.ok) return new Response('OK');
                }
            }
        }

        await postToTelegramApi(botToken, 'sendChatAction', { chat_id: message.chat.id, action: 'typing' });

        const sendCopy = async (withUrl = false) => {
            const ik = [[{ text: senderUid, callback_data: senderUid }]];
            if (withUrl && /^\d+$/.test(senderUid)) ik[0][0].url = `tg://user?id=${senderUid}`;
            return await postToTelegramApi(botToken, 'copyMessage', {
                chat_id: parseInt(ownerUid),
                from_chat_id: message.chat.id,
                message_id: message.message_id,
                reply_markup: { inline_keyboard: ik }
            });
        };

        let finalResp = await sendCopy(true);
        if (!finalResp.ok) finalResp = await sendCopy(false);

        if (finalResp.ok) {
            const resultData = await finalResp.json();
            if (resultData.ok && resultData.result) {
                await KV.put(kvKey, resultData.result.message_id.toString(), { expirationTtl: 86400 });
            }
        }

        return new Response('OK');

    } catch (error) {
        console.error('Webhook Error:', error);
        return new Response('Error', { status: 200 });
    }
}

export async function handleRequest(request, config) {
    const { prefix, secretToken, kv } = config; 
    const url = new URL(request.url);
    const path = url.pathname;
    
    const matchInstall = path.match(new RegExp(`^/${prefix}/install/([^/]+)/([^/]+)$`));
    const matchUninstall = path.match(new RegExp(`^/${prefix}/uninstall/([^/]+)$`));
    const matchWebhook = path.match(new RegExp(`^/${prefix}/webhook/([^/]+)/([^/]+)$`));

    if (matchInstall) return handleInstall(request, matchInstall[1], matchInstall[2], prefix, secretToken);
    if (matchUninstall) return handleUninstall(matchInstall[1], secretToken);
    if (matchWebhook) return handleWebhook(request, matchWebhook[1], matchWebhook[2], secretToken, kv);

    return new Response('Not Found', { status: 404 });
}
