/*!
 * irocap.js — privacy-first Proof-of-Work CAPTCHA widget
 * MIT License. https://irocap.vercel.app
 */
(function () {
  'use strict';

  var DEFAULT_BASE = (function () {
    try {
      var scripts = document.getElementsByTagName('script');
      for (var i = scripts.length - 1; i >= 0; i--) {
        var s = scripts[i];
        if (s.src && /\/irocap\.js(\?|$)/.test(s.src)) {
          return s.src.replace(/\/irocap\.js(\?.*)?$/, '');
        }
      }
    } catch (e) { /* ignore */ }
    return 'https://irocap.vercel.app';
  })();

  function Irocap(sitekey, options) {
    if (!(this instanceof Irocap)) return new Irocap(sitekey, options);
    this.sitekey = sitekey;
    this.options = options || {};
    this.base = this.options.base || DEFAULT_BASE;
    this.widgetId = 'irocap-' + Math.random().toString(36).slice(2, 10);
    this.signals = {
      webdriver: false, touchSupport: false, mouseMovements: 0, keyPresses: 0,
      timeToInteract: 0, canvasHash: '', webglVendor: '', screenSize: '',
      colorDepth: 0, language: '', timezone: '', hardwareConcurrency: 0,
      method: 'wasm', solveMs: 0, pluginsCount: -1
    };
    this._startTime = Date.now();
    this._firstInteraction = 0;
    this._bindSignals();
    this._render();
    this._solve();
  }

  Irocap.prototype._bindSignals = function () {
    var self = this;
    this._events = [];
    this._maxEvents = 500;

    var push = function (ev) {
      if (self._events.length >= self._maxEvents) return;
      self._events.push(ev);
    };
    var bump = function () { if (!self._firstInteraction) self._firstInteraction = Date.now(); };

    try {
      window.addEventListener('mousemove', function (e) {
        push({ t: Math.round(performance.now()), x: e.clientX, y: e.clientY });
        self.signals.mouseMovements++;
        bump();
      }, { passive: true });
      window.addEventListener('touchmove', function (e) {
        var t = e.touches && e.touches[0];
        if (t) push({ t: Math.round(performance.now()), x: Math.round(t.clientX), y: Math.round(t.clientY) });
        bump();
      }, { passive: true });
      window.addEventListener('touchstart', function () { bump(); }, { passive: true });
      window.addEventListener('keydown', function (e) {
        if (e.key) push({ t: Math.round(performance.now()), k: e.key.length === 1 ? 'c' : e.key });
        self.signals.keyPresses++;
        bump();
      }, { passive: true });
      window.addEventListener('scroll', function () {
        push({ t: Math.round(performance.now()), s: Math.round(window.scrollY) });
      }, { passive: true });
    } catch (e) { /* ignore */ }

    try {
      this.signals.webdriver = !!navigator.webdriver;
      this.signals.touchSupport = 'ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0;
      this.signals.language = navigator.language || '';
      this.signals.hardwareConcurrency = navigator.hardwareConcurrency || 0;
      this.signals.pluginsCount = navigator.plugins ? navigator.plugins.length : -1;
      try { this.signals.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { this.signals.timezone = ''; }
      this.signals.screenSize = window.screen ? (window.screen.width + 'x' + window.screen.height) : '';
      this.signals.colorDepth = window.screen ? window.screen.colorDepth : 0;
    } catch (e) { /* ignore */ }

    try {
      var canvas = document.createElement('canvas');
      canvas.width = 200; canvas.height = 40;
      var ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.textBaseline = 'top'; ctx.font = '14px Arial';
        ctx.fillStyle = '#f60'; ctx.fillRect(0, 0, 200, 40);
        ctx.fillStyle = '#069'; ctx.fillText('irocap', 2, 8);
        var data = canvas.toDataURL();
        var h = 0;
        for (var i = 0; i < data.length; i++) { h = ((h << 5) - h + data.charCodeAt(i)) | 0; }
        this.signals.canvasHash = (h >>> 0).toString(16);
      }
    } catch (e) { /* ignore */ }

    try {
      var gl = document.createElement('canvas').getContext('webgl');
      if (gl) {
        var dbg = gl.getExtension('WEBGL_debug_renderer_info');
        if (dbg) this.signals.webglVendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || '';
      }
    } catch (e) { /* ignore */ }
  };

  Irocap.prototype._container = function () {
    var sel = this.options.container;
    if (!sel) return null;
    if (typeof sel === 'string') return document.querySelector(sel);
    if (sel instanceof Element) return sel;
    return null;
  };

  Irocap.prototype._render = function () {
    var c = this._container();
    if (!c) return;
    c.innerHTML = '';
    var badge = document.createElement('div');
    badge.id = this.widgetId;
    badge.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid #e2e8f0;border-radius:6px;background:#fff;color:#475569;font:13px/1.2 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;user-select:none';
    badge.innerHTML = '<span style="width:12px;height:12px;border:2px solid #cbd5e1;border-top-color:#475569;border-radius:50%;display:inline-block;animation:irocap-spin 0.7s linear infinite"></span><span class="irocap-text">Verifying…</span>';
    var style = document.createElement('style');
    style.textContent = '@keyframes irocap-spin{to{transform:rotate(360deg)}}';
    c.appendChild(style);
    c.appendChild(badge);
    this.badge = badge;
  };

  Irocap.prototype._setBadge = function (state, text) {
    if (!this.badge) return;
    var color = state === 'ok' ? '#16a34a' : state === 'err' ? '#dc2626' : '#475569';
    var icon = state === 'ok' ? '✓' : state === 'err' ? '✗' : '';
    this.badge.innerHTML = '<span style="color:' + color + ';font-weight:600">' + icon + '</span><span class="irocap-text" style="color:' + color + '">' + text + '</span>';
  };

  Irocap.prototype._fireCallback = function (name, a, b) {
    var fn = this.options[name];
    if (typeof fn === 'function') { try { fn(a, b); } catch (e) { /* swallow */ } }
  };

  Irocap.prototype._fail = function (err) {
    this._setBadge('err', 'Failed');
    this._fireCallback('error-callback', err);
  };

  Irocap.prototype._insertInput = function (token) {
    var c = this._container();
    var form = c ? c.closest('form') : null;
    if (!form) return;
    var existing = form.querySelector('input[name="irocap-token"]');
    if (existing) { existing.value = token; return; }
    var input = document.createElement('input');
    input.type = 'hidden'; input.name = 'irocap-token'; input.value = token;
    form.appendChild(input);
  };

  Irocap.prototype._workerSource = function () {
    return [
      'var hasher = null;',
      'var method = "js";',
      'try {',
      '  importScripts("/wasm/sha256.umd.min.js");',
      '  if (self.hashwasm && self.hashwasm.createSHA256) {',
      '    method = "wasm";',
      '  }',
      '} catch (e) { self.hashwasm = null; }',
      'function sha256hex(str){',
      '  function rr(v,n){return (v>>>n)|(v<<(32-n));}',
      '  var K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,',
      '         0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,',
      '         0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,',
      '         0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,',
      '         0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,',
      '         0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,',
      '         0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,',
      '         0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];',
      '  var l=str.length*8;',
      '  var bytes=[];',
      '  for(var i=0;i<str.length;i++){',
      '    var c=str.charCodeAt(i);',
      '    if(c<128)bytes.push(c);',
      '    else if(c<2048)bytes.push(192|(c>>6),128|(c&63));',
      '    else bytes.push(224|(c>>12),128|((c>>6)&63),128|(c&63));',
      '  }',
      '  bytes.push(0x80);',
      '  while(bytes.length%64!==56)bytes.push(0);',
      '  var hi=Math.floor(l/0x100000000);',
      '  var lo=l>>>0;',
      '  for(var j=3;j>=0;j--)bytes.push((hi>>>(j*8))&0xff);',
      '  for(var j=3;j>=0;j--)bytes.push((lo>>>(j*8))&0xff);',
      '  var H=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];',
      '  for(var off=0;off<bytes.length;off+=64){',
      '    var w=[];',
      '    for(var i=0;i<16;i++)w[i]=(bytes[off+i*4]<<24)|(bytes[off+i*4+1]<<16)|(bytes[off+i*4+2]<<8)|bytes[off+i*4+3];',
      '    for(var i=16;i<64;i++){',
      '      var s0=rr(w[i-15],7)^rr(w[i-15],18)^(w[i-15]>>>3);',
      '      var s1=rr(w[i-2],17)^rr(w[i-2],19)^(w[i-2]>>>10);',
      '      w[i]=(w[i-16]+s0+w[i-7]+s1)|0;',
      '    }',
      '    var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];',
      '    for(var i=0;i<64;i++){',
      '      var S1=rr(e,6)^rr(e,11)^rr(e,25);',
      '      var ch=(e&f)^(~e&g);',
      '      var t1=(h+S1+ch+K[i]+w[i])|0;',
      '      var S0=rr(a,2)^rr(a,13)^rr(a,22);',
      '      var maj=(a&b)^(a&c)^(b&c);',
      '      var t2=(S0+maj)|0;',
      '      h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;',
      '    }',
      '    H[0]=(H[0]+a)|0;H[1]=(H[1]+b)|0;H[2]=(H[2]+c)|0;H[3]=(H[3]+d)|0;',
      '    H[4]=(H[4]+e)|0;H[5]=(H[5]+f)|0;H[6]=(H[6]+g)|0;H[7]=(H[7]+h)|0;',
      '  }',
      '  var out="";',
      '  for(var i=0;i<8;i++)for(var j=3;j>=0;j--){',
      '    var b2=(H[i]>>>(j*8))&0xff;',
      '    out+=(b2<16?"0":"")+b2.toString(16);',
      '  }',
      '  return out;',
      '}',
      'self.onmessage = async function (e) {',
      '  try {',
      '    var d = e.data || {};',
      '    var challenge = d.challenge;',
      '    var difficulty = d.difficulty;',
      '    var prefix = "";',
      '    for (var i = 0; i < difficulty; i++) prefix += "0";',
      '    if (self.hashwasm && self.hashwasm.createSHA256) {',
      '      try {',
      '        hasher = await self.hashwasm.createSHA256();',
      '      } catch (err) {',
      '        hasher = null;',
      '        method = "js";',
      '      }',
      '    }',
      '    var start = Date.now();',
      '    var nonce = 0;',
      '    var batch = 20000;',
      '    function loop() {',
      '      for (var i = 0; i < batch; i++) {',
      '        var h;',
      '        if (hasher) {',
      '          hasher.init();',
      '          hasher.update(challenge + nonce);',
      '          h = hasher.digest("hex");',
      '        } else {',
      '          h = sha256hex(challenge + nonce);',
      '        }',
      '        if (h.indexOf(prefix) === 0) {',
      '          self.postMessage({',
      '            type: "solved",',
      '            nonce: nonce,',
      '            hash: h,',
      '            solveMs: Date.now() - start,',
      '            method: method',
      '          });',
      '          return;',
      '        }',
      '        nonce++;',
      '      }',
      '      self.postMessage({ type: "progress", nonce: nonce });',
      '      Promise.resolve().then(loop);',
      '    }',
      '    loop();',
      '  } catch (err) {',
      '    self.postMessage({ type: "error", error: String((err && err.message) || err) });',
      '  }',
      '};'
    ].join('\n');
  };

  Irocap.prototype._solve = async function () {
    var self = this;
    try {
      var res = await fetch(this.base + '/api/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sitekey: this.sitekey }),
        credentials: 'omit'
      });
      if (!res.ok) {
        var e = await res.json().catch(function () { return {}; });
        this._fail({ stage: 'challenge', status: res.status, error: e.error });
        return;
      }
      var data = await res.json();
      var challengeCtx = {
        challenge: data.challenge,
        difficulty: data.difficulty,
        issuedAt: data.issuedAt,
        sig: data.sig,
      };

      this._solveInWorker(challengeCtx.challenge, challengeCtx.difficulty)
        .then(function (sol) {
          self.signals.solveMs = sol.solveMs;
          return self._submit(challengeCtx, sol);
        })
        .catch(function (err) {
          console.warn('[irocap] worker path failed, falling back to WebCrypto:', err);
          self.signals.method = 'webcrypto';
          return self._solveWithWebCrypto(challengeCtx.challenge, challengeCtx.difficulty)
            .then(function (sol) {
              self.signals.solveMs = sol.solveMs;
              return self._submit(challengeCtx, sol);
            })
            .catch(function (err2) {
              self._fail({ stage: 'solve', error: String((err2 && err2.message) || err2) });
            });
        });
    } catch (err) {
      this._fail({ stage: 'network', error: String((err && err.message) || err) });
    }
  };

  Irocap.prototype._solveInWorker = function (challenge, difficulty) {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
        return reject(new Error('worker-unsupported'));
      }
      var blob, url, worker;
      try {
        blob = new Blob([self._workerSource()], { type: 'application/javascript' });
        url = URL.createObjectURL(blob);
        worker = new Worker(url);
      } catch (e) {
        try { if (url) URL.revokeObjectURL(url); } catch (_) {}
        return reject(new Error('worker-construct-failed: ' + (e && e.message)));
      }
      var cleanup = function () {
        try { worker.terminate(); } catch (_) {}
        try { URL.revokeObjectURL(url); } catch (_) {}
      };
      var done = false;
      var timeout = setTimeout(function () {
        if (done) return;
        done = true; cleanup();
        reject(new Error('worker-solve-timeout'));
      }, 120000);
      worker.onmessage = function (ev) {
        var m = ev.data || {};
        if (m.type === 'solved') {
          if (done) return;
          done = true; clearTimeout(timeout);
          self.signals.solveMs = m.solveMs;
          cleanup();
          resolve({ nonce: m.nonce, hash: m.hash, solveMs: m.solveMs });
        } else if (m.type === 'error') {
          if (done) return;
          done = true; clearTimeout(timeout); cleanup();
          reject(new Error(m.error || 'worker-error'));
        }
      };
      worker.onerror = function (ev) {
        if (done) return;
        done = true; clearTimeout(timeout); cleanup();
        reject(new Error((ev && ev.message) || 'worker-onerror'));
      };
      worker.postMessage({ challenge: challenge, difficulty: difficulty });
    });
  };

  Irocap.prototype._solveWithWebCrypto = async function (challenge, difficulty) {
    var cryptoObj = (typeof self !== 'undefined' && self.crypto) || (typeof window !== 'undefined' && window.crypto);
    if (!cryptoObj || !cryptoObj.subtle || typeof cryptoObj.subtle.digest !== 'function') {
      throw new Error('webcrypto-unavailable');
    }
    var enc = new TextEncoder();
    var prefix = '0'.repeat(difficulty);
    var start = Date.now();
    var nonce = 0;
    var challengeBytes = enc.encode(challenge);
    var challengeLen = challengeBytes.length;

    while (true) {
      for (var i = 0; i < 5000; i++) {
        var nonceBytes = enc.encode(String(nonce));
        var buf = new Uint8Array(challengeLen + nonceBytes.length);
        buf.set(challengeBytes, 0);
        buf.set(nonceBytes, challengeLen);

        var digest = await cryptoObj.subtle.digest('SHA-256', buf);
        var bytes = new Uint8Array(digest);

        var zerosSeen = 0;
        for (var bi = 0; bi < bytes.length && zerosSeen < difficulty; bi++) {
          var b = bytes[bi];
          if (b === 0) zerosSeen += 2;
          else if (b < 16) { zerosSeen += 1; break; }
          else break;
        }
        if (zerosSeen >= difficulty) {
          var hex = '';
          for (var j = 0; j < bytes.length; j++) {
            hex += (bytes[j] < 16 ? '0' : '') + bytes[j].toString(16);
          }
          if (hex.indexOf(prefix) === 0) {
            return { nonce: nonce, hash: hex, solveMs: Date.now() - start };
          }
        }
        nonce++;

        if ((nonce & 255) === 0 && Date.now() - start > 60000) {
          throw new Error('webcrypto-solve-timeout');
        }
      }
      await Promise.resolve();
    }
  };

  Irocap.prototype._submit = async function (ctx, solution) {
    var signals = Object.assign({}, this.signals);
    signals.solveMs = solution.solveMs;
    signals.timeToInteract = this._firstInteraction
      ? this._firstInteraction - this._startTime
      : Date.now() - this._startTime;
    signals.events = (this._events && this._events.length) ? this._events.slice(0, 500) : [];

    var res = await fetch(this.base + '/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challenge: ctx.challenge,
        issuedAt: ctx.issuedAt,
        sig: ctx.sig,
        nonce: solution.nonce,
        hash: solution.hash,
        signals: signals
      }),
      credentials: 'omit'
    });
    if (!res.ok) {
      var e = await res.json().catch(function () { return {}; });
      this._fail({ stage: 'verify', status: res.status, error: e.error });
      return;
    }
    var data = await res.json();
    this._setBadge('ok', 'Verified');
    this._insertInput(data.token);
    this._fireCallback('callback', data.token, data.score);
  };

  window.Irocap = Irocap;
})();
