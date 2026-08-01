// js/addSource.js
// 设置面板“添加源”的自动探测能力：
// 输入 域名 或 完整接口地址，自动尝试常见「苹果CMS V10」路径，
// 找到第一个返回有效 JSON（code=1 或含 list）的接口，返回其基础地址。
// 同时支持手动模式（直接粘贴完整接口地址后点“添加”）。
// 依赖全局：PROXY_URL、API_CONFIG、ProxyAuth（均在 config.js / proxy-auth.js 中定义）
const AddSource = (function () {
    // 常见苹果CMS V10 接口路径候选
    const CANDIDATE_PATHS = [
        '/api.php/provide/vod',
        '/api.php/provide/vod/',
        '/index.php/api.php/provide/vod',
        '/api.php/provide/vod?at=json'
    ];
    const PROBE_QUERY = '测试';
    const PROBE_PARAMS = 'ac=videolist&wd=' + encodeURIComponent(PROBE_QUERY) + '&at=json';
    const TIMEOUT = 12000;

    // 规范化输入：补 https://，去掉末尾多余斜杠
    function normalize(raw) {
        let s = (raw || '').trim();
        if (!s) return '';
        if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
        while (s.endsWith('/')) s = s.slice(0, -1);
        return s;
    }

    // 判断输入是否已是完整 API 接口地址（含 /api.php 或 /provide）
    function looksLikeApiUrl(input) {
        return /\/(api\.php|index\.php|provide)/i.test(input);
    }

    async function tryUrl(baseUrl) {
        const sep = baseUrl.includes('?') ? '&' : '?';
        const apiUrl = baseUrl + sep + PROBE_PARAMS;
        const start = performance.now();
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), TIMEOUT);
        try {
            const proxied = (window.ProxyAuth && window.ProxyAuth.addAuthToProxyUrl)
                ? await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(apiUrl))
                : PROXY_URL + encodeURIComponent(apiUrl);
            const headers = (window.API_CONFIG && window.API_CONFIG.search && window.API_CONFIG.search.headers) || {};
            const resp = await fetch(proxied, { headers, signal: controller.signal });
            const latencyMs = Math.round(performance.now() - start);
            clearTimeout(tid);
            if (!resp.ok) {
                return { ok: false, reason: 'HTTP ' + resp.status, latencyMs };
            }
            const text = await resp.text();
            let ok = false, info = '';
            try {
                const data = JSON.parse(text);
                ok = !!(data && (data.code === 1 || Array.isArray(data.list)));
                info = ok ? 'code=' + data.code + ' list=' + ((data.list || []).length) : 'code=' + data.code;
            } catch (e) {
                info = '非JSON返回';
            }
            return { ok, reason: ok ? null : info, latencyMs, info };
        } catch (e) {
            clearTimeout(tid);
            const reason = (e && e.name === 'AbortError') ? '超时' : (e && e.message ? e.message : '网络错误');
            return { ok: false, reason, latencyMs: Math.round(performance.now() - start) };
        }
    }

    // 自动探测主入口
    // 返回 { ok, baseUrl(去掉查询参数), name, latencyMs, reason, tried:[{url,ok,reason,latencyMs}] }
    async function autoDetect(input) {
        const norm = normalize(input);
        if (!norm) return { ok: false, reason: '请输入地址' };
        const name = deriveName(norm);
        const tried = [];

        let bases;
        if (looksLikeApiUrl(norm)) {
            bases = [norm]; // 用户已给完整接口地址，直接验证
        } else {
            // 仅给域名：依次尝试候选路径
            bases = CANDIDATE_PATHS.map(p => norm + p);
        }

        for (const b of bases) {
            const r = await tryUrl(b);
            const entry = { url: b, ok: r.ok, reason: r.reason, latencyMs: r.latencyMs };
            tried.push(entry);
            if (r.ok) {
                return {
                    ok: true,
                    baseUrl: b.split('?')[0], // 去掉探测用的查询参数
                    name,
                    latencyMs: r.latencyMs,
                    reason: null,
                    tried
                };
            }
        }
        return {
            ok: false,
            baseUrl: null,
            name,
            latencyMs: null,
            reason: '未找到可用接口（可能该站非苹果CMS V10 格式，或域名已失效/被墙）',
            tried
        };
    }

    function deriveName(norm) {
        try {
            const u = new URL(norm);
            return u.hostname.replace(/^www\./, '');
        } catch (e) {
            return norm;
        }
    }

    return {
        autoDetect,
        normalize,
        looksLikeApiUrl,
        CANDIDATE_PATHS
    };
})();
window.AddSource = AddSource;
