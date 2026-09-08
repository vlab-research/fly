'use strict';

/*
 * The URL fetch behind upload_media: bounded, redirect-checked, and refusing
 * anything that resolves inside the cluster. node-fetch and dns are replaced
 * outright, so nothing here touches the network.
 */

const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();

function load({ addresses = {}, responses = [] } = {}) {
  const fetched = [];
  const queue = responses.slice();

  const fakeFetch = async (url, opts) => {
    fetched.push({ url, opts });
    const next = queue.shift();
    if (!next) throw new Error('no fake response queued');
    if (next.throws) throw next.throws;
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      headers: { get: name => (next.headers || {})[name.toLowerCase()] || null },
      async buffer() {
        if (next.tooBig) {
          const err = new Error('content size over limit');
          err.type = 'max-size';
          throw err;
        }
        return Buffer.from(next.body || '');
      },
    };
  };

  const fakeDns = {
    promises: {
      async lookup(hostname) {
        if (!(hostname in addresses)) throw new Error(`ENOTFOUND ${hostname}`);
        return { address: addresses[hostname], family: 4 };
      },
    },
  };

  const service = proxyquire('./media.service', {
    'node-fetch': fakeFetch,
    dns: fakeDns,
    'uuid/v4': () => 'id',
  });

  return { service, fetched };
}

describe('media.service fetchSource', () => {
  it('fetches a public URL with the byte cap and manual redirects', async () => {
    const { service, fetched } = load({
      addresses: { 'cdn.example.org': '93.184.216.34' },
      responses: [{ status: 200, body: 'bytes', headers: { 'content-type': 'image/png' } }],
    });

    const out = await service.fetchSource('https://cdn.example.org/x.png', { maxBytes: 1234 });

    expect(out.buffer.toString()).to.equal('bytes');
    expect(out.contentType).to.equal('image/png');
    expect(fetched[0].opts).to.include({ redirect: 'manual', size: 1234 });
  });

  it('follows a redirect, re-checking the new host, and reports the final URL', async () => {
    const { service, fetched } = load({
      addresses: { 'short.example.org': '93.184.216.34', 'cdn.example.org': '93.184.216.35' },
      responses: [
        { status: 302, headers: { location: 'https://cdn.example.org/real.png' } },
        { status: 200, body: 'ok' },
      ],
    });

    const out = await service.fetchSource('https://short.example.org/r');
    expect(fetched.map(f => f.url)).to.eql(['https://short.example.org/r', 'https://cdn.example.org/real.png']);
    expect(out.url).to.equal('https://cdn.example.org/real.png');
  });

  // The whole point of checking every hop: a Kubernetes service name looks
  // like any two-label host, so it is the resolved address that refuses it.
  it('refuses a redirect into the cluster', async () => {
    const { service, fetched } = load({
      addresses: { 'short.example.org': '93.184.216.34', 'alertmanager-operated.monitoring': '10.96.0.5' },
      responses: [{ status: 302, headers: { location: 'http://alertmanager-operated.monitoring:9093/' } }],
    });

    let err;
    await service.fetchSource('https://short.example.org/r').catch(e => { err = e; });
    expect(err.expected).to.equal(true);
    expect(err.message).to.match(/resolves to a private address/);
    expect(fetched).to.have.lengthOf(1);

    const byName = load({
      addresses: { 'short.example.org': '93.184.216.34' },
      responses: [{ status: 302, headers: { location: 'http://kubernetes.default.svc/' } }],
    });
    await byName.service.fetchSource('https://short.example.org/r').catch(e => { err = e; });
    expect(err.message).to.match(/not a public address/);
  });

  it('refuses a public name that resolves to a private address, before fetching', async () => {
    const { service, fetched } = load({ addresses: { 'evil.example.org': '10.0.0.7' } });

    let err;
    await service.fetchSource('https://evil.example.org/x').catch(e => { err = e; });
    expect(err.expected).to.equal(true);
    expect(err.message).to.match(/resolves to a private address/);
    expect(fetched).to.have.lengthOf(0);
  });

  it('turns an oversize body, a bad status and a dead host into expected failures', async () => {
    const big = load({ addresses: { 'cdn.example.org': '93.184.216.34' }, responses: [{ status: 200, tooBig: true }] });
    let err;
    await big.service.fetchSource('https://cdn.example.org/huge.mp4').catch(e => { err = e; });
    expect(err.expected).to.equal(true);
    expect(err.message).to.match(/larger than 100 MB/);

    const missing = load({ addresses: { 'cdn.example.org': '93.184.216.34' }, responses: [{ status: 404 }] });
    await missing.service.fetchSource('https://cdn.example.org/gone.png').catch(e => { err = e; });
    expect(err.message).to.match(/HTTP 404/);

    const dead = load({});
    await dead.service.fetchSource('https://nowhere.example.org/x').catch(e => { err = e; });
    expect(err.message).to.match(/does not resolve/);
  });

  it('gives up after too many redirects', async () => {
    const hop = { status: 301, headers: { location: 'https://cdn.example.org/again' } };
    const { service } = load({ addresses: { 'cdn.example.org': '93.184.216.34' }, responses: [hop, hop, hop, hop, hop] });
    let err;
    await service.fetchSource('https://cdn.example.org/start').catch(e => { err = e; });
    expect(err.message).to.match(/redirected more than 3 times/);
  });
});
