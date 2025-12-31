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
    // 1. 安全校验
    if (secretToken !== request.headers.get('X-Telegram-Bot-Api-Secret-Token')) {
        return new Response('Unauthorized', { status: 401 });
    }

    const update = await request.json();
    const currentTime = Math.floor(Date.now() / 1000); 

    // ========================================================================
    // 处理按钮点击 (Callback Query)
    // ========================================================================
    if (update.callback_query) {
        const query = update.callback_query;
        const userId = query.from.id.toString();

        if (query.data === 'captcha_verify' && KV) {
            // 1. 检查是否在黑名单中
            const isBlacklisted = await KV.get(`blacklist:${userId}`);
            if (isBlacklisted) {
                await postToTelegramApi(botToken, 'answerCallbackQuery', {
                    callback_query_id: query.id,
                    text: '⛔️ You are banned for 24h. / 您已被封禁24小时。',
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
                // 超时 -> 拉入黑名单 24小时 (86400秒)
                await KV.put(`blacklist:${userId}`, 'true', { expirationTtl: 86400 });
                await KV.delete(`pending:${userId}`);

                await postToTelegramApi(botToken, 'answerCallbackQuery', {
                    callback_query_id: query.id,
                    text: `❌ Timeout! (>30s). Banned for 24h.`,
                    show_alert: true
                });
                
                await postToTelegramApi(botToken, 'editMessageText', {
                    chat_id: query.message.chat.id,
                    message_id: query.message.message_id,
                    text: '⛔️ 验证超时，您已被封禁 24 小时。\nTimeout. You are banned for 24 hours.'
                });
            } else {
                // 通过 -> 授予 1 小时有效期 (3600秒)
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
            const isBlacklisted = await KV.get(`blacklist:${userId}`);
            if (isBlacklisted) {
                // 黑名单用户静默处理，或者取消注释下面这行提示他
                // await postToTelegramApi(botToken, 'sendMessage', { chat_id: userId, text: '⛔️ You are banned for 24h.' });
                return new Response('OK');
            }

            // 2. 检查是否在 Pending 状态 (防止重复验证)
            const existingPending = await KV.get(`pending:${userId}`);
            if (existingPending) {
                // 检查旧验证请求是否已超时 (超过 30秒)
                if (currentTime - parseInt(existingPending) > 30) {
                    // 之前发起的验证超时 -> 封禁 24小时
                    await KV.put(`blacklist:${userId}`, 'true', { expirationTtl: 86400 });
                    await KV.delete(`pending:${userId}`);
                    await postToTelegramApi(botToken, 'sendMessage', { 
                        chat_id: userId, 
                        text: '⛔️ 之前的验证超时，您已被封禁 24 小时。\nPrevious verification timed out. Banned for 24h.' 
                    });
                }
                return new Response('OK');
            }

            // 3. 检查白名单 (有效期 1 小时)
            const isVerified = await KV.get(`verified:${userId}`);
            if (!isVerified) {
                // 未验证 -> 发起新验证
                await KV.put(`pending:${userId}`, currentTime.toString());

                await postToTelegramApi(botToken, 'sendMessage', {
                    chat_id: userId,
                    text: '🛡 <b>人机验证 / Verification</b>\n\n请在 <b>30秒</b> 内点击下方按钮，否则将被<b>封禁 24小时</b>。\nPlease verify in <b>30s</b> or get <b>BANNED for 24h</b>.',
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

        // 原地编辑 (限制 60秒)
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

        // 发送新消息
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
                // 消息ID映射保存 24小时，以支持后续的编辑同步
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
    
    // 路由正则
    const matchInstall = path.match(new RegExp(`^/${prefix}/install/([^/]+)/([^/]+)$`));
    const matchUninstall = path.match(new RegExp(`^/${prefix}/uninstall/([^/]+)$`));
    const matchWebhook = path.match(new RegExp(`^/${prefix}/webhook/([^/]+)/([^/]+)$`));

    if (matchInstall) return handleInstall(request, matchInstall[1], matchInstall[2], prefix, secretToken);
    if (matchUninstall) return handleUninstall(matchInstall[1], secretToken);
    if (matchWebhook) return handleWebhook(request, matchWebhook[1], matchWebhook[2], secretToken, kv);

    return new Response('Not Found', { status: 404 });
}
