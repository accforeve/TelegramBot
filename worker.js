import { handleRequest } from './core.js';

export default {
    async fetch(request, env, ctx) {
        const config = {
            prefix: env.PREFIX || 'public',
            secretToken: env.SECRET_TOKEN || '',
            kv: env.KV,
            ctx: ctx // 关键点：这里必须把 ctx 传进去，旧版没有这一行
        };

        return handleRequest(request, config);
    }
};
