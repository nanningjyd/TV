// js/updateSources.js
// “更新 / 搜索视频源”功能：
//   1) 拉取维护源清单（站点自身 sources.json）
//   2) 扫描可增删的 GitHub 仓库（默认即本项目，可在设置里添加社区 fork 的 sources.json）
//   3) 自动发现当前没有的新源
//   4) 对新源做健康检查（复用 SourceHealth）
//   5) 差异弹窗：可“本机预览更新”（写入 localStorage，立即生效，刷新仍在）或“提交全站”
//      （POST /api/updatesources，由 Cloudflare Function 写回仓库并触发自动部署）

const UpdateSources = (function () {
    const MAINTAINED = 'sources.json';                 // 同域维护清单
    const DEFAULT_SCAN_REPOS = [                        // 默认扫描仓库（可增删）
        { owner: 'nanningjyd', repo: 'TV', branch: 'main', path: 'sources.json' }
    ];
    const SCAN_KEY = 'sourceScanRepos';

    function getScanRepos() {
        try {
            const r = JSON.parse(localStorage.getItem(SCAN_KEY));
            if (Array.isArray(r) && r.length) return r;
        } catch (e) { /* ignore */ }
        return DEFAULT_SCAN_REPOS.slice();
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

    // 经 /proxy/ 抓取任意 JSON（跨域用代理规避 CORS）
    async function fetchJsonViaProxy(url) {
        const proxied = window.ProxyAuth && window.ProxyAuth.addAuthToProxyUrl
            ? await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(url))
            : PROXY_URL + encodeURIComponent(url);
        const resp = await fetch(proxied, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
    }

    async function fetchMaintained() {
        try {
            const resp = await fetch(MAINTAINED, { cache: 'no-store' });
            if (!resp.ok) return null;
            const j = await resp.json();
            return (j && j.API_SITES) ? j.API_SITES : null;
        } catch (e) {
            return null;
        }
    }

    async function fetchRepoSources(repo) {
        const branch = repo.branch || 'main';
        const path = repo.path || 'sources.json';
        const raw = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${branch}/${path}`;
        try {
            const j = await fetchJsonViaProxy(raw);
            return (j && j.API_SITES) ? j.API_SITES : null;
        } catch (e) {
            console.warn('扫描仓库失败:', repo, e);
            return null;
        }
    }

    function mergeInto(all, sites, knownApiUrls, added) {
        Object.keys(sites || {}).forEach(code => {
            const site = sites[code];
            if (!site || !site.api) return;
            if (all[code]) return;                 // 已收录
            all[code] = site;
            if (!knownApiUrls.has(normalizeUrl(site.api))) {
                added[code] = site;                // 新发现
            }
        });
    }

    // 发现新源：返回 { all, added }
    async function discover(onStatus) {
        const all = {};
        const added = {};
        const knownApiUrls = new Set();
        // 当前已知源（内置 + 已扩展预览）
        Object.values(window.API_SITES || {}).forEach(s => {
            if (s && s.api) knownApiUrls.add(normalizeUrl(s.api));
        });

        if (onStatus) onStatus('正在拉取维护源清单…');
        const maintained = await fetchMaintained();
        if (maintained) mergeInto(all, maintained, knownApiUrls, added);

        const repos = getScanRepos();
        for (let i = 0; i < repos.length; i++) {
            if (onStatus) onStatus(`正在扫描仓库 ${repos[i].owner}/${repos[i].repo} (${i + 1}/${repos.length})…`);
            const s = await fetchRepoSources(repos[i]);
            if (s) mergeInto(all, s, knownApiUrls, added);
        }
        return { all, added };
    }

    return {
        discover,
        getScanRepos,
        setScanRepos,
        MAINTAINED,
        DEFAULT_SCAN_REPOS
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
    statusEl.textContent = '开始发现视频源…';
    resultsEl.innerHTML = '<div class="text-gray-500">正在分析，请稍候…</div>';

    try {
        const { all, added } = await UpdateSources.discover(msg => { statusEl.textContent = msg; });
        _discovered = { all, added };

        const addedCodes = Object.keys(added);
        if (addedCodes.length) {
            statusEl.textContent = `发现 ${addedCodes.length} 个新源，正在进行健康检查…`;
            const results = await SourceHealth.checkMany(addedCodes, {
                concurrency: 5,
                onProgress: (d, t) => { statusEl.textContent = `健康检查 ${d}/${t}…`; }
            });
            renderUpdateResults(results, added);
            if (btnP) btnP.disabled = false;
            if (btnC) btnC.disabled = false;
        } else {
            statusEl.textContent = '未发现有差异的新视频源（当前已是最新）。';
            resultsEl.innerHTML = '<div class="text-gray-400 py-4 text-center">扫描到的源都已在列表中，无需更新。</div>';
        }
    } catch (e) {
        statusEl.textContent = '更新失败：' + (e && e.message ? e.message : e);
    }
}

function renderUpdateResults(results, added) {
    const resultsEl = document.getElementById('updateSourcesResults');
    if (!resultsEl) return;
    let html = '<div class="text-gray-400 mb-2">新发现源（绿=可用 / 红=不可用）：</div>';
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
        // 合并：当前 API_SITES（含已预览扩展的） + 本次新增
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
        const pathLabel = (r.path && r.path !== 'sources.json') ? '/' + r.path : '';
        return `<div class="flex items-center justify-between bg-[#222] rounded px-2 py-1 mb-1">
            <span class="text-xs text-gray-300 truncate">${r.owner}/${r.repo}${branchLabel}<span class="text-gray-500">(${r.path || 'sources.json'}${pathLabel})</span></span>
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
