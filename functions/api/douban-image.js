// functions/api/douban-image.js
// 代理加载豆瓣图片，绕过 img3/img9 等子域对浏览器 Referer 的严格限制
// 请求格式：GET /api/douban-image?url=<encoded>&auth=<sha256(password)>&t=<timestamp>

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': '*',
        }
    });
}

async function sha256(message) {
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function validateAuth(request, env) {
    const url = new URL(request.url);
    const authHash = url.searchParams.get('auth');
    const timestamp = url.searchParams.get('t');
    const password = env.PASSWORD;

    if (!password) return false;

    const expected = await sha256(password);
    if (!authHash || authHash !== expected) return false;

    if (timestamp) {
        const now = Date.now();
        if (now - parseInt(timestamp) > 10 * 60 * 1000) return false; // 10 分钟有效期
    }

    return true;
}

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);

    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return jsonResponse({ success: false, error: '仅支持 GET/HEAD' }, 405);
    }

    if (!await validateAuth(request, env)) {
        return jsonResponse({ success: false, error: '未授权' }, 401);
    }

    const imageUrl = url.searchParams.get('url');
    if (!imageUrl) {
        return jsonResponse({ success: false, error: '缺少 url 参数' }, 400);
    }

    let targetUrl;
    try {
        targetUrl = decodeURIComponent(imageUrl);
        if (!/^https?:\/\//i.test(targetUrl)) throw new Error('invalid');
    } catch (e) {
        return jsonResponse({ success: false, error: 'url 参数无效' }, 400);
    }

    try {
        // 用目标图片站自身的 origin 作为 Referer，img3/img9 都能接受
        const referer = new URL(targetUrl).origin + '/';

        const response = await fetch(targetUrl, {
            method: request.method,
            headers: {
                'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': request.headers.get('Accept') || 'image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                'Referer': referer,
            },
            redirect: 'follow',
        });

        if (!response.ok) {
            return jsonResponse({ success: false, error: `源站返回 ${response.status}` }, 502);
        }

        const headers = new Headers(response.headers);
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Cache-Control', 'public, max-age=86400');

        // 直接透传原始二进制流，不经过 text() 解码，避免图片损坏
        return new Response(response.body, { status: response.status, headers });
    } catch (error) {
        return jsonResponse({ success: false, error: `代理失败: ${error.message}` }, 502);
    }
}

export async function onRequestOptions() {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Max-Age': '86400',
        }
    });
}
