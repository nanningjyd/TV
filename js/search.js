async function searchByAPIAndKeyWord(apiId, query) {
    try {
        let apiUrl, apiName, apiBaseUrl;

        // 网盘源（PanHub）分支：接口形态与普通苹果CMS源不同，单独处理
        if (API_SITES[apiId] && API_SITES[apiId].type === 'pan') {
            return await searchPanHub(API_SITES[apiId].api, apiId, API_SITES[apiId].name, query);
        }

        // 处理自定义API
        if (apiId.startsWith('custom_')) {
            const customIndex = apiId.replace('custom_', '');
            const customApi = getCustomApiInfo(customIndex);
            if (!customApi) return [];
            
            apiBaseUrl = customApi.url;
            apiUrl = apiBaseUrl + API_CONFIG.search.path + encodeURIComponent(query);
            apiName = customApi.name;
        } else {
            // 内置API
            if (!API_SITES[apiId]) return [];
            apiBaseUrl = API_SITES[apiId].api;
            apiUrl = apiBaseUrl + API_CONFIG.search.path + encodeURIComponent(query);
            apiName = API_SITES[apiId].name;
        }
        
        // 添加超时处理
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        
        // 添加鉴权参数到代理URL
        const proxiedUrl = await window.ProxyAuth?.addAuthToProxyUrl ? 
            await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(apiUrl)) :
            PROXY_URL + encodeURIComponent(apiUrl);
        
        const response = await fetch(proxiedUrl, {
            headers: API_CONFIG.search.headers,
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            return [];
        }
        
        const data = await response.json();
        
        if (!data || !data.list || !Array.isArray(data.list) || data.list.length === 0) {
            return [];
        }
        
        // 处理第一页结果
        const results = data.list.map(item => ({
            ...item,
            source_name: apiName,
            source_code: apiId,
            api_url: apiId.startsWith('custom_') ? getCustomApiInfo(apiId.replace('custom_', ''))?.url : undefined
        }));
        
        // 获取总页数
        const pageCount = data.pagecount || 1;
        // 确定需要获取的额外页数 (最多获取maxPages页)
        const pagesToFetch = Math.min(pageCount - 1, API_CONFIG.search.maxPages - 1);
        
        // 如果有额外页数，获取更多页的结果
        if (pagesToFetch > 0) {
            const additionalPagePromises = [];
            
            for (let page = 2; page <= pagesToFetch + 1; page++) {
                // 构建分页URL
                const pageUrl = apiBaseUrl + API_CONFIG.search.pagePath
                    .replace('{query}', encodeURIComponent(query))
                    .replace('{page}', page);
                
                // 创建获取额外页的Promise
                const pagePromise = (async () => {
                    try {
                        const pageController = new AbortController();
                        const pageTimeoutId = setTimeout(() => pageController.abort(), 15000);
                        
                        // 添加鉴权参数到代理URL
                        const proxiedPageUrl = await window.ProxyAuth?.addAuthToProxyUrl ? 
                            await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(pageUrl)) :
                            PROXY_URL + encodeURIComponent(pageUrl);
                        
                        const pageResponse = await fetch(proxiedPageUrl, {
                            headers: API_CONFIG.search.headers,
                            signal: pageController.signal
                        });
                        
                        clearTimeout(pageTimeoutId);
                        
                        if (!pageResponse.ok) return [];
                        
                        const pageData = await pageResponse.json();
                        
                        if (!pageData || !pageData.list || !Array.isArray(pageData.list)) return [];
                        
                        // 处理当前页结果
                        return pageData.list.map(item => ({
                            ...item,
                            source_name: apiName,
                            source_code: apiId,
                            api_url: apiId.startsWith('custom_') ? getCustomApiInfo(apiId.replace('custom_', ''))?.url : undefined
                        }));
                    } catch (error) {
                        console.warn(`API ${apiId} 第${page}页搜索失败:`, error);
                        return [];
                    }
                })();
                
                additionalPagePromises.push(pagePromise);
            }
            
            // 等待所有额外页的结果
            const additionalResults = await Promise.all(additionalPagePromises);
            
            // 合并所有页的结果
            additionalResults.forEach(pageResults => {
                if (pageResults.length > 0) {
                    results.push(...pageResults);
                }
            });
        }
        
        return results;
    } catch (error) {
        console.warn(`API ${apiId} 搜索失败:`, error);
        return [];
    }
}

/**
 * 网盘源搜索（PanHub）：把各网盘分享链接归一化为 LibreTV 结果形状。
 * PanHub 返回的是各网盘的分享页链接（非播放直链），由前端以弹窗内嵌/打开方式呈现。
 */
async function searchPanHub(apiBaseUrl, apiId, apiName, query) {
    try {
        const cfg = window.PAN_CONFIG && window.PAN_CONFIG.search;
        if (!cfg) return [];

        // 构建 PanHub 搜索 URL：/api/search?kw=<q>&res=merged_by_type&src=all
        const targetUrl = apiBaseUrl + cfg.path + encodeURIComponent(query) + cfg.params;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        // 经内部代理出网（PanHub 无 CORS 头，且代理自带鉴权）
        const proxiedUrl = await (window.ProxyAuth && window.ProxyAuth.addAuthToProxyUrl
            ? window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(targetUrl))
            : Promise.resolve(PROXY_URL + encodeURIComponent(targetUrl)));

        const response = await fetch(proxiedUrl, {
            headers: cfg.headers,
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (response.status === 429) {
            console.warn(`网盘源 ${apiId} 触发限流（10次/分），请稍后重试`);
            return [];
        }
        if (!response.ok) return [];

        const data = await response.json();
        if (!data || data.code !== 0 || !data.data || !data.data.merged_by_type) {
            return [];
        }

        const merged = data.data.merged_by_type;
        const labels = (window.PAN_CONFIG && window.PAN_CONFIG.cloudLabels) || {};
        const results = [];

        // merged_by_type: { quark: [{url,password,note,datetime}], aliyun: [...], ... }
        Object.keys(merged).forEach(cloudType => {
            const list = merged[cloudType];
            if (!Array.isArray(list)) return;
            const cloudLabel = labels[cloudType] || cloudType;
            list.forEach(item => {
                const url = item.url || '';
                const password = item.password || '';
                if (!url) return;
                results.push({
                    type: 'pan',
                    vod_id: url,                 // 分享页链接本身即可作为唯一标识
                    vod_name: item.note || query,
                    vod_pic: '',
                    type_name: cloudLabel,
                    vod_year: '',
                    vod_remarks: password ? ('提取码: ' + password) : '无提取码',
                    source_name: apiName,
                    source_code: apiId,
                    pan_url: url,
                    pan_password: password,
                    pan_cloud: cloudType,
                    pan_datetime: item.datetime || ''
                });
            });
        });

        // 按发布时间倒序（越新越靠前），无时间排最后
        results.sort((a, b) => {
            const ta = a.pan_datetime ? (Date.parse(a.pan_datetime) || 0) : 0;
            const tb = b.pan_datetime ? (Date.parse(b.pan_datetime) || 0) : 0;
            return tb - ta;
        });

        return results;
    } catch (error) {
        console.warn(`网盘源 ${apiId} 搜索失败:`, error);
        return [];
    }
}