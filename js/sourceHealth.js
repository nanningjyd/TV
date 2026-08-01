// js/sourceHealth.js
// 视频源健康检测引擎：复用站点 /proxy/ 代理，对每个源做计时探测。
// 返回结构：{ code, name, alive, latencyMs, error }
// 结果缓存到 localStorage，TTL 10 分钟，避免频繁打源站。
// 供三处共用：搜索结果卡片徽章、电影详情页换源、更新源功能。

const SourceHealth = (function () {
    const CACHE_PREFIX = 'sourceHealth_';
    const TTL = 10 * 60 * 1000;        // 10 分钟
    const PROBE_TIMEOUT = 12000;        // 单次探测超时
    const PROBE_QUERY = '测试';         // 探测用搜索词

    function cacheKey(code) {
        return CACHE_PREFIX + code;
    }

    function getCached(code) {
        try {
            const raw = localStorage.getItem(cacheKey(code));
            if (!raw) return null;
            const obj = JSON.parse(raw);
            if (!obj || (Date.now() - (obj.ts || 0)) > TTL) return null;
            return obj;
        } catch (e) {
            return null;
        }
    }

    function setCached(code, result) {
        try {
            result.ts = Date.now();
            localStorage.setItem(cacheKey(code), JSON.stringify(result));
        } catch (e) { /* 忽略写入失败（隐私模式等） */ }
    }

    // 取得源的 API 基础地址
    function getApiBase(code) {
        if (code && typeof code === 'string' && code.startsWith('custom_')) {
            const idx = parseInt(code.replace('custom_', ''), 10);
            const api = (typeof getCustomApiInfo === 'function') ? getCustomApiInfo(idx) : null;
            return api ? api.url : null;
        }
        return (window.API_SITES && window.API_SITES[code] && window.API_SITES[code].api) || null;
    }

    function getApiName(code) {
        if (code && typeof code === 'string' && code.startsWith('custom_')) {
            const idx = parseInt(code.replace('custom_', ''), 10);
            const api = (typeof getCustomApiInfo === 'function') ? getCustomApiInfo(idx) : null;
            return api ? api.name : code;
        }
        return (window.API_SITES && window.API_SITES[code] && window.API_SITES[code].name) || code;
    }

    // 探测单个源
    async function probe(code) {
        const apiBase = getApiBase(code);
        const name = getApiName(code);
        if (!apiBase) {
            return { code, name, alive: false, latencyMs: null, error: '未知源' };
        }
        const apiUrl = apiBase + API_CONFIG.search.path + encodeURIComponent(PROBE_QUERY);
        const start = performance.now();
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
        try {
            const proxied = window.ProxyAuth && window.ProxyAuth.addAuthToProxyUrl
                ? await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(apiUrl))
                : PROXY_URL + encodeURIComponent(apiUrl);

            const resp = await fetch(proxied, {
                headers: API_CONFIG.search.headers,
                signal: controller.signal
            });
            const latencyMs = Math.round(performance.now() - start);
            clearTimeout(tid);

            if (!resp.ok) {
                return { code, name, alive: false, latencyMs, error: 'HTTP ' + resp.status };
            }
            const data = await resp.json();
            const alive = !!(data && (data.code === 1 || Array.isArray(data.list)));
            return {
                code,
                name,
                alive,
                latencyMs,
                error: alive ? null : '返回格式异常'
            };
        } catch (e) {
            clearTimeout(tid);
            const latencyMs = Math.round(performance.now() - start);
            let err = (e && e.name === 'AbortError') ? '超时' : (e && e.message ? e.message : '网络错误');
            return { code, name, alive: false, latencyMs, error: err };
        }
    }

    // 检查（带缓存）：force 为 true 时跳过缓存
    async function check(code, force) {
        if (!force) {
            const c = getCached(code);
            if (c) return c;
        }
        const r = await probe(code);
        setCached(code, r);
        return r;
    }

    // 批量检查，带并发限制与进度回调
    async function checkMany(codes, opts) {
        opts = opts || {};
        const force = !!opts.force;
        const concurrency = Math.max(1, opts.concurrency || 5);
        const onProgress = opts.onProgress || function () { };
        const results = {};
        const queue = (codes || []).slice();
        let done = 0;
        const total = queue.length;

        async function worker() {
            while (queue.length) {
                const code = queue.shift();
                let r;
                try {
                    r = await check(code, force);
                } catch (e) {
                    r = { code, name: getApiName(code), alive: false, latencyMs: null, error: String(e) };
                }
                results[code] = r;
                done++;
                try { onProgress(done, total, r); } catch (e) { /* ignore */ }
            }
        }

        const n = Math.min(concurrency, total || 1);
        const workers = [];
        for (let i = 0; i < n; i++) workers.push(worker());
        await Promise.all(workers);
        return results;
    }

    return {
        probe,
        check,
        checkMany,
        getCached,
        getApiName,
        TTL
    };
})();

window.SourceHealth = SourceHealth;
