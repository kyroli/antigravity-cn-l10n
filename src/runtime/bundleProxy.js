const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const vm = require('vm');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const LS_TLS_AGENT = new https.Agent({ rejectUnauthorized: false });
const isLoopbackHost = hostname => LOOPBACK_HOSTS.has(String(hostname || '').toLowerCase());

function validateUpstreamBundleUrl(rawSrc) {
    if (!rawSrc || typeof rawSrc !== 'string') return null;
    try {
        const u = new URL(rawSrc);
        return (u.protocol === 'https:' && isLoopbackHost(u.hostname) && u.pathname === '/main.js') ? u : null;
    } catch (e) { return null; }
}

function writeAtomic(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, content);
    try { fs.renameSync(tmp, filePath); }
    catch (e) { try { fs.rmSync(tmp, { force: true }); } catch (_) {} throw e; }
}

function fetchUpstreamBundle(targetUrl, etag, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: targetUrl.hostname,
            port: targetUrl.port || 443,
            path: `${targetUrl.pathname}${targetUrl.search}`,
            method: 'GET',
            agent: LS_TLS_AGENT,
            headers: etag ? { 'If-None-Match': etag } : {},
            timeout: timeoutMs
        }, res => {
            const status = res.statusCode || 0;
            const respEtag = typeof res.headers.etag === 'string' ? res.headers.etag : '';
            if (status === 304) { res.resume(); return resolve({ status: 304, etag: respEtag || etag, body: null }); }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status, etag: respEtag, body: Buffer.concat(chunks) }));
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error(`上游 bundle 请求超时 (${timeoutMs}ms)`)));
        req.on('error', reject);
        req.end();
    });
}

function createBundleProxyServer(opts = {}) {
    const {
        translator,
        hubConfig = {},
        dictsHash = '0',
        bundleRewriter,
        cacheDir = path.join(os.tmpdir(), 'ag-l10n-cache')
    } = opts;

    const token = crypto.randomBytes(16).toString('hex');
    const cacheKey = String(dictsHash || '0').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12) || '0';
    const cacheJsPath = path.join(cacheDir, `main.${cacheKey}.js`);
    const cacheMetaPath = path.join(cacheDir, `main.${cacheKey}.meta.json`);
    let inFlightBuild = null;

    async function resolveRewrittenBundle(upstreamUrl) {
        let meta = null;
        try { if (fs.existsSync(cacheMetaPath)) meta = JSON.parse(fs.readFileSync(cacheMetaPath, 'utf8')); } catch (_) {}
        const hasCache = Boolean(meta?.etag && fs.existsSync(cacheJsPath));
        const upstream = await fetchUpstreamBundle(upstreamUrl, hasCache ? meta.etag : '');
        if (upstream.status === 304 && hasCache) return fs.readFileSync(cacheJsPath);
        if (upstream.status !== 200 || !upstream.body) throw new Error(`上游 /main.js 响应异常: HTTP ${upstream.status}`);

        const rawBuf = upstream.body;
        try {
            const rewritten = bundleRewriter.rewriteBundleSource(rawBuf.toString('utf8'), translator, hubConfig);
            new vm.Script(rewritten.code, { filename: 'main.js' });
            const outBuf = Buffer.from(rewritten.code, 'utf8');
            if (upstream.etag) {
                try {
                    writeAtomic(cacheJsPath, outBuf);
                    writeAtomic(cacheMetaPath, JSON.stringify({ etag: upstream.etag, dictsHash, stats: rewritten.stats, updatedAt: Date.now() }));
                } catch (_) {}
            }
            return outBuf;
        } catch (err) {
            console.error('[ANTIGRAVITY_BUNDLE_PROXY_FALLBACK]', err?.message || err);
            return rawBuf;
        }
    }

    const server = http.createServer(async (req, res) => {
        try {
            const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
            if (reqUrl.pathname !== `/${token}/main.js`) { res.writeHead(403); res.end('Forbidden'); return; }
            if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
            const upstreamUrl = validateUpstreamBundleUrl(reqUrl.searchParams.get('src'));
            if (!upstreamUrl) { res.writeHead(403); res.end('Forbidden'); return; }

            if (!inFlightBuild) {
                inFlightBuild = resolveRewrittenBundle(upstreamUrl).finally(() => { inFlightBuild = null; });
            }
            const payload = await inFlightBuild;
            res.writeHead(200, {
                'Content-Type': 'text/javascript; charset=utf-8',
                'Content-Length': String(payload.length),
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
                'Cross-Origin-Resource-Policy': 'cross-origin'
            });
            res.end(payload);
        } catch (err) {
            console.error('[ANTIGRAVITY_BUNDLE_PROXY_ERROR]', err);
            if (!res.headersSent) res.writeHead(502);
            res.end();
        }
    });

    const start = () => new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            server.unref();
            resolve({ port: server.address().port, token, cacheJsPath, cacheMetaPath });
        });
    });
    const close = () => new Promise(resolve => { try { server.close(() => resolve()); } catch (e) { resolve(); } });

    return { server, token, cacheJsPath, cacheMetaPath, start, close };
}

function installBundleProxy(electron, opts = {}) {
    if (!electron || electron._agL10nBundleProxyInstalled) return null;
    const { app, session } = electron;
    const defaultSes = session?.defaultSession;
    if (!app || typeof defaultSes?.webRequest?.onBeforeRequest !== 'function') return null;

    Object.defineProperty(electron, '_agL10nBundleProxyInstalled', { value: true });
    let cacheDir;
    try { cacheDir = path.join(app.getPath('userData'), 'ag-l10n-cache'); }
    catch (e) { cacheDir = path.join(os.tmpdir(), 'ag-l10n-cache'); }

    const proxy = createBundleProxyServer({ ...opts, cacheDir });
    const ready = proxy.start().then(({ port, token }) => {
        defaultSes.webRequest.onBeforeRequest(
            { urls: ['https://127.0.0.1:*/main.js*', 'https://localhost:*/main.js*'] },
            (details, callback) => {
                try {
                    if (details?.method === 'GET') {
                        const u = new URL(details.url);
                        if (u.pathname === '/main.js' && isLoopbackHost(u.hostname)) {
                            callback({ redirectURL: `http://127.0.0.1:${port}/${token}/main.js?src=${encodeURIComponent(details.url)}` });
                            return;
                        }
                    }
                } catch (e) {}
                callback({});
            }
        );
        return { port, token };
    }).catch(err => {
        console.error('[ANTIGRAVITY_BUNDLE_PROXY_INIT_ERROR]', err);
        return null;
    });

    app.on?.('will-quit', () => { proxy.close(); });
    return { proxy, ready };
}

module.exports = { validateUpstreamBundleUrl, createBundleProxyServer, installBundleProxy };
