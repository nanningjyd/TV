// functions/api/updatesources.js
// 接收客户端提交的新源列表，写入仓库 sources.json（站点级源清单），触发自动部署。
// 需要 Cloudflare Pages 环境变量：
//   PASSWORD   (已存在，用于鉴权，与站点密码一致)
//   GH_TOKEN   (需新增，拥有仓库写入权限的 GitHub Personal Access Token)
//   REPO_OWNER (可选，默认 nanningjyd)
//   REPO_NAME  (可选，默认 TV)

function base64EncodeUnicode(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

export async function onRequestPost(context) {
    const { request, env } = context;
    const owner = env.REPO_OWNER || 'nanningjyd';
    const repo = env.REPO_NAME || 'TV';
    const ghToken = env.GH_TOKEN;

    const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Content-Type': 'application/json'
    };

    if (!ghToken) {
        return new Response(JSON.stringify({
            success: false,
            error: '服务器未配置 GH_TOKEN 环境变量，无法提交到仓库。请在 Cloudflare Pages 设置 → 环境变量 中添加 GH_TOKEN（需 repo 写权限的 GitHub 令牌）。'
        }), { status: 500, headers: cors });
    }

    // 鉴权：比对站点密码哈希（与 /proxy/ 一致，客户端发送 window.__ENV__.PASSWORD）
    const clientHash = request.headers.get('x-site-auth') ||
        new URL(request.url).searchParams.get('auth');
    if (!clientHash || !env.PASSWORD) {
        return new Response(JSON.stringify({ success: false, error: '未授权' }), { status: 401, headers: cors });
    }
    const encoder = new TextEncoder();
    const hashBuf = await crypto.subtle.digest('SHA-256', encoder.encode(env.PASSWORD));
    const serverHash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
    if (clientHash !== serverHash) {
        return new Response(JSON.stringify({ success: false, error: '鉴权失败' }), { status: 401, headers: cors });
    }

    let body;
    try { body = await request.json(); }
    catch (e) {
        return new Response(JSON.stringify({ success: false, error: '请求体不是合法 JSON' }), { status: 400, headers: cors });
    }
    if (!body || !body.sites || typeof body.sites !== 'object') {
        return new Response(JSON.stringify({ success: false, error: '缺少 sites 字段' }), { status: 400, headers: cors });
    }

    const content = JSON.stringify({ API_SITES: body.sites }, null, 2) + '\n';
    const b64 = base64EncodeUnicode(content);

    const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/sources.json`;
    const headers = {
        'Authorization': 'Bearer ' + ghToken,
        'User-Agent': 'LibreTV-SourceUpdater',
        'Content-Type': 'application/json'
    };

    try {
        let sha = null;
        const getRes = await fetch(apiBase, { headers });
        if (getRes.ok) {
            const cur = await getRes.json();
            sha = cur.sha;
        } else if (getRes.status !== 404) {
            const err = await getRes.text();
            return new Response(JSON.stringify({ success: false, error: '读取仓库 sources.json 失败: ' + getRes.status + ' ' + err.slice(0, 200) }), { status: 502, headers: cors });
        }

        const payload = { message: 'chore: 更新视频源列表 (via 更新源功能)', content: b64 };
        if (sha) payload.sha = sha;

        const putRes = await fetch(apiBase, { method: 'PUT', headers, body: JSON.stringify(payload) });
        if (!putRes.ok) {
            const err = await putRes.text();
            return new Response(JSON.stringify({ success: false, error: '写入仓库失败: ' + putRes.status + ' ' + err.slice(0, 200) }), { status: 502, headers: cors });
        }
        const j = await putRes.json();
        return new Response(JSON.stringify({
            success: true,
            commit: j.commit ? j.commit.sha : null,
            message: '已提交，Cloudflare 将自动重新部署'
        }), { status: 200, headers: cors });
    } catch (e) {
        return new Response(JSON.stringify({ success: false, error: '处理出错: ' + e.message }), { status: 500, headers: cors });
    }
}

export async function onOptions() {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': '*'
        }
    });
}
