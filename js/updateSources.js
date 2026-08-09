// js/updateSources.js
// “更新 / 搜索视频源”功能：
//   目标：从【其他经常维护的来源】自动发现/同步本站没有或需要刷新的视频源。
//   来源分为两类：
//     1) repo    —— GitHub 仓库（其他社区 fork 的 js/config.js 或 sources.json）
//     2) archive —— 源列表归档页（如官方 telegra.ph 归档，内容为 {code:{api,name}} 形式的文本）
//   说明：LibreTV 的源分发方式已经变化——上游 LibreSpark/LibreTV 的 config.js 已不再内置源，
//        而是把“当前官方源列表”放到 telegra.ph 归档里。所以仅扫描 GitHub fork 已经不够，
//        必须把官方归档也纳入扫描，才能持续拿到新源。
//
//   流程：
//   1) 以“当前已激活的源”（内置 + 本机预览扩展 + 自定义）作为已知基线
//   2) 扫描可增删的【外部来源】（默认：两个活跃社区 fork + 官方 telegra.ph 归档）
//   3) 对每个来源抽取其 API_SITES（兼容 sources.json 的 JSON / js/config.js 内联对象 / 归档页文本）
//   4) 差异：外部池 − 基线 = 新源（做健康检查）；外部池本身 = 可同步全集
//   5) 弹窗：
//        • “合并新源”       —— 仅把新源写入 localStorage（本机立即生效）
//        • “合并全部外部源” —— 把外部全集写入 localStorage（统一同步/刷新，刷新后仍生效）
//        • “提交全站”       —— POST /api/updatesources，把【合并后的全量源】写回本站 sources.json 并触发自动部署
//
//   注意：本站自己的 sources.json 只作为“提交全站”时的【写入目标】，不参与发现过程（基线来自已激活态）。

