import { validateSession } from '../utils/auth/sessionManager.js';
import { errorHandling, telemetryData, checkDatabaseConfig } from '../utils/middleware';

// CORS 跨域响应头
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
};

// OPTIONS 预检请求处理
async function handleOptions(context) {
    if (context.request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: corsHeaders
        });
    }
    return context.next();
}

async function requireForumOrAdmin(context) {
  if (!(await validateSession(context.env, context.request, 'admin')).valid) return new Response('Please upload through Lighthouse', {status:401,headers:{...corsHeaders,'Cache-Control':'no-store'}});
  return context.next();
}
export const onRequest = [checkDatabaseConfig, handleOptions, errorHandling, requireForumOrAdmin, telemetryData];