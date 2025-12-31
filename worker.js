import { handleRequest } from './core.js';

export default {
    async fetch(request, env, ctx) {
        const config = {
            prefix: env.PREFIX || 'public',
            secretToken: env.SECRET_TOKEN || '',
            kv: env.KV,
            ctx: ctx // 关键：传递 ctx 以支持后台非阻塞运行
        };

        return handleRequest(request, config);
    }
};

