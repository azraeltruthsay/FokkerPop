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

  get status() { return this.#status; }

  #setStatus(s) {
    if (this.#status === s) return;
    this.#status = s;
    this.emit('status', s);
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
          this.#setStatus('connected');
        }
      } catch (err) {
        log.error('OBS Message error:', err.message);
      }
    });

    this.#ws.on('close', (code) => {
      if (this.#connected) log.warn(`OBS connection closed (code ${code}), retrying in 10s...`);
      this.#connected = false;
      this.#ws = null;
      this.#setStatus('disconnected');
      setTimeout(() => this.connect(), 10000);
    });

    this.#ws.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        // Quietly wait for OBS to be opened
        this.#setStatus('disconnected');
        return;
      }
      log.debug('OBS WebSocket error:', err.message);
      this.#setStatus('error');
    });
  }

  #identify(helloData) {
    const identify = {
      op: 1,
      d: { rpcVersion: 1 }
    };

    // Handle Authentication if required
    if (helloData.authentication) {
      if (!this.#password) {
        log.warn('OBS requires a password, but none is set in FokkerPop settings. Please go to OBS -> Tools -> WebSocket Server Settings.');
        this.#setStatus('error');
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
    if (this.#ws) {
      this.#ws.removeAllListeners();
      this.#ws.terminate();
      this.#ws = null;
    }
    this.#connected = false;
    this.#setStatus('disconnected');
    this.connect();
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
