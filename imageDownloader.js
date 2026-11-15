const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { URL } = require('node:url');

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;

const blockedAddresses = new net.BlockList();

for (const [network, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4]
]) {
    blockedAddresses.addSubnet(network, prefix, 'ipv4');
}

for (const [network, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001::', 23],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8]
]) {
    blockedAddresses.addSubnet(network, prefix, 'ipv6');
}

function isBlockedAddress(address) {
    const family = net.isIP(address);
    return family === 0 || blockedAddresses.check(
        address,
        family === 4 ? 'ipv4' : 'ipv6'
    );
}

async function resolvePublicAddress(hostname) {
    const unwrappedHostname = hostname.replace(/^\[|\]$/g, '');
    const family = net.isIP(unwrappedHostname);

    if (family) {
        if (isBlockedAddress(unwrappedHostname)) {
            throw new Error('Ссылка должна вести на общедоступный адрес');
        }

        return { address: unwrappedHostname, family };
    }

    const addresses = await dns.lookup(unwrappedHostname, {
        all: true,
        verbatim: true
    });

    if (
        addresses.length === 0 ||
        addresses.some(({ address }) => isBlockedAddress(address))
    ) {
        throw new Error('Ссылка должна вести на общедоступный адрес');
    }

    return addresses[0];
}

function requestImage(url, pinnedAddress) {
    const transport = url.protocol === 'https:' ? https : http;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const isIpAddress = net.isIP(hostname) !== 0;

    return new Promise((resolve, reject) => {
        const request = transport.request(url, {
            method: 'GET',
            timeout: 15000,
            servername: isIpAddress ? undefined : hostname,
            lookup: (requestedHostname, options, callback) => {
                if (options && options.all) {
                    callback(null, [pinnedAddress]);
                } else {
                    callback(
                        null,
                        pinnedAddress.address,
                        pinnedAddress.family
                    );
                }
            }
        }, response => {
            const statusCode = response.statusCode || 0;

            if ([301, 302, 303, 307, 308].includes(statusCode)) {
                const location = response.headers.location;
                response.resume();

                if (!location) {
                    reject(new Error('Сервер вернул перенаправление без адреса'));
                    return;
                }

                resolve({ redirect: location });
                return;
            }

            if (statusCode !== 200) {
                response.resume();
                reject(new Error(`Не удалось загрузить изображение: HTTP ${statusCode}`));
                return;
            }

            const contentLength = Number(response.headers['content-length']);

            if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
                response.destroy();
                reject(new Error('Размер изображения не должен превышать 10 МБ'));
                return;
            }

            const chunks = [];
            let totalBytes = 0;

            response.on('data', chunk => {
                totalBytes += chunk.length;

                if (totalBytes > MAX_IMAGE_BYTES) {
                    response.destroy(
                        new Error('Размер изображения не должен превышать 10 МБ')
                    );
                    return;
                }

                chunks.push(chunk);
            });

            response.on('end', () => resolve({
                buffer: Buffer.concat(chunks),
                contentType: response.headers['content-type'] || ''
            }));
            response.on('error', reject);
        });

        request.on('timeout', () => {
            request.destroy(new Error('Истекло время ожидания загрузки изображения'));
        });
        request.on('error', reject);
        request.end();
    });
}

async function downloadImage(source) {
    let url;

    try {
        url = new URL(source);
    } catch {
        throw new Error('Укажите корректную ссылку на изображение');
    }

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
        if (
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password
        ) {
            throw new Error('Поддерживаются только общедоступные HTTP- и HTTPS-ссылки');
        }

        const pinnedAddress = await resolvePublicAddress(url.hostname);
        const result = await requestImage(url, pinnedAddress);

        if (result.buffer) {
            return result;
        }

        if (redirects === MAX_REDIRECTS) {
            throw new Error('Слишком много перенаправлений при загрузке изображения');
        }

        url = new URL(result.redirect, url);
    }

    throw new Error('Не удалось загрузить изображение');
}

module.exports = { downloadImage, MAX_IMAGE_BYTES };
