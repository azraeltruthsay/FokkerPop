import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { createHash } from 'node:crypto';
import bus from './bus.js';
import log from './logger.js';
import settings from './settings-loader.js';

/**
 * Minimal OBS WebSocket v5 Client
 * Handles authentication and scene switching for Fokker Studio.
 */

class ObsClient extends EventEmitter {
  #ws = null;
  #address = 'ws://127.0.0.1:4455';
  #password = '';
  #connected = false;
  #status = 'disconnected';
  #streaming = false;
  #lastError = '';

  constructor() {
    super();
    this.#address = settings.obs?.address || 'ws://127.0.0.1:4455';
    this.#password = settings.obs?.password || '';
    
    bus.on('*', msg => {
      if (msg.type === 'obs.set-scene' && msg.scene) {
        this.setScene(msg.scene);
      }
    });
  }

  get status()    { return this.#status; }
  get streaming() { return this.#streaming; }
  get lastError() { return this.#lastError; }

  #setStreaming(v) {
    v = !!v;
    if (this.#streaming === v) return;
    this.#streaming = v;
    this.emit('streaming', v);
  }

  #setStatus(s, reason = '') {
    const reasonChanged = reason !== this.#lastError;
    this.#lastError = reason;
    if (this.#status === s && !reasonChanged) return;
    this.#status = s;
    this.emit('status', s, this.#lastError);
  }

  connect() {
    if (this.#ws) return;
    this.#address = settings.obs?.address || 'ws://127.0.0.1:4455';
    this.#password = settings.obs?.password || '';
    
    this.#setStatus('connecting');
    this.#ws = new WebSocket(this.#address);

    this.#ws.on('open', () => {
      log.info(`OBS WebSocket connected to ${this.#address} (Waiting for Hello)`);
    });

    this.#ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.op === 0) { // Hello
          this.#identify(msg.d);
        } else if (msg.op === 2) { // Identified
          log.info('OBS Handshake successful');
          this.#connected = true;
          this.#setStatus('connected', '');  // clears any prior error reason
          this.#requestStreamStatus();
        } else if (msg.op === 5) { // Event
          this.#handleEvent(msg.d);
        } else if (msg.op === 7) { // RequestResponse
          this.#handleRequestResponse(msg.d);
        }
      } catch (err) {
        log.error('OBS Message error:', err.message);
      }
    });

    this.#ws.on('close', (code) => {
      if (this.#connected) log.warn(`OBS connection closed (code ${code}), retrying in 10s...`);
      this.#connected = false;
      this.#ws = null;
      // v5 close codes: 4009 = auth failure (wrong password).
      let reason = this.#lastError;
      if (code === 4009) {
        reason = 'OBS rejected the password. Copy the value from OBS → Tools → WebSocket Server Settings → Show Connect Info into the Setup tab.';
      }
      this.#setStatus('disconnected', reason);
      this.#setStreaming(false);
      setTimeout(() => this.connect(), 10000);
    });

    this.#ws.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        this.#setStatus('disconnected', 'OBS is not running (or its WebSocket Server is disabled). Open OBS → Tools → WebSocket Server Settings and enable it.');
        return;
      }
      log.debug('OBS WebSocket error:', err.message);
      this.#setStatus('error', `OBS WebSocket error: ${err.message}`);
    });
  }

  #identify(helloData) {
    const identify = {
      op: 1,
      // General (1) | Scenes (4) | Outputs (64) — Outputs gives us StreamStateChanged
      d: { rpcVersion: 1, eventSubscriptions: 1 | 4 | 64 }
    };

    // Handle Authentication if required
    if (helloData.authentication) {
      if (!this.#password) {
        const msg = 'OBS requires a password, but none is set in FokkerPop. Open the Setup tab → OBS, paste the password from OBS → Tools → WebSocket Server Settings, and click Save & Connect.';
        log.warn(msg);
        this.#setStatus('error', msg);
        return;
      }
      const { salt, challenge } = helloData.authentication;
      
      const passHash = createHash('sha256').update(this.#password + salt).digest('base64');
      const authResp = createHash('sha256').update(passHash + challenge).digest('base64');
      
      identify.d.authentication = authResp;
    }

    this.#ws.send(JSON.stringify(identify));
  }

  reconnect() {
    this.disconnect();
    this.connect();
  }

  disconnect() {
    if (this.#ws) {
      this.#ws.removeAllListeners();
      this.#ws.terminate();
      this.#ws = null;
    }
    this.#connected = false;
    this.#setStatus('disconnected');
  }

  #handleEvent(d) {
    if (d?.eventType === 'StreamStateChanged') {
      // outputActive is true while OBS is actively sending a stream.
      this.#setStreaming(!!d.eventData?.outputActive);
    }
  }

  #handleRequestResponse(d) {
    if (d?.requestType === 'GetStreamStatus' && d.responseData) {
      this.#setStreaming(!!d.responseData.outputActive);
    }
  }

  #requestStreamStatus() {
    if (!this.#ws || this.#ws.readyState !== 1) return;
    this.#ws.send(JSON.stringify({
      op: 6,
      d: { requestType: 'GetStreamStatus', requestId: 'stream-status-' + Date.now() }
    }));
  }

  setScene(sceneName) {
    if (!this.#connected) {
      log.warn(`Cannot change to scene "${sceneName}" — OBS not connected.`);
      return;
    }
    log.info(`Telling OBS to switch to scene: ${sceneName}`);
    this.#ws.send(JSON.stringify({
      op: 6, // Request
      d: {
        requestType: 'SetCurrentProgramScene',
        requestId: 'studio-' + Date.now(),
        requestData: { sceneName }
      }
    }));
  }
}

const client = new ObsClient();
export default client;
