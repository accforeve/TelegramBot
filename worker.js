import { handleRequest } from './core.js';

export default {
    async fetch(request, env, ctx) {
        const config = {
            // 默认前缀 public
            prefix: env.PREFIX || 'public',
            // 安全密钥
            secretToken: env.SECRET_TOKEN || '',
            // 绑定 KV 数据库
            kv: env.KV
        };

        return handleRequest(request, config);
    }
};