const UpdateSources = (function () {
    // 默认扫描来源：其他【活跃维护】的 LibreTV 社区 fork + 官方源列表归档。用户可在设置里增删。
    const DEFAULT_SCAN_SOURCES = [
        { kind: 'repo',    owner: 'queendou',   repo: 'LibreTV', branch: 'main', path: 'js/config.js' },
        { kind: 'repo',    owner: 'luosenSvip', repo: 'LibreTV', branch: 'main', path: 'js/config.js' },
        { kind: 'archive', url: 'https://telegra.ph/APIs-08-12', name: '官方源列表(telegra.ph)' }
    ];
    const SCAN_KEY = 'sourceScanSources';        // 新格式：{kind,...}[]
    const SCAN_KEY_OLD = 'sourceScanRepos';       // 旧格式迁移用

    function escapeHtml(s) {
        if (s === null || s === undefined) return '';
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function getScanSources() {
        let stored = [];
        try {
            const raw = localStorage.getItem(SCAN_KEY);
            if (raw) { const r = JSON.parse(raw); if (Array.isArray(r)) stored = r; }
        } catch (e) { /* ignore */ }
        // 迁移：旧格式（仅 repo）转为新格式
        if (!stored.length) {
            try {
                const raw = localStorage.getItem(SCAN_KEY_OLD);
                if (raw) { const r = JSON.parse(raw); if (Array.isArray(r)) stored = r.map(x => ({ kind: 'repo', ...x })); }
            } catch (e) { /* ignore */ }
        }
        // 剔除旧的“本站自身仓库”默认项（不属于“外部发现”的本意）
        stored = stored.filter(x => !(x && x.kind === 'repo' && x.owner === 'nanningjyd' && x.repo === 'TV'));
        // 默认来源始终存在，并与用户手动添加的来源合并（去重）
        const merged = DEFAULT_SCAN_SOURCES.slice();
        stored.forEach(s => {
            if (!merged.some(m => sameSource(m, s))) merged.push(s);
        });
        return merged;
    }

    function sameSource(a, b) {
        if (!a || !b || a.kind !== b.kind) return false;
        if (a.kind === 'repo') {
            return a.owner === b.owner && a.repo === b.repo &&
                (a.branch || 'main') === (b.branch || 'main') &&
                (a.path || 'sources.json') === (b.path || 'sources.json');
        }
        return a.url === b.url;
    }

    function setScanSources(arr) {
        try { localStorage.setItem(SCAN_KEY, JSON.stringify(arr)); } catch (e) { /* ignore */ }
        if (typeof renderScanSources === 'function') renderScanSources();
    }

    function normalizeUrl(u) {
        if (!u) return '';
        try { return new URL(u).href.replace(/\/+$/, ''); }
        catch (e) { return u.replace(/\/+$/, ''); }
    }

    // 经 /proxy/ 抓取任意文本（跨域用代理规避 CORS；文本响应代理正常）
    async function fetchTextViaProxy(url) {
        const proxied = window.ProxyAuth && window.ProxyAuth.addAuthToProxyUrl
            ? await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(url))
            : PROXY_URL + encodeURIComponent(url);
        const resp = await fetch(proxied, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' }
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.text();
    }

    // 从 js/config.js 这类 JS 文本中抽出 API_SITES 对象（兼容未加引号的键与字符串），
    // 并正确处理 // 与 /* */ 注释里的花括号。失败返回 null。
    function extractApiSitesFromJs(text) {
        const idx = text.indexOf('API_SITES');
        if (idx < 0) return null;
        let i = text.indexOf('=', idx);
        if (i < 0) return null;
        i++;
        while (i < text.length && /\s/.test(text[i])) i++;
        if (text[i] !== '{') return null;

        let depth = 0, inStr = null, end = -1;
        for (let j = i; j < text.length; j++) {
            const c = text[j];
            const c2 = text[j + 1];
            if (inStr) {
                if (c === '\\') { j++; continue; }
                if (c === inStr) inStr = null;
                continue;
            }
            if (c === '/' && c2 === '/') {            // 行注释
                while (j < text.length && text[j] !== '\n') j++;
                continue;
            }
            if (c === '/' && c2 === '*') {            // 块注释
                j += 2;
                while (j < text.length && !(text[j] === '*' && text[j + 1] === '/')) j++;
                j++;
                continue;
            }
            if (c === '"' || c === "'") { inStr = c; continue; }
            if (c === '{') depth++;
            else if (c === '}') {
                depth--;
                if (depth === 0) { end = j; break; }
            }
        }
        if (end < 0) return null;
        const objText = text.slice(i, end + 1);
        try {
            // 键未加引号，标准 JSON.parse 不可用，用 Function 求值（源来自管理员/用户配置的公开仓库）
            return (new Function('return (' + objText + ');'))();
        } catch (e) {
            return null;
        }
    }

    // 通用抽取：从任意文本（HTML 归档页 或 JS）中抽出所有 `code: { api:'..', name:'..' }` 条目。
    // 对归档页先去掉 script/style、再去掉 HTML 标签，然后用“逐条 api: 配平花括号”的方式抽取，
    // 这样无论归档内容是否被外层 {} 包裹都能正确解析。失败返回 null。
    function extractApiSitesFromText(text) {
        if (!text) return null;
        // 去掉 script / style 块
        text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ')
                   .replace(/<style[\s\S]*?<\/style>/gi, ' ');
        // 去掉所有 HTML 标签（顺带把 <br>/<p> 等折叠为空格）
        text = text.replace(/<[^>]+>/g, ' ');

        // 解码 HTML 实体：telegra.ph 等归档会把引号编码成 &#39; / &quot;，
        // 不解码会导致字符串引号识别失败、花括号配平崩溃，进而“未找到源”。
        text = text
            .replace(/&#39;/g, "'").replace(/&apos;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&nbsp;/g, ' ');

        const result = {};
        const apiRe = /api\s*:/g;
        let m;
        while ((m = apiRe.exec(text)) !== null) {
            const apiIdx = m.index;
            // 回退到本条条目的开口 '{'
            let k = apiIdx - 1;
            while (k >= 0 && /[a-zA-Z]/.test(text[k])) k--;   // 跳过 'api' 字母
            while (k >= 0 && text[k] === ':') k--;             // 跳过 ':'
            while (k >= 0 && /\s/.test(text[k])) k--;          // 跳过空白
            if (text[k] !== '{') {                            // 兜底：向前找 '{'
                let kk = apiIdx;
                while (kk >= 0 && text[kk] !== '{') kk--;
                if (kk < 0) { apiRe.lastIndex = apiIdx + 4; continue; }
                k = kk;
            }
            const open = k;
            // 配平花括号（字符串 + 注释感知）
            let depth = 0, inStr = null, end = -1;
            for (let x = open; x < text.length; x++) {
                const c = text[x], c2 = text[x + 1];
                if (inStr) {
                    if (c === '\\') { x++; continue; }
                    if (c === inStr) inStr = null;
                    continue;
                }
                if (c === '/' && c2 === '/') { while (x < text.length && text[x] !== '\n') x++; continue; }
                if (c === '/' && c2 === '*') { x += 2; while (x < text.length && !(text[x] === '*' && text[x + 1] === '/')) x++; x++; continue; }
                if (c === '"' || c === "'") { inStr = c; continue; }
                if (c === '{') depth++;
                else if (c === '}') { depth--; if (depth === 0) { end = x; break; } }
            }
            if (end < 0) { apiRe.lastIndex = apiIdx + 4; continue; }
            const objText = text.slice(open, end + 1);
            const before = text.slice(0, open);
            const km = before.match(/([A-Za-z0-9_]+)\s*:\s*$/);
            const key = km ? km[1] : ('src' + Object.keys(result).length);
            try {
                const obj = (new Function('return (' + objText + ');'))();
                if (obj && obj.api) result[key] = obj;
            } catch (e) { /* 跳过畸形条目 */ }
            apiRe.lastIndex = end + 1;
        }
        return Object.keys(result).length ? result : null;
    }

    // 抽取某仓库的 API_SITES：先尝试 JSON(含 API_SITES)，否则按 JS 文本解析
    async function fetchRepoSources(repo, log) {
        const branch = repo.branch || 'main';
        const path = repo.path || 'sources.json';
        const raw = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${branch}/${path}`;
        if (log) log(`开始拉取 ${repo.owner}/${repo.repo}/${path}`);
        try {
            const text = await fetchTextViaProxy(raw);
            if (!text || text.length < 50) {
                if (log) log(`拉取内容过短（${(text || '').length} 字符），可能代理返回了错误页`);
                return { error: '内容过短', sites: null };
            }
            if (log) log(`拉取成功，长度 ${text.length}`);

            // 1) JSON 形式（本站/部分仓库的 sources.json）
            try {
                const j = JSON.parse(text);
                if (j && j.API_SITES) {
                    if (log) log(`解析为 JSON sources.json，共 ${Object.keys(j.API_SITES).length} 个源`);
                    return { error: null, sites: j.API_SITES };
                }
            } catch (e) {
                if (log) log(`不是 JSON 格式: ${e.message}`);
            }

            // 2) JS 形式（js/config.js 内联 API_SITES）
            const fromJs = extractApiSitesFromJs(text);
            if (fromJs && typeof fromJs === 'object' && Object.keys(fromJs).length) {
                if (log) log(`从 JS 中抽出 API_SITES，共 ${Object.keys(fromJs).length} 个源`);
                return { error: null, sites: fromJs };
            }

            const snippet = text.slice(0, 200).replace(/\s+/g, ' ');
            if (log) log(`未能识别 API_SITES，内容开头: ${snippet}`);
            return { error: '未找到 API_SITES', snippet, sites: null };
        } catch (e) {
            if (log) log(`拉取失败: ${e.message || e}`);
            return { error: e.message || String(e), sites: null };
        }
    }

    // 抽取归档页（telegra.ph 等）的 API_SITES：内容为 {code:{api,name}} 形式文本
    async function fetchArchiveSources(src, log) {
        const url = src.url;
        if (log) log(`开始拉取归档源列表 ${url}`);
        try {
            const text = await fetchTextViaProxy(url);
            if (!text || text.length < 50) {
                if (log) log(`拉取内容过短（${(text || '').length} 字符）`);
                return { error: '内容过短', sites: null };
            }
            if (log) log(`拉取成功，长度 ${text.length}`);
            const sites = extractApiSitesFromText(text);
            if (sites && Object.keys(sites).length) {
                if (log) log(`从归档中抽出 ${Object.keys(sites).length} 个源`);
                return { error: null, sites };
            }
            if (log) log(`未能从归档中识别 API_SITES`);
            return { error: '未找到源', sites: null };
        } catch (e) {
            if (log) log(`拉取失败: ${e.message || e}`);
            return { error: e.message || String(e), sites: null };
        }
    }

    // 收集“当前已激活源”的 api URL 与 code，作为已知基线
    function collectActive(knownApiUrls, knownCodes) {
        const collect = (obj) => {
            if (!obj) return;
            Object.keys(obj).forEach(code => {
                knownCodes.add(code);
                const s = obj[code];
                if (s && s.api) knownApiUrls.add(normalizeUrl(s.api));
            });
        };
        collect(window.API_SITES);
        try { collect(JSON.parse(localStorage.getItem('extendedAPISites') || '{}')); } catch (e) { /* ignore */ }
        try {
            const cust = JSON.parse(localStorage.getItem('customAPIs') || '[]');
            (Array.isArray(cust) ? cust : []).forEach(c => {
                if (c && c.url) knownApiUrls.add(normalizeUrl(c.url));
            });
        } catch (e) { /* ignore */ }
    }

    // 发现源：基线(已激活) vs 外部来源 -> 返回 { externalAll, added, diagnostics }
    //   externalAll = 所有外部来源去重后的全集（以 code 为主键，缺 code 时用归一化 api 兜底）
    //   added       = externalAll 中基线没有的源（新源）
    async function discover(onStatus, onLog) {
        const knownApiUrls = new Set();
        const knownCodes = new Set();
        collectActive(knownApiUrls, knownCodes);
        if (onLog) onLog(`基线源(本机已激活): code=${knownCodes.size}, apiUrl=${knownApiUrls.size}`);

        const sources = getScanSources();
        if (onLog) onLog(`扫描来源数: ${sources.length}`);
        const diagnostics = [];
        const externalAll = {};

        for (let i = 0; i < sources.length; i++) {
            const s = sources[i];
            const label = s.kind === 'archive' ? s.url : `${s.owner}/${s.repo}`;
            if (onStatus) onStatus(`正在扫描 ${label} (${i + 1}/${sources.length})…`);
            const res = s.kind === 'archive'
                ? await fetchArchiveSources(s, onLog)
                : await fetchRepoSources(s, onLog);
            diagnostics.push({
                label, kind: s.kind,
                error: res.error,
                count: res.sites ? Object.keys(res.sites).length : 0
            });
            if (!res.sites) continue;
            Object.keys(res.sites).forEach(code => {
                const site = res.sites[code];
                if (!site || !site.api) return;
                const key = (code && code !== '') ? code : ('u_' + normalizeUrl(site.api));
                if (!externalAll[key]) externalAll[key] = site;
            });
        }

        const added = {};
        Object.keys(externalAll).forEach(code => {
            const site = externalAll[code];
            if (knownCodes.has(code)) return;                       // 已收录（同 code）
            if (knownApiUrls.has(normalizeUrl(site.api))) return;   // 已收录（同 api 地址）
            added[code] = site;                                    // 外部新源
        });

        return { externalAll, added, diagnostics, knownCodes, knownApiUrls };
    }

    return {
        discover,
        getScanSources,
        setScanSources,
        DEFAULT_SCAN_SOURCES,
        extractApiSitesFromJs,
        extractApiSitesFromText
    };
})();

window.UpdateSources = UpdateSources;

/* ===================== 以下为 UI / 流程函数（供 index.html onclick 调用） ===================== */

let _discovered = null;   // { externalAll, added }

async function openUpdateSources() {
    const modal = document.getElementById('updateSourcesModal');
    if (!modal) return;
    modal.classList.remove('hidden');

    const statusEl = document.getElementById('updateSourcesStatus');
    const resultsEl = document.getElementById('updateSourcesResults');
    const btnNew = document.getElementById('btnPreviewNew');
    const btnAll = document.getElementById('btnPreviewAll');
    const btnC = document.getElementById('btnCommitSources');
    if (btnNew) btnNew.disabled = true;
    if (btnAll) btnAll.disabled = true;
    if (btnC) btnC.disabled = true;
    const btnEn = document.getElementById('btnEnableUnselected');
    if (btnEn) btnEn.disabled = true;
    statusEl.textContent = '开始从外部来源发现 / 同步视频源…';
    resultsEl.innerHTML = '<div class="text-gray-500">正在分析，请稍候…</div>';

    try {
        const logs = [];
        const pushLog = msg => { logs.push(msg); };
        const { externalAll, added, diagnostics } = await UpdateSources.discover(
            msg => { statusEl.textContent = msg; },
            pushLog
        );
        _discovered = { externalAll, added };

        const addedCodes = Object.keys(added);
        const extCodes = Object.keys(externalAll);

        // 计算“已勾选”的外部源数量（区分“可用池”与“已勾选”，避免和设置里的已选数量混淆）
        const selectedArr = (typeof selectedAPIs !== 'undefined' && Array.isArray(selectedAPIs))
            ? selectedAPIs.filter(c => !String(c).startsWith('custom_'))
            : [];
        const selectedSet = new Set(selectedArr);
        const extUnselected = extCodes.filter(c => !selectedSet.has(c));

        if (addedCodes.length) {
            statusEl.textContent = `从外部来源发现 ${addedCodes.length} 个新源，正在进行健康检查…`;
            const results = await SourceHealth.checkMany(addedCodes, {
                concurrency: 5,
                onProgress: (d, t) => { statusEl.textContent = `健康检查 ${d}/${t}…`; }
            });
            renderUpdateResults(results, added, externalAll, diagnostics, 'new', extUnselected.length);
            if (btnNew) btnNew.disabled = false;
            if (btnAll) btnAll.disabled = extCodes.length === 0;
            if (btnC) btnC.disabled = extCodes.length === 0;
        } else {
            if (extUnselected.length) {
                statusEl.textContent = `未发现新源 —— 外部已知 ${extCodes.length} 个源本机均已可用，但其中 ${extUnselected.length} 个你尚未勾选。`;
            } else {
                statusEl.textContent = `未发现新源 —— 本机已覆盖外部全部 ${extCodes.length} 个已知源（且均已勾选）。`;
            }
            renderUpdateResults({}, added, externalAll, diagnostics, 'uptodate', extUnselected.length);
            if (btnNew) btnNew.disabled = true;
            if (btnAll) btnAll.disabled = extCodes.length === 0;
            if (btnC) btnC.disabled = extCodes.length === 0;
            const btnEn = document.getElementById('btnEnableUnselected');
            if (btnEn) btnEn.disabled = extUnselected.length === 0;
        }
    } catch (e) {
        statusEl.textContent = '更新失败：' + (e && e.message ? e.message : e);
        resultsEl.innerHTML = '<div class="text-red-400 py-2 text-center">' + escapeHtml(String(e)) + '</div>';
    }
}

function renderUpdateResults(results, added, externalAll, diagnostics, mode, unselectedCount) {
    const resultsEl = document.getElementById('updateSourcesResults');
    if (!resultsEl) return;
    let html = '';

    const addedCodes = Object.keys(added || {});
    if (addedCodes.length) {
        html += '<div class="text-gray-400 mb-1">新发现的源（绿=可用 / 红=不可用）：</div>';
        addedCodes.forEach(code => {
            const r = results[code] || { alive: null, latencyMs: null, error: '未检测' };
            const dot = r.alive === true ? 'bg-green-400' : (r.alive === false ? 'bg-red-400' : 'bg-gray-500');
            const lat = r.latencyMs != null ? r.latencyMs + 'ms' : '';
            const err = r.error ? ` <span class="text-red-400">(${escapeHtml(r.error)})</span>` : '';
            const site = added[code];
            html += `<div class="flex items-center justify-between bg-[#191919] rounded px-2 py-1 mb-1">
                <div class="truncate"><span class="inline-block w-2 h-2 rounded-full ${dot} mr-2 align-middle"></span>${escapeHtml(site.name || code)} <span class="text-gray-500 text-xs">${escapeHtml(site.api)}</span></div>
                <div class="text-xs text-gray-400 whitespace-nowrap ml-2">${lat}${err}</div>
            </div>`;
        });
    }

    // 外部已知源清单（本机已覆盖），便于核对 / 全量同步
    const extCodes = Object.keys(externalAll || {});
    if (extCodes.length) {
        const haveCount = extCodes.filter(c => !(added && added[c])).length;
        html += `<div class="text-gray-400 mt-3 mb-1">外部已知源（共 ${extCodes.length} 个，本机已覆盖 ${haveCount} 个）：</div>`;
        const show = extCodes.slice(0, 40);
        html += '<div class="bg-[#0f0f0f] rounded p-2 max-h-40 overflow-auto text-xs text-gray-400 leading-relaxed">';
        show.forEach(code => {
            const site = externalAll[code];
            const isNew = added && added[code];
            const tag = isNew ? '<span class="text-green-400">●新</span> ' : '';
            html += `<div class="truncate">${tag}${escapeHtml(site.name || code)} <span class="text-gray-600">${escapeHtml(site.api || '')}</span></div>`;
        });
        if (extCodes.length > show.length) html += `<div class="text-gray-600">…等 ${extCodes.length} 个</div>`;
        html += '</div>';
    }

    if (mode === 'uptodate') {
        const uc = (typeof unselectedCount === 'number') ? unselectedCount : 0;
        html += '<div class="mt-3 text-xs text-gray-500 bg-[#111] rounded p-2">';
        html += '<div class="mb-1 text-gray-400">说明：当前已激活的源已包含全部外部已知源，故无“新”源。</div>';
        html += `<div class="mb-1">外部共 ${extCodes.length} 个已知源：本机可用池已全部覆盖；其中你已勾选 ${extCodes.length - uc} 个，另有 <span class="text-yellow-400">${uc} 个可用但还没勾选</span>。</div>`;
        if (uc > 0) {
            html += `<div class="mb-1">点下方“启用未勾选源”即可把这 ${uc} 个源加入你的已选列表，搜索时就能用到。</div>`;
        }
        html += '<div class="mb-1">也可点“合并全部外部源”统一刷新本地列表，或“提交全站”把外部全集写回站点。</div>';
        html += '</div>';
        if (diagnostics && diagnostics.length) {
            html += '<div class="mt-2 text-xs text-gray-500 bg-[#111] rounded p-2 max-h-32 overflow-auto"><div class="mb-1 text-gray-400">扫描诊断：</div>';
            diagnostics.forEach(d => {
                if (d.error) {
                    html += `<div class="text-red-400">• ${escapeHtml(d.label)}: ${escapeHtml(d.error)}</div>`;
                } else {
                    html += `<div class="text-green-400">• ${escapeHtml(d.label)}: 解析出 ${d.count} 个源</div>`;
                }
            });
            html += '</div>';
        }
    }

    if (!html) html = '<div class="text-gray-500 py-2 text-center">未扫描到任何外部源。</div>';
    resultsEl.innerHTML = html;
}

function closeUpdateSources() {
    const modal = document.getElementById('updateSourcesModal');
    if (modal) modal.classList.add('hidden');
}

function mergeIntoExtended(sites) {
    if (typeof extendAPISites === 'function') extendAPISites(sites);
    try {
        const prev = JSON.parse(localStorage.getItem('extendedAPISites') || '{}');
        Object.assign(prev, sites);
        localStorage.setItem('extendedAPISites', JSON.stringify(prev));
    } catch (e) { /* ignore */ }
    if (typeof renderApiCheckboxes === 'function') renderApiCheckboxes();
    if (typeof updateSelectedApiCount === 'function') updateSelectedApiCount();
}

function previewNewSources() {
    if (!_discovered || !Object.keys(_discovered.added || {}).length) {
        showToast('没有可预览的新源', 'info');
        return;
    }
    mergeIntoExtended(_discovered.added);
    showToast('已在本机预览更新 ' + Object.keys(_discovered.added).length + ' 个新源（刷新后仍生效，未提交全站）', 'success');
}

function previewAllExternal() {
    if (!_discovered || !Object.keys(_discovered.externalAll || {}).length) {
        showToast('没有外部源可合并', 'info');
        return;
    }
    mergeIntoExtended(_discovered.externalAll);
    showToast('已合并全部外部源 ' + Object.keys(_discovered.externalAll).length + ' 个（刷新后仍生效，未提交全站）', 'success');
}

// 把外部已知但当前未勾选的源，加入“已选列表”（让它们真正出现在搜索可选范围里）
function enableUnselectedSources() {
    if (!_discovered) return;
    const sel = (typeof selectedAPIs !== 'undefined' && Array.isArray(selectedAPIs)) ? selectedAPIs.slice() : [];
    const set = new Set(sel);
    const extCodes = Object.keys(_discovered.externalAll);
    let added = 0;
    extCodes.forEach(c => {
        if (!set.has(c)) { set.add(c); sel.push(c); added++; }
    });
    selectedAPIs = sel;
    try { localStorage.setItem('selectedAPIs', JSON.stringify(selectedAPIs)); } catch (e) { /* ignore */ }
    if (typeof renderApiCheckboxes === 'function') renderApiCheckboxes();
    if (typeof updateSelectedApiCount === 'function') updateSelectedApiCount();
    showToast('已启用 ' + added + ' 个未勾选的源（已加入已选列表）', 'success');
    closeUpdateSources();
}

async function commitUpdatedSources() {
    if (!_discovered) return;
    const btnC = document.getElementById('btnCommitSources');
    const original = btnC ? btnC.textContent : '';
    if (btnC) { btnC.disabled = true; btnC.textContent = '提交中…'; }
    try {
        // 合并：当前激活源 + 本次外部全集（externalAll 已是去重后的外部池）
        const merged = Object.assign({}, window.API_SITES, _discovered.externalAll);
        const payload = { sites: merged };
        const auth = (window.__ENV__ && window.__ENV__.PASSWORD) || '';
        const resp = await fetch('/api/updatesources', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-site-auth': auth },
            body: JSON.stringify(payload)
        });
        const data = await resp.json().catch(() => ({}));
        if (data && data.success) {
            showToast('已提交全站，Cloudflare 将自动重新部署', 'success');
            if (btnC) btnC.textContent = '已提交';
        } else {
            showToast('提交失败：' + (data && data.error ? data.error : ('HTTP ' + resp.status)), 'error');
            if (btnC) { btnC.disabled = false; btnC.textContent = original; }
        }
    } catch (e) {
        showToast('提交出错：' + (e && e.message ? e.message : e), 'error');
        if (btnC) { btnC.disabled = false; btnC.textContent = original; }
    }
}

function renderScanSources() {
    const el = document.getElementById('scanReposList');
    if (!el) return;
    const sources = UpdateSources.getScanSources();
    if (!sources.length) {
        el.innerHTML = '<div class="text-xs text-gray-500 text-center py-1">暂无扫描来源</div>';
        return;
    }
    el.innerHTML = sources.map((s, i) => {
        let label, sub = '';
        if (s.kind === 'archive') {
            label = s.name || s.url;
            sub = '归档';
        } else {
            const branchLabel = (s.branch && s.branch !== 'main') ? '@' + s.branch : '';
            const pathLabel = (s.path && s.path !== 'sources.json') ? ' › ' + s.path : '';
            label = `${s.owner}/${s.repo}${branchLabel}`;
            sub = pathLabel || 'sources.json';
        }
        return `<div class="flex items-center justify-between bg-[#222] rounded px-2 py-1 mb-1">
            <span class="text-xs text-gray-300 truncate"><span class="text-gray-500 mr-1">[${sub}]</span>${escapeHtml(label)}</span>
            <button onclick="removeScanSource(${i})" class="text-red-500 hover:text-red-700 text-xs px-1 flex-shrink-0">✕</button>
        </div>`;
    }).join('');
}

function addScanSource() {
    const inp = document.getElementById('scanRepoInput');
    if (!inp) return;
    const val = (inp.value || '').trim();
    if (!val) return;

    const sources = UpdateSources.getScanSources();

    // 归档 URL（telegra.ph 等源列表页）
    if (/^https?:\/\//i.test(val) || val.includes('telegra.ph')) {
        if (sources.some(s => s.kind === 'archive' && s.url === val)) {
            showToast('该归档已在列表中', 'warning'); return;
        }
        sources.push({ kind: 'archive', url: val, name: val.replace(/^https?:\/\//i, '').slice(0, 40) });
        UpdateSources.setScanSources(sources);
        inp.value = '';
        showToast('已添加归档来源', 'success');
        return;
    }

    // 仓库：owner/repo 或 owner/repo@branch 或 owner/repo@branch/path
    let owner, repo, branch = 'main', path = 'sources.json';
    const at = val.indexOf('@');
    let main = val;
    if (at >= 0) {
        const rest = val.slice(at + 1);
        const slashInRest = rest.indexOf('/');
        branch = (slashInRest >= 0 ? rest.slice(0, slashInRest) : rest) || 'main';
        const p = slashInRest >= 0 ? rest.slice(slashInRest + 1) : '';
        if (p) path = p;
        main = val.slice(0, at);
    }
    const slash = main.indexOf('/');
    if (slash < 0) { showToast('格式应为 owner/repo 或 归档URL', 'warning'); return; }
    owner = main.slice(0, slash);
    repo = main.slice(slash + 1);
    if (!owner || !repo) { showToast('格式应为 owner/repo 或 归档URL', 'warning'); return; }

    if (sources.some(r => r.kind === 'repo' && r.owner === owner && r.repo === repo && (r.branch || 'main') === branch && (r.path || 'sources.json') === path)) {
        showToast('该仓库已在列表中', 'warning');
        return;
    }
    sources.push({ kind: 'repo', owner, repo, branch, path });
    UpdateSources.setScanSources(sources);
    inp.value = '';
    showToast('已添加扫描仓库', 'success');
}

function removeScanSource(i) {
    const sources = UpdateSources.getScanSources();
    sources.splice(i, 1);
    UpdateSources.setScanSources(sources);
}
