import { WebSocket } from 'ws';
import bus from './bus.js';
import log from './logger.js';
import settings from './settings-loader.js';

/**
 * Minimal OBS WebSocket v5 Client
 * Keeps LilFokker in control of his scenes from Fokker Studio.
 */

class ObsClient {
  #ws = null;
  #address = 'ws://127.0.0.1:4455';
  #password = '';
  #connected = false;

  constructor() {
    this.#address = settings.obs?.address || 'ws://127.0.0.1:4455';
    this.#password = settings.obs?.password || '';
    
    bus.on('*', msg => {
      if (msg.type === 'obs.set-scene' && msg.scene) {
        this.setScene(msg.scene);
      }
    });
  }

  connect() {
    if (this.#ws) return;
    log.info(`Connecting to OBS at ${this.#address}...`);
    this.#ws = new WebSocket(this.#address);

    this.#ws.on('open', () => {
      log.info('OBS WebSocket connected (Waiting for Hello)');
    });

    this.#ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.op === 0) { // Hello
          this.#identify();
        } else if (msg.op === 2) { // Identified
          log.info('OBS Handshake successful');
          this.#connected = true;
        }
      } catch (err) {
        log.error('OBS Message error:', err.message);
      }
    });

    this.#ws.on('close', () => {
      this.#connected = false;
      this.#ws = null;
      log.warn('OBS disconnected, retrying in 10s...');
      setTimeout(() => this.connect(), 10000);
    });

    this.#ws.on('error', (err) => {
      log.debug('OBS connection failed (Is OBS running?)');
    });
  }

  #identify() {
    // Note: This is a minimal ID without password auth for now.
    // OBS v5 requires password auth if configured. 
    this.#ws.send(JSON.stringify({
      op: 1,
      d: { rpcVersion: 1 }
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
