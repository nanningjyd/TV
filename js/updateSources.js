// js/updateSources.js
// “更新 / 搜索视频源”功能：
//   核心目标：从 GITHUB 上【其他经常维护的仓库】自动发现本站没有的新视频源，
//            而不是从本站自己仓库里已有的源“自己更新自己”。
//   流程：
//   1) 以“当前已激活的源”（内置 + 本机预览扩展 + 自定义）作为已知基线
//   2) 扫描可增删的【外部 GitHub 仓库】列表（默认是活跃社区 fork，路径多为 js/config.js 或 sources.json）
//   3) 对每个外部仓库抽取其 API_SITES（兼容 sources.json 的 JSON 与 js/config.js 的内联对象）
//   4) 找出基线中不存在的新源，做健康检查（复用 SourceHealth）
//   5) 差异弹窗：可“本机预览更新”（写入 localStorage 立即生效）或“提交全站”
//      （POST /api/updatesources，由 Cloudflare Function 把【合并后的全量源】写回本站 sources.json 并触发自动部署）
//
//   注意：本站自己的 sources.json 只作为“提交全站”时的【写入目标】，不参与发现过程。

const UpdateSources = (function () {
    // 默认扫描仓库：其他【活跃维护】的 LibreTV 社区 fork（它们把源内联在 js/config.js 的 API_SITES 中）。
    // 这些仓库与本站结构一致，能持续提供新源。用户可在设置里增删。
    const DEFAULT_SCAN_REPOS = [
        { owner: 'queendou',  repo: 'LibreTV', branch: 'main', path: 'js/config.js' },
        { owner: 'luosenSvip', repo: 'LibreTV', branch: 'main', path: 'js/config.js' }
    ];
    const SCAN_KEY = 'sourceScanRepos';

    function getScanRepos() {
        let stored = [];
        try {
            const raw = localStorage.getItem(SCAN_KEY);
            if (raw) {
                const r = JSON.parse(raw);
                if (Array.isArray(r)) stored = r;
            }
        } catch (e) { /* ignore */ }
        // 迁移：剔除旧的“本站自身仓库”默认项（它不属于“外部发现”的本意）
        stored = stored.filter(x => !(x && x.owner === 'nanningjyd' && x.repo === 'TV'));
        // 默认外部仓库始终存在，并与用户手动添加的仓库合并（去重）
        const merged = DEFAULT_SCAN_REPOS.slice();
        stored.forEach(s => {
            const dup = merged.some(m =>
                m.owner === s.owner && m.repo === s.repo &&
                (m.branch || 'main') === (s.branch || 'main') &&
                (m.path || 'sources.json') === (s.path || 'sources.json'));
            if (!dup) merged.push(s);
        });
        return merged;
    }

    function setScanRepos(arr) {
        try { localStorage.setItem(SCAN_KEY, JSON.stringify(arr)); } catch (e) { /* ignore */ }
        if (typeof renderScanRepos === 'function') renderScanRepos();
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

    // 抽取某仓库的 API_SITES：先尝试 JSON(含 API_SITES)，否则按 JS 文本解析
    async function fetchRepoSources(repo) {
        const branch = repo.branch || 'main';
        const path = repo.path || 'sources.json';
        const raw = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${branch}/${path}`;
        try {
            const text = await fetchTextViaProxy(raw);
            // 1) JSON 形式（本站/部分仓库的 sources.json）
            try {
                const j = JSON.parse(text);
                if (j && j.API_SITES) return j.API_SITES;
            } catch (e) { /* 不是 JSON，继续按 JS 处理 */ }
            // 2) JS 形式（js/config.js 内联 API_SITES）
            const fromJs = extractApiSitesFromJs(text);
            return fromJs;
        } catch (e) {
            console.warn('扫描仓库失败:', repo, e);
            return null;
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

    // 发现新源：基线(已激活) vs 外部仓库 -> 返回 { all, added }
    //   added = 外部仓库中有、基线中没有的源
    //   all   = 基线 + added（提交全站时写回的合并全量）
    async function discover(onStatus) {
        const added = {};
        const knownApiUrls = new Set();
        const knownCodes = new Set();
        collectActive(knownApiUrls, knownCodes);

        const repos = getScanRepos();
        for (let i = 0; i < repos.length; i++) {
            if (onStatus) onStatus(`正在扫描外部仓库 ${repos[i].owner}/${repos[i].repo} (${i + 1}/${repos.length})…`);
            const sites = await fetchRepoSources(repos[i]);
            if (!sites) continue;
            Object.keys(sites).forEach(code => {
                const site = sites[code];
                if (!site || !site.api) return;
                if (knownCodes.has(code)) return;                       // 已收录（同 code）
                if (knownApiUrls.has(normalizeUrl(site.api))) return;   // 已收录（同 api 地址）
                added[code] = site;                                    // 外部新源
            });
        }

        const all = Object.assign({}, window.API_SITES, added);
        return { all, added };
    }

    return {
        discover,
        getScanRepos,
        setScanRepos,
        DEFAULT_SCAN_REPOS,
        extractApiSitesFromJs
    };
})();

window.UpdateSources = UpdateSources;

/* ===================== 以下为 UI / 流程函数（供 index.html onclick 调用） ===================== */

let _discovered = null;   // { all, added }

async function openUpdateSources() {
    const modal = document.getElementById('updateSourcesModal');
    if (!modal) return;
    modal.classList.remove('hidden');

    const statusEl = document.getElementById('updateSourcesStatus');
    const resultsEl = document.getElementById('updateSourcesResults');
    const btnP = document.getElementById('btnPreviewSources');
    const btnC = document.getElementById('btnCommitSources');
    if (btnP) btnP.disabled = true;
    if (btnC) btnC.disabled = true;
    statusEl.textContent = '开始从外部 GitHub 仓库发现新视频源…';
    resultsEl.innerHTML = '<div class="text-gray-500">正在分析，请稍候…</div>';

    try {
        const { all, added } = await UpdateSources.discover(msg => { statusEl.textContent = msg; });
        _discovered = { all, added };

        const addedCodes = Object.keys(added);
        if (addedCodes.length) {
            statusEl.textContent = `从外部仓库发现 ${addedCodes.length} 个新源，正在进行健康检查…`;
            const results = await SourceHealth.checkMany(addedCodes, {
                concurrency: 5,
                onProgress: (d, t) => { statusEl.textContent = `健康检查 ${d}/${t}…`; }
            });
            renderUpdateResults(results, added);
            if (btnP) btnP.disabled = false;
            if (btnC) btnC.disabled = false;
        } else {
            statusEl.textContent = '未发现新的视频源（当前已是最新，或外部仓库暂无新增）。';
            resultsEl.innerHTML = '<div class="text-gray-400 py-4 text-center">扫描的外部仓库里没有比本站更多的新源，无需更新。</div>';
        }
    } catch (e) {
        statusEl.textContent = '更新失败：' + (e && e.message ? e.message : e);
    }
}

function renderUpdateResults(results, added) {
    const resultsEl = document.getElementById('updateSourcesResults');
    if (!resultsEl) return;
    let html = '<div class="text-gray-400 mb-2">从外部仓库新发现的源（绿=可用 / 红=不可用）：</div>';
    Object.keys(added).forEach(code => {
        const r = results[code] || { alive: null, latencyMs: null, error: '未检测' };
        const dot = r.alive === true ? 'bg-green-400' : (r.alive === false ? 'bg-red-400' : 'bg-gray-500');
        const lat = r.latencyMs != null ? r.latencyMs + 'ms' : '';
        const err = r.error ? ` <span class="text-red-400">(${r.error})</span>` : '';
        const site = added[code];
        html += `<div class="flex items-center justify-between bg-[#191919] rounded px-2 py-1 mb-1">
            <div class="truncate"><span class="inline-block w-2 h-2 rounded-full ${dot} mr-2 align-middle"></span>${site.name || code} <span class="text-gray-500 text-xs">${site.api}</span></div>
            <div class="text-xs text-gray-400 whitespace-nowrap ml-2">${lat}${err}</div>
        </div>`;
    });
    resultsEl.innerHTML = html;
}

function closeUpdateSources() {
    const modal = document.getElementById('updateSourcesModal');
    if (modal) modal.classList.add('hidden');
}

function previewUpdatedSources() {
    if (!_discovered) return;
    const sites = _discovered.added;
    if (!sites || !Object.keys(sites).length) {
        showToast('没有可预览的新源', 'info');
        return;
    }
    if (typeof extendAPISites === 'function') extendAPISites(sites);
    // 持久化到 localStorage，刷新后仍生效（未提交全站）
    try {
        const prev = JSON.parse(localStorage.getItem('extendedAPISites') || '{}');
        Object.assign(prev, sites);
        localStorage.setItem('extendedAPISites', JSON.stringify(prev));
    } catch (e) { /* ignore */ }
    if (typeof renderApiCheckboxes === 'function') renderApiCheckboxes();
    if (typeof updateSelectedApiCount === 'function') updateSelectedApiCount();
    showToast('已在本机预览更新 ' + Object.keys(sites).length + ' 个新源（刷新后仍生效，未提交全站）', 'success');
}

async function commitUpdatedSources() {
    if (!_discovered) return;
    const btnC = document.getElementById('btnCommitSources');
    const original = btnC ? btnC.textContent : '';
    if (btnC) { btnC.disabled = true; btnC.textContent = '提交中…'; }
    try {
        // 合并：当前激活源（含已预览扩展的） + 本次从外部发现的新源
        const merged = Object.assign({}, window.API_SITES, _discovered.added);
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

function renderScanRepos() {
    const el = document.getElementById('scanReposList');
    if (!el) return;
    const repos = UpdateSources.getScanRepos();
    if (!repos.length) {
        el.innerHTML = '<div class="text-xs text-gray-500 text-center py-1">暂无扫描仓库</div>';
        return;
    }
    el.innerHTML = repos.map((r, i) => {
        const branchLabel = (r.branch && r.branch !== 'main') ? '@' + r.branch : '';
        const pathLabel = (r.path && r.path !== 'sources.json') ? ' › ' + r.path : '';
        return `<div class="flex items-center justify-between bg-[#222] rounded px-2 py-1 mb-1">
            <span class="text-xs text-gray-300 truncate">${r.owner}/${r.repo}${branchLabel}<span class="text-gray-500">${pathLabel}</span></span>
            <button onclick="removeScanRepo(${i})" class="text-red-500 hover:text-red-700 text-xs px-1 flex-shrink-0">✕</button>
        </div>`;
    }).join('');
}

function addScanRepo() {
    const inp = document.getElementById('scanRepoInput');
    if (!inp) return;
    const val = (inp.value || '').trim();
    if (!val) return;
    // 支持：owner/repo 或 owner/repo@branch 或 owner/repo@branch/path
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
    if (slash < 0) { showToast('格式应为 owner/repo', 'warning'); return; }
    owner = main.slice(0, slash);
    repo = main.slice(slash + 1);
    if (!owner || !repo) { showToast('格式应为 owner/repo', 'warning'); return; }

    const repos = UpdateSources.getScanRepos();
    if (repos.some(r => r.owner === owner && r.repo === repo && (r.branch || 'main') === branch && (r.path || 'sources.json') === path)) {
        showToast('该仓库已在列表中', 'warning');
        return;
    }
    repos.push({ owner, repo, branch, path });
    UpdateSources.setScanRepos(repos);
    inp.value = '';
    showToast('已添加扫描仓库', 'success');
}

function removeScanRepo(i) {
    const repos = UpdateSources.getScanRepos();
    repos.splice(i, 1);
    UpdateSources.setScanRepos(repos);
}
