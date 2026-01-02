/**
 * Open Wegram Bot - Final Version
 * Fix: Button conflict (URL vs CallbackData), Crash Protection, High Performance
 */

export function validateSecretToken(token) {
    return token.length > 15 && /[A-Z]/.test(token) && /[a-z]/.test(token) && /[0-9]/.test(token);
}

export function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

function formatUTCTime(timestamp) {
    return new Date(timestamp * 1000).toISOString().replace('T', ' ').substring(0, 19) + " UTC";
}

export async function postToTelegramApi(token, method, body) {
    return fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}

async function replyText(botToken, chatId, text, parseMode = null) {
    return postToTelegramApi(botToken, 'sendMessage', {
        chat_id: chatId,
        text: text,
        parse_mode: parseMode
    });
}

export async function handleInstall(request, ownerUid, botToken, prefix, secretToken) {
    if (!validateSecretToken(secretToken)) return jsonResponse({ success: false, message: 'Invalid Secret Token' }, 400);

    const url = new URL(request.url);
    const webhookUrl = `${url.protocol}//${url.hostname}/${prefix}/webhook/${ownerUid}/${botToken}`;

    try {
        await postToTelegramApi(botToken, 'setWebhook', {
            url: webhookUrl,
            allowed_updates: ['message', 'edited_message', 'callback_query'],
            secret_token: secretToken
        });
        return jsonResponse({ success: true, message: 'Webhook installed.' });
    } catch (error) {
        return jsonResponse({ success: false, message: error.message }, 500);
    }
}

export async function handleUninstall(botToken, secretToken) {
    if (!validateSecretToken(secretToken)) return jsonResponse({ success: false, message: 'Invalid Token' }, 400);
    await postToTelegramApi(botToken, 'deleteWebhook', {});
    return jsonResponse({ success: true, message: 'Webhook uninstalled.' });
}

export async function handleWebhook(request, ownerUid, botToken, secretToken, KV, ctx) {
    // 1. 安全校验
    if (secretToken !== request.headers.get('X-Telegram-Bot-Api-Secret-Token')) {
        return new Response('Unauthorized', { status: 401 });
    }

    const runTask = async (promise) => {
        if (ctx && typeof ctx.waitUntil === 'function') {
            ctx.waitUntil(promise);
        } else {
            await promise; 
        }
    };

    const update = await request.json();
    const currentTime = Math.floor(Date.now() / 1000);
    const BAN_DURATION = 86400;

    // ========================================================================
    // A. 处理按钮点击
    // ========================================================================
    if (update.callback_query) {
        const query = update.callback_query;
        const userId = query.from.id.toString();

        if (query.data === 'captcha_verify' && KV) {
            const [banTimestamp, pendingTime] = await Promise.all([
                KV.get(`blacklist:${userId}`),
                KV.get(`pending:${userId}`)
            ]);

            if (banTimestamp) {
                const unbanTimeStr = formatUTCTime(parseInt(banTimestamp));
                await runTask(postToTelegramApi(botToken, 'answerCallbackQuery', {
                    callback_query_id: query.id,
                    text: `⛔️ Banned until: ${unbanTimeStr}`,
                    show_alert: true
                }));
                return new Response('OK');
            }

            if (!pendingTime) {
                await runTask(postToTelegramApi(botToken, 'answerCallbackQuery', {
                    callback_query_id: query.id,
                    text: '⚠️ Session expired.',
                    show_alert: true
                }));
                return new Response('OK');
            }

            const timeDiff = currentTime - parseInt(pendingTime);
            
            if (timeDiff > 30) {
                const unbanTime = currentTime + BAN_DURATION;
                const unbanTimeStr = formatUTCTime(unbanTime);

                await runTask(Promise.all([
                    KV.put(`blacklist:${userId}`, unbanTime.toString(), { expirationTtl: BAN_DURATION }),
                    KV.delete(`pending:${userId}`),
                    postToTelegramApi(botToken, 'answerCallbackQuery', {
                        callback_query_id: query.id,
                        text: `❌ Timeout! Banned until ${unbanTimeStr}`,
                        show_alert: true
                    }),
                    postToTelegramApi(botToken, 'editMessageText', {
                        chat_id: query.message.chat.id,
                        message_id: query.message.message_id,
                        text: `⛔️ 验证超时，已封禁。\nTimeout. Banned until:\n<b>${unbanTimeStr}</b>`,
                        parse_mode: 'HTML'
                    })
                ]));
            } else {
                await runTask(Promise.all([
                    KV.put(`verified:${userId}`, 'true', { expirationTtl: 3600 }),
                    KV.delete(`pending:${userId}`),
                    postToTelegramApi(botToken, 'answerCallbackQuery', {
                        callback_query_id: query.id,
                        text: '✅ Verified!'
                    }),
                    postToTelegramApi(botToken, 'editMessageText', {
                        chat_id: query.message.chat.id,
                        message_id: query.message.message_id,
                        text: '✅ 验证通过，1小时内免验证。\nVerified. Session valid for 1 hour.'
                    })
                ]));
            }
        }
        return new Response('OK');
    }

    // ========================================================================
    // B. 处理消息
    // ========================================================================
    const message = update.message || update.edited_message;
    if (!message || (message.from && message.from.is_bot)) return new Response('OK');

    const reply = message.reply_to_message;
    const isEdited = !!update.edited_message;

    try {
        // --- 场景 1: 站长回复用户 ---
        if (reply && message.chat.id.toString() === ownerUid) {
            const firstButton = reply.reply_markup?.inline_keyboard?.[0]?.[0];

            if (firstButton) {
                let senderUid = firstButton.callback_data;
                // 优先检查 callback_data，如果没有再检查 URL
                if (!senderUid && firstButton.url) {
                    const urlParts = firstButton.url.split('tg://user?id=');
                    if (urlParts.length > 1) senderUid = urlParts[1];
                }

                if (senderUid) {
                    await runTask(postToTelegramApi(botToken, 'copyMessage', {
                        chat_id: parseInt(senderUid),
                        from_chat_id: message.chat.id,
                        message_id: message.message_id
                    }));
                }
            }
            return new Response('OK');
        }

        // --- 场景 2: 用户发给站长 ---
        if (message.chat.id.toString() !== ownerUid && KV) {
            const userId = message.chat.id.toString();

            const [banTimestamp, existingPending, isVerified] = await Promise.all([
                KV.get(`blacklist:${userId}`),
                KV.get(`pending:${userId}`),
                KV.get(`verified:${userId}`)
            ]);

            if (banTimestamp) {
                const unbanTimeStr = formatUTCTime(parseInt(banTimestamp));
                await runTask(replyText(botToken, userId, `⛔️ Banned until:\n<b>${unbanTimeStr}</b>`, 'HTML'));
                return new Response('OK');
            }

            if (existingPending) {
                if (currentTime - parseInt(existingPending) > 30) {
                    const unbanTime = currentTime + BAN_DURATION;
                    const unbanTimeStr = formatUTCTime(unbanTime);
                    await runTask(Promise.all([
                        KV.put(`blacklist:${userId}`, unbanTime.toString(), { expirationTtl: BAN_DURATION }),
                        KV.delete(`pending:${userId}`),
                        replyText(botToken, userId, `⛔️ Timeout. Banned until:\n<b>${unbanTimeStr}</b>`, 'HTML')
                    ]));
                }
                return new Response('OK');
            }

            if (!isVerified) {
                const deadlineTime = new Date((currentTime + 30) * 1000).toISOString().substr(11, 8);
                await runTask(Promise.all([
                    KV.put(`pending:${userId}`, currentTime.toString()),
                    postToTelegramApi(botToken, 'sendMessage', {
                        chat_id: userId,
                        text: `🛡 <b>Verification</b>\n\nVerify in <b>30s</b>.\nDeadline: <b>${deadlineTime} (UTC)</b>\nTimeout = Ban 24h.`,
                        parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: [[{ text: '⚡️ Verify Now', callback_data: 'captcha_verify' }]] }
                    })
                ]));
                return new Response('OK');
            }
        }

        // --- 场景 3: 正常转发 ---
        if (!isEdited && "/start" === message.text) return new Response('OK');

        const senderUid = message.chat.id.toString();
        const kvKey = `map:${senderUid}:${message.message_id}`;

        if (isEdited && message.text) {
            const editDelay = (message.edit_date || currentTime) - message.date;
            if (editDelay <= 60) {
                const storedOwnerMsgId = await KV.get(kvKey);
                if (storedOwnerMsgId) {
                    const newText = `${message.text}\n\n(Ed) ID: ${senderUid}`;
                    
                    // [修复重点] 编辑时也需要生成正确的按钮（URL优先）
                    let button = { text: senderUid };
                    if (/^\d+$/.test(senderUid)) {
                        button.url = `tg://user?id=${senderUid}`;
                    } else {
                        button.callback_data = senderUid;
                    }
                    const ik = [[button]];
                    
                    await runTask(postToTelegramApi(botToken, 'editMessageText', {
                        chat_id: parseInt(ownerUid),
                        message_id: parseInt(storedOwnerMsgId),
                        text: newText,
                        reply_markup: { inline_keyboard: ik }
                    }));
                    return new Response('OK');
                }
            }
        }

        await runTask(postToTelegramApi(botToken, 'sendChatAction', { 
            chat_id: message.chat.id, 
            action: 'typing' 
        }));

        // 转发消息 [修复重点]
        const sendCopy = async (withUrl = false) => {
            // 这里是核心修复：
            // 如果 withUrl 为真且 ID 是数字，只设置 url，不设置 callback_data
            // 否则只设置 callback_data
            let button = { text: senderUid };
            
            if (withUrl && /^\d+$/.test(senderUid)) {
                button.url = `tg://user?id=${senderUid}`;
            } else {
                button.callback_data = senderUid;
            }

            const ik = [[button]];

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
                await runTask(KV.put(kvKey, resultData.result.message_id.toString(), { expirationTtl: 86400 }));
            }
        }

        return new Response('OK');

    } catch (error) {
        console.error('Error:', error);
        return new Response('Error handled', { status: 200 });
    }
}

export async function handleRequest(request, config) {
    const { prefix, secretToken, kv, ctx } = config; 
    const url = new URL(request.url);
    const path = url.pathname;

    const matchInstall = path.match(new RegExp(`^/${prefix}/install/([^/]+)/([^/]+)$`));
    const matchUninstall = path.match(new RegExp(`^/${prefix}/uninstall/([^/]+)$`));
    const matchWebhook = path.match(new RegExp(`^/${prefix}/webhook/([^/]+)/([^/]+)$`));

    if (matchInstall) return handleInstall(request, matchInstall[1], matchInstall[2], prefix, secretToken);
    if (matchUninstall) return handleUninstall(matchInstall[1], secretToken);
    if (matchWebhook) return handleWebhook(request, matchWebhook[1], matchWebhook[2], secretToken, kv, ctx);

    return new Response('Not Found', { status: 404 });
}
